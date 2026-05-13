"""
pricebet PyCardano scenario.

A single PlutusV3 spend validator settles an oracle-resolved price bet.
The on-chain logic consults a *reference-input* oracle UTxO at an always-true
PlutusV3 address — the oracle UTxO is identified by its script hash, baked
into the bet's datum.

Scenarios:
  Flow 1 — setup-oracle → create → join → win
  Flow 2 — create → wait → timeout

The oracle UTxO is reused across flow 1's bet (Win path). For flow 2 we
deliberately set a short deadline so the chain tip passes it; the owner then
reclaims the pot via the Timeout redeemer.

Run against a local yaci-devkit instance:
    python pricebet.py
"""

import json
import os
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Optional, Union

import requests as http_requests

from pycardano import (
    Address,
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    Network,
    PlutusData,
    PlutusV3Script,
    Redeemer,
    TransactionBuilder,
    TransactionInput,
    TransactionOutput,
    TransactionId,
    UTxO,
    plutus_script_hash,
)
from pycardano.backend.blockfrost import ALONZO_COINS_PER_UTXO_WORD
from pycardano.backend.base import ProtocolParameters
from pycardano.plutus import ExecutionUnits

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

YACI_BASE = "http://localhost:8080/api"
os.environ.setdefault("BLOCKFROST_API_VERSION", "v1")

NETWORK = Network.TESTNET
TEST_MNEMONIC = (
    "test test test test test test test test test test test test "
    "test test test test test test test test test test test sauce"
)
BLUEPRINT_PATH = (
    Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json"
)

# Always-true PlutusV3 script (single-CBOR — pycardano wraps once on
# serialization, so the witness layer matches the ledger's double-CBOR shape).
ALWAYS_TRUE_SCRIPT = PlutusV3Script(bytes.fromhex("450101002499"))


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions
# ---------------------------------------------------------------------------


# PriceBetDatum: Constr 0 with 6 fields in declaration order.
# `player: Option<VerificationKeyHash>` ⇒ Constr 0 (Some bytes) | Constr 1 (None).
@dataclass
class SomePlayer(PlutusData):
    CONSTR_ID = 0
    player: bytes


@dataclass
class NoPlayer(PlutusData):
    CONSTR_ID = 1


@dataclass
class PriceBetDatum(PlutusData):
    CONSTR_ID = 0
    owner: bytes
    player: Union[SomePlayer, NoPlayer]
    oracle_vkh: bytes   # oracle script hash
    target_rate: int
    deadline: int       # POSIX ms
    bet_amount: int


# PriceBetRedeemer: Join | Win | Timeout → Constr 0, 1, 2.
@dataclass
class Join(PlutusData):
    CONSTR_ID = 0


@dataclass
class Win(PlutusData):
    CONSTR_ID = 1


@dataclass
class Timeout(PlutusData):
    CONSTR_ID = 2


# OracleDatum:
#   OracleDatum { price_data: PriceData }  → outer Constr 0 with one field
#   PriceData = SharedData | ExtendedData | GenericData { price_map }
#     → Constr 0 (SharedData), 1 (ExtendedData), 2 (GenericData) with PriceMap = Pairs<Int,Int>.
# We use GenericData (Constr 2) with the map (price, timestamp, expiry) keyed 0/1/2.
@dataclass
class GenericData(PlutusData):
    CONSTR_ID = 2
    price_map: Dict[int, int]


@dataclass
class OracleDatum(PlutusData):
    CONSTR_ID = 0
    price_data: GenericData


# ---------------------------------------------------------------------------
# Yaci-devkit-compatible chain context
# ---------------------------------------------------------------------------


class YaciChainContext(BlockFrostChainContext):
    @property
    def protocol_param(self) -> ProtocolParameters:
        if not self._protocol_param or self._check_epoch_and_update():
            params = self.api.epoch_latest_parameters()
            self._protocol_param = ProtocolParameters(
                min_fee_constant=int(params.min_fee_b),
                min_fee_coefficient=int(params.min_fee_a),
                max_block_size=int(params.max_block_size),
                max_tx_size=int(params.max_tx_size),
                max_block_header_size=int(params.max_block_header_size),
                key_deposit=int(params.key_deposit),
                pool_deposit=int(params.pool_deposit),
                pool_influence=Fraction(params.a0),
                monetary_expansion=Fraction(params.rho),
                treasury_expansion=Fraction(params.tau),
                decentralization_param=Fraction(
                    getattr(params, "decentralisation_param", "0")
                ),
                extra_entropy=getattr(params, "extra_entropy", None),
                protocol_major_version=int(params.protocol_major_ver),
                protocol_minor_version=int(params.protocol_minor_ver),
                min_utxo=int(getattr(params, "min_utxo", 0) or 0),
                min_pool_cost=int(params.min_pool_cost),
                price_mem=Fraction(params.price_mem),
                price_step=Fraction(params.price_step),
                max_tx_ex_mem=int(params.max_tx_ex_mem),
                max_tx_ex_steps=int(params.max_tx_ex_steps),
                max_block_ex_mem=int(params.max_block_ex_mem),
                max_block_ex_steps=int(params.max_block_ex_steps),
                max_val_size=int(params.max_val_size),
                collateral_percent=int(params.collateral_percent),
                max_collateral_inputs=int(params.max_collateral_inputs),
                coins_per_utxo_word=int(
                    getattr(params, "coins_per_utxo_word", 0) or 0
                ) or ALONZO_COINS_PER_UTXO_WORD,
                coins_per_utxo_byte=int(params.coins_per_utxo_size),
                cost_models={
                    k: v.to_dict()
                    for k, v in params.cost_models.to_dict().items()
                },
                maximum_reference_scripts_size={"bytes": 200000},
                min_fee_reference_scripts={
                    "base": params.min_fee_ref_script_cost_per_byte,
                    "range": 200000,
                    "multiplier": 1,
                },
            )
        return self._protocol_param

    def evaluate_tx_cbor(self, cbor: Union[bytes, str]) -> Dict[str, ExecutionUnits]:
        if isinstance(cbor, bytes):
            cbor = cbor.hex()
        url = f"{self.api.url}/utils/txs/evaluate"
        headers = {**self.api.default_headers, "Content-Type": "application/cbor"}
        resp = http_requests.post(url, headers=headers, data=cbor)
        if resp.status_code not in (200, 202):
            raise Exception(
                f"evaluate_tx failed: HTTP {resp.status_code} — {resp.text[:400]}"
            )
        body = resp.json()
        result = body.get("result", {})
        eval_result = result.get("EvaluationResult", {})
        return_val: Dict[str, ExecutionUnits] = {}
        for k, v in eval_result.items():
            return_val[k] = ExecutionUnits(
                int(v.get("memory", 0)),
                int(v.get("steps", 0)),
            )
        return return_val

    def submit_tx_cbor(self, cbor: Union[bytes, str]) -> str:
        if isinstance(cbor, str):
            cbor = bytes.fromhex(cbor)
        url = f"{self.api.url}/tx/submit"
        headers = {**self.api.default_headers, "Content-Type": "application/cbor"}
        resp = http_requests.post(url, headers=headers, data=cbor)
        if resp.status_code not in (200, 202):
            raise Exception(
                f"Transaction submit failed: HTTP {resp.status_code} — {resp.text}"
            )
        return resp.text.strip('"')


def make_context() -> YaciChainContext:
    return YaciChainContext(project_id="Dummy Key", base_url=YACI_BASE)


def wallet_at(account_index: int) -> tuple[ExtendedSigningKey, Address]:
    hd = HDWallet.from_mnemonic(TEST_MNEMONIC)
    payment_hd = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/0/0")
    stake_hd = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/2/0")
    psk = ExtendedSigningKey.from_hdwallet(payment_hd)
    ssk = ExtendedSigningKey.from_hdwallet(stake_hd)
    return psk, Address(
        payment_part=psk.to_verification_key().hash(),
        staking_part=ssk.to_verification_key().hash(),
        network=NETWORK,
    )


def wallet_from_mnemonic(mnemonic: str) -> tuple[ExtendedSigningKey, Address]:
    hd = HDWallet.from_mnemonic(mnemonic)
    payment_hd = hd.derive_from_path("m/1852'/1815'/0'/0/0")
    stake_hd = hd.derive_from_path("m/1852'/1815'/0'/2/0")
    psk = ExtendedSigningKey.from_hdwallet(payment_hd)
    ssk = ExtendedSigningKey.from_hdwallet(stake_hd)
    return psk, Address(
        payment_part=psk.to_verification_key().hash(),
        staking_part=ssk.to_verification_key().hash(),
        network=NETWORK,
    )


def load_compiled_code(title: str) -> bytes:
    blueprint = json.loads(BLUEPRINT_PATH.read_text())
    v = next(x for x in blueprint["validators"] if x["title"] == title)
    return bytes.fromhex(v["compiledCode"])


def script_address(script: PlutusV3Script) -> Address:
    return Address(payment_part=plutus_script_hash(script), network=NETWORK)


def wait_for_utxos(
    ctx: BlockFrostChainContext,
    address: Address,
    min_count: int = 1,
    timeout_s: int = 90,
) -> list[UTxO]:
    for _ in range(timeout_s):
        try:
            utxos = ctx.utxos(str(address))
            if len(utxos) >= min_count:
                return utxos
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError(f"≥{min_count} UTxO(s) at {address} within {timeout_s}s")


def submit_and_confirm(
    ctx: YaciChainContext,
    tx,
    watch_address: Address,
    label: str,
    timeout_s: int = 90,
) -> str:
    tx_cbor = tx.to_cbor()
    tx_id = str(ctx.submit_tx_cbor(tx_cbor))
    print(f"  Submitted {label}: tx={tx_id}")
    for _ in range(timeout_s):
        try:
            utxos = ctx.utxos(str(watch_address))
            for u in utxos:
                if str(u.input.transaction_id) == tx_id:
                    return tx_id
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError(f"TX {tx_id} not confirmed at {watch_address} within {timeout_s}s")


def set_tight_validity(ctx: YaciChainContext, builder: TransactionBuilder) -> None:
    tip = ctx.last_block_slot
    builder.validity_start = max(0, tip - 5)
    builder.ttl = tip + 60


def slot_config() -> tuple[int, int]:
    b = http_requests.get(f"{YACI_BASE}/v1/blocks/latest", timeout=10).json()
    zero_time_ms = (b["time"] - b["slot"]) * 1000
    return zero_time_ms, 1000


def slot_to_ms(slot: int, cfg: tuple[int, int]) -> int:
    z, sl = cfg
    return z + slot * sl


def ms_to_slot(ms: int, cfg: tuple[int, int]) -> int:
    z, sl = cfg
    return (ms - z) // sl


# ---------------------------------------------------------------------------
# Scenario steps
# ---------------------------------------------------------------------------


def fund(ctx: YaciChainContext, target: Address, lovelace: int, label: str) -> None:
    skey, addr = wallet_at(0)
    print(f"Funding {target} with {lovelace} lovelace ({label}) ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.add_output(TransactionOutput(target, lovelace))
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, target, f"FUND_{label}")


def setup_oracle(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    price: int,
    validity_window_ms: int,
) -> tuple[bytes, Address, str]:
    """Publish an oracle UTxO at the always-true address with an inline OracleDatum.
    Returns (oracle_script_hash, oracle_address, oracle_tx_id)."""
    oracle_addr = script_address(ALWAYS_TRUE_SCRIPT)
    oracle_hash = plutus_script_hash(ALWAYS_TRUE_SCRIPT)
    print(f"SETUP_ORACLE at {oracle_addr} price={price} ...")

    now_ms = int(time.time() * 1000)
    expiry_ms = now_ms + validity_window_ms
    oracle_datum = OracleDatum(
        price_data=GenericData(price_map={0: price, 1: now_ms, 2: expiry_ms})
    )

    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(
        TransactionOutput(oracle_addr, 2_000_000, datum=oracle_datum)
    )
    tx = builder.build_and_sign(signing_keys=[owner_skey], change_address=owner_addr)
    tx_id = submit_and_confirm(ctx, tx, oracle_addr, "SETUP_ORACLE")
    return oracle_hash.payload, oracle_addr, tx_id


def find_oracle_utxo(
    ctx: YaciChainContext, oracle_addr: Address, oracle_tx_id: str
) -> UTxO:
    utxos = wait_for_utxos(ctx, oracle_addr)
    for u in utxos:
        if str(u.input.transaction_id) == oracle_tx_id:
            return u
    raise RuntimeError(f"Oracle UTxO {oracle_tx_id} not found at {oracle_addr}")


def create_bet(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    s_addr: Address,
    oracle_hash: bytes,
    target_rate: int,
    deadline_ms: int,
    bet_amount: int,
) -> tuple[str, PriceBetDatum]:
    """Lock the owner's stake at the script with the initial datum."""
    print(f"CREATE bet — owner locks {bet_amount} lovelace, target={target_rate}, "
          f"deadline_ms={deadline_ms} ...")
    owner_vkh = bytes(owner_addr.payment_part)
    datum = PriceBetDatum(
        owner=owner_vkh,
        player=NoPlayer(),
        oracle_vkh=oracle_hash,
        target_rate=target_rate,
        deadline=deadline_ms,
        bet_amount=bet_amount,
    )
    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(TransactionOutput(s_addr, bet_amount, datum=datum))
    tx = builder.build_and_sign(signing_keys=[owner_skey], change_address=owner_addr)
    tx_id = submit_and_confirm(ctx, tx, s_addr, "CREATE")
    return tx_id, datum


def find_bet_utxo(ctx: YaciChainContext, s_addr: Address, prev_tx_id: str) -> UTxO:
    utxos = wait_for_utxos(ctx, s_addr)
    for u in utxos:
        if str(u.input.transaction_id) == prev_tx_id:
            return u
    raise RuntimeError(f"Bet UTxO {prev_tx_id} not found at {s_addr}")


def join_bet(
    ctx: YaciChainContext,
    player_skey: ExtendedSigningKey,
    player_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    create_tx_id: str,
    prev_datum: PriceBetDatum,
    cfg: tuple[int, int],
) -> tuple[str, PriceBetDatum]:
    """Player matches the owner's stake. New datum: player = Some(player_vkh)."""
    print(f"JOIN — player matches stake ...")
    target = find_bet_utxo(ctx, s_addr, create_tx_id)
    player_vkh = bytes(player_addr.payment_part)
    new_datum = PriceBetDatum(
        owner=prev_datum.owner,
        player=SomePlayer(player=player_vkh),
        oracle_vkh=prev_datum.oracle_vkh,
        target_rate=prev_datum.target_rate,
        deadline=prev_datum.deadline,
        bet_amount=prev_datum.bet_amount,
    )
    new_pot = 2 * prev_datum.bet_amount

    deadline_slot = ms_to_slot(prev_datum.deadline, cfg)
    tip = ctx.last_block_slot
    # validity upper bound must be <= deadline_slot. We also need to leave
    # margin; use min(tip+60, deadline_slot - 1).
    valid_to = min(tip + 60, deadline_slot - 1)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Join()),
    )
    builder.add_input_address(player_addr)
    builder.add_output(TransactionOutput(s_addr, new_pot, datum=new_datum))
    builder.required_signers = [player_addr.payment_part]
    builder.validity_start = max(0, tip - 5)
    builder.ttl = valid_to
    tx = builder.build_and_sign(signing_keys=[player_skey], change_address=player_addr)
    tx_id = submit_and_confirm(ctx, tx, s_addr, "JOIN")
    return tx_id, new_datum


def win_bet(
    ctx: YaciChainContext,
    player_skey: ExtendedSigningKey,
    player_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    join_tx_id: str,
    join_datum: PriceBetDatum,
    oracle_utxo: UTxO,
    cfg: tuple[int, int],
) -> str:
    """Player claims the pot. Oracle UTxO is included as a reference input;
    payout goes to player's enterprise address."""
    print(f"WIN — player claims pot ...")
    target = find_bet_utxo(ctx, s_addr, join_tx_id)
    pot = int(target.output.amount.coin)

    deadline_slot = ms_to_slot(join_datum.deadline, cfg)
    tip = ctx.last_block_slot
    valid_to = min(tip + 60, deadline_slot - 1)

    player_enterprise = Address(
        payment_part=player_addr.payment_part, network=NETWORK
    )

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Win()),
    )
    builder.reference_inputs.add(oracle_utxo)
    builder.add_input_address(player_addr)
    builder.add_output(TransactionOutput(player_enterprise, pot))
    builder.required_signers = [player_addr.payment_part]
    builder.validity_start = max(0, tip - 5)
    builder.ttl = valid_to
    tx = builder.build_and_sign(signing_keys=[player_skey], change_address=player_addr)
    return submit_and_confirm(ctx, tx, player_enterprise, "WIN")


def timeout_bet(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    create_tx_id: str,
    create_datum: PriceBetDatum,
    cfg: tuple[int, int],
) -> str:
    """Owner reclaims after the deadline. validity lower-bound > deadline_slot."""
    print(f"TIMEOUT — owner reclaims pot ...")
    target = find_bet_utxo(ctx, s_addr, create_tx_id)
    pot = int(target.output.amount.coin)

    deadline_slot = ms_to_slot(create_datum.deadline, cfg)
    # Wait until the chain tip passes the deadline.
    for i in range(600):
        tip = ctx.last_block_slot
        if tip > deadline_slot:
            print(f"  tip={tip} > deadline_slot={deadline_slot}, proceeding")
            break
        if i % 10 == 0:
            print(f"  tip={tip}, waiting for {deadline_slot} ...")
        time.sleep(1)

    tip = ctx.last_block_slot
    validity_start = max(deadline_slot + 1, tip - 5)
    owner_enterprise = Address(
        payment_part=owner_addr.payment_part, network=NETWORK
    )

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Timeout()),
    )
    builder.add_input_address(owner_addr)
    builder.add_output(TransactionOutput(owner_enterprise, pot))
    builder.required_signers = [owner_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 120
    tx = builder.build_and_sign(signing_keys=[owner_skey], change_address=owner_addr)
    return submit_and_confirm(ctx, tx, owner_enterprise, "TIMEOUT")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== pricebet scenario: setup-oracle → create → join → win ; create → timeout ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Two fresh wallets — owner & player. Funded from the shared mnemonic.
    owner_mnemonic = HDWallet.generate_mnemonic(strength=256)
    player_mnemonic = HDWallet.generate_mnemonic(strength=256)
    owner_skey, owner_addr = wallet_from_mnemonic(owner_mnemonic)
    player_skey, player_addr = wallet_from_mnemonic(player_mnemonic)
    print(f"owner : {owner_addr}")
    print(f"player: {player_addr}")

    fund(ctx, owner_addr, 50_000_000, "owner")
    fund(ctx, player_addr, 30_000_000, "player")

    compiled = load_compiled_code("bet.bet.spend")
    script = PlutusV3Script(compiled)
    s_addr = script_address(script)
    print(f"PriceBet script address: {s_addr}")

    cfg = slot_config()

    # Publish an oracle UTxO valid for 24h with price=100.
    oracle_hash, oracle_addr, oracle_tx_id = setup_oracle(
        ctx, owner_skey, owner_addr,
        price=100, validity_window_ms=24 * 60 * 60 * 1000,
    )
    oracle_utxo = find_oracle_utxo(ctx, oracle_addr, oracle_tx_id)

    # --- Flow 1: create → join → win (price=100 ≥ target=50) ---
    tip = ctx.last_block_slot
    deadline1_ms = slot_to_ms(tip + 120, cfg)
    create_tx_1, create_datum_1 = create_bet(
        ctx, owner_skey, owner_addr, s_addr, oracle_hash,
        target_rate=50, deadline_ms=deadline1_ms, bet_amount=5_000_000,
    )
    join_tx, join_datum = join_bet(
        ctx, player_skey, player_addr, script, s_addr,
        create_tx_1, create_datum_1, cfg,
    )
    win_bet(
        ctx, player_skey, player_addr, script, s_addr,
        join_tx, join_datum, oracle_utxo, cfg,
    )

    # --- Flow 2: create → wait → timeout (short deadline) ---
    tip = ctx.last_block_slot
    deadline2_ms = slot_to_ms(tip + 15, cfg)
    create_tx_2, create_datum_2 = create_bet(
        ctx, owner_skey, owner_addr, s_addr, oracle_hash,
        target_rate=50, deadline_ms=deadline2_ms, bet_amount=5_000_000,
    )
    timeout_bet(
        ctx, owner_skey, owner_addr, script, s_addr,
        create_tx_2, create_datum_2, cfg,
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

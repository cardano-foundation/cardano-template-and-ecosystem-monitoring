"""
bet PyCardano scenario.

A single PlutusV3 validator handles both the policy (CREATE/INIT) and the
spend (JOIN and ANNOUNCE_WINNER) of a two-player oracle-resolved bet.
The minted token is the bet's identity — it stays with the script UTxO
until the oracle settles and pays the winner.

Lifecycle:
  1. Fund three fresh wallets: player1, player2, oracle.
  2. INIT (mint+lock): player1 mints 1 bet token under the validator's own
     policy, locks it at the script with stake + datum naming player1/oracle/
     expiration and player2 == "" (sentinel for "no opponent yet").
  3. JOIN (spend+continue): player2 spends the script UTxO, doubles the
     lovelace pot, re-emits the UTxO with player2 filled in.
  4. Wait until the chain tip passes the expiration slot.
  5. ANNOUNCE_WINNER (spend): oracle picks a winner (we let player1 win) and
     settles — the pot is sent to the winner's enterprise address as a
     single-output transaction with no continuing datum.

Run against a local yaci-devkit instance:
    python bet.py
"""

import json
import os
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, Union

import requests as http_requests

from pycardano import (
    Address,
    AssetName,
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    MultiAsset,
    Network,
    PlutusData,
    PlutusV3Script,
    Redeemer,
    ScriptHash,
    TransactionBuilder,
    TransactionOutput,
    UTxO,
    Value,
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
# PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
# blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
BLUEPRINT_PATH = Path(
    os.environ.get(
        "PLUTUS_JSON",
        Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json",
    )
)

ASSET_NAME = b"LuckyNumberSlevin"
INITIAL_STAKE = 10_000_000  # 10 ADA each side; total pot = 20 ADA


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions
# ---------------------------------------------------------------------------


@dataclass
class BetDatum(PlutusData):
    """Constr 0; fields in declaration order (player1, player2, oracle, expiration)."""

    CONSTR_ID = 0
    player1: bytes
    player2: bytes  # sentinel b"" while not yet joined
    oracle: bytes
    expiration: int  # POSIX milliseconds


@dataclass
class MintRedeemer(PlutusData):
    """CREATE uses a `_redeemer: Data` field — any constructor works.
    We pass Constr 0 with no fields for symmetry with the meshjs reference."""

    CONSTR_ID = 0


@dataclass
class Join(PlutusData):
    """First constructor of `Action` → Constr 0."""

    CONSTR_ID = 0


@dataclass
class AnnounceWinner(PlutusData):
    """Second constructor of `Action` → Constr 1; one field (the winner VKH)."""

    CONSTR_ID = 1
    winner: bytes


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
            # yaci-devkit's evaluate endpoint mis-evaluates certain Plutus V3
            # transactions that the LEDGER itself accepts at submit time.
            # Fallback: return generous static exec units across plausible tags
            # so the build can complete; the submit-side validation is what
            # actually matters for correctness.
            print(f"  [evaluate fallback] yaci eval rejected — using static budgets")
            return {
                "spend:0": ExecutionUnits(10_000_000, 5_000_000_000),
                "spend:1": ExecutionUnits(10_000_000, 5_000_000_000),
                "mint:0": ExecutionUnits(10_000_000, 5_000_000_000),
            }
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
    # Bypass pycardano's `ctx.last_block_slot` (it pre-fetches before tx-build
    # can take 5–10 min on yaci-devkit). Read tip directly via HTTP.
    tip = http_requests.get(f"{YACI_BASE}/v1/blocks/latest", timeout=10).json()["slot"]
    builder.validity_start = max(0, tip - 5)
    builder.ttl = tip + 60


# ---------------------------------------------------------------------------
# Slot/time helpers
# ---------------------------------------------------------------------------


def slot_config() -> tuple[int, int]:
    """Return (zero_time_ms, slot_length_ms) for yaci-devkit.

    +600s era offset: yaci-devkit's ledger views POSIXTime against a Byron-era
    system start that is one epoch (600 s) AFTER what /blocks/latest reports.
    Validators like bet's `valid_before(range, expiration_ms)` compare the
    ledger's POSIXTime range against our datum's expiration_ms, so we must
    use the same frame here.
    """
    b = http_requests.get(f"{YACI_BASE}/v1/blocks/latest", timeout=10).json()
    zero_time_ms = (b["time"] - b["slot"] + 600) * 1000
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


def init_bet(
    ctx: YaciChainContext,
    player1_skey: ExtendedSigningKey,
    player1_addr: Address,
    oracle_vkh: bytes,
    script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
    stake_lovelace: int,
    cfg: tuple[int, int],
) -> tuple[str, BetDatum, int]:
    """INIT: mint 1 bet token under the validator's own policy and lock it at
    the script with player1's stake. Datum names player1/oracle/expiration.

    Expiration is computed fresh from the current tip (validator wants
    `valid_before(range, expiration)`; we pick tip + 120 so the validity
    range `tip - 5 .. tip + 60` lands strictly before it). Returns the
    expiration slot too, so the caller can wait past it before ANNOUNCE.
    """
    # Read tip from yaci directly (avoid any pycardano caching/refresh quirks).
    tip = http_requests.get(f"{YACI_BASE}/v1/blocks/latest", timeout=10).json()["slot"]
    expiration_slot = tip + 120
    expiration_ms = slot_to_ms(expiration_slot, cfg)
    print(f"INIT bet — player1 locks {stake_lovelace} lovelace at {s_addr} "
          f"(tip={tip}, expiration slot={expiration_slot}) ...")
    player1_vkh = bytes(player1_addr.payment_part)
    datum = BetDatum(
        player1=player1_vkh,
        player2=b"",
        oracle=oracle_vkh,
        expiration=expiration_ms,
    )
    mint_ma = MultiAsset.from_primitive({policy_id.payload: {ASSET_NAME: 1}})

    builder = TransactionBuilder(ctx)
    builder.add_input_address(player1_addr)
    builder.mint = mint_ma
    builder.add_minting_script(script, redeemer=Redeemer(MintRedeemer()))
    builder.add_output(
        TransactionOutput(
            s_addr,
            Value(stake_lovelace, mint_ma),
            datum=datum,
        )
    )
    # Validator requires player1's signature in extra_signatories.
    builder.required_signers = [player1_addr.payment_part]
    import time as _t
    t_pre = _t.time()
    set_tight_validity(ctx, builder)
    t_after_valid = _t.time()
    print(f"  set_tight_validity took {t_after_valid - t_pre:.2f}s; validity=[{builder.validity_start},{builder.ttl}]")
    tx = builder.build_and_sign(signing_keys=[player1_skey], change_address=player1_addr)
    t_after_build = _t.time()
    print(f"  build_and_sign took {t_after_build - t_after_valid:.2f}s")
    init_tx_id = submit_and_confirm(ctx, tx, s_addr, "INIT")
    return init_tx_id, datum, expiration_slot


def join_bet(
    ctx: YaciChainContext,
    player2_skey: ExtendedSigningKey,
    player2_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    init_tx_id: str,
    init_datum: BetDatum,
) -> tuple[str, BetDatum]:
    """JOIN: player2 spends the bet UTxO, doubles the pot, re-emits the
    script UTxO with player2 filled in. Validator requires player2's sig
    and that the new pot is exactly 2× the input pot."""
    print(f"JOIN — player2 matches stake at {s_addr} ...")
    utxos = wait_for_utxos(ctx, s_addr)
    target = next((u for u in utxos if str(u.input.transaction_id) == init_tx_id), None)
    if target is None:
        raise RuntimeError(f"INIT UTxO {init_tx_id} not found at {s_addr}")

    # Re-use the init datum (Python-side state) to copy fields verbatim.
    new_datum = BetDatum(
        player1=init_datum.player1,
        player2=bytes(player2_addr.payment_part),
        oracle=init_datum.oracle,
        expiration=init_datum.expiration,
    )

    in_lovelace = int(target.output.amount.coin)
    new_lovelace = 2 * in_lovelace
    # Carry the bet token forward (identity).
    new_ma = target.output.amount.multi_asset

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,  # inline datum on UTxO
        redeemer=Redeemer(Join()),
    )
    builder.add_input_address(player2_addr)
    builder.add_output(
        TransactionOutput(s_addr, Value(new_lovelace, new_ma), datum=new_datum)
    )
    builder.required_signers = [player2_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[player2_skey], change_address=player2_addr)
    join_tx_id = submit_and_confirm(ctx, tx, s_addr, "JOIN")
    return join_tx_id, new_datum


def wait_until_slot(ctx: YaciChainContext, target_slot: int) -> None:
    print(f"Waiting for tip to pass slot {target_slot} ...")
    for i in range(600):
        tip = ctx.last_block_slot
        if tip > target_slot:
            print(f"  tip={tip} > target={target_slot}, proceeding")
            return
        if i % 10 == 0:
            print(f"  tip={tip}, waiting for {target_slot} ...")
        time.sleep(1)
    raise TimeoutError(f"Chain did not reach slot {target_slot}")


def announce_winner(
    ctx: YaciChainContext,
    oracle_skey: ExtendedSigningKey,
    oracle_addr: Address,
    winner_skey: ExtendedSigningKey,
    winner_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    join_tx_id: str,
    expiration_slot: int,
) -> str:
    """ANNOUNCE: oracle settles the bet after expiration. Exactly one output
    addressed to `from_verification_key(winner)` (enterprise — payment-only).

    The validator requires `list.length(outputs) == 1`, so the only way to
    avoid a change output is to have the WINNER pay the fee — that way the
    change can be merged into the same enterprise winner output. The oracle
    just signs (extra_signatories check) without contributing inputs.
    """
    print(f"ANNOUNCE — oracle settles, paying out to {winner_addr} ...")
    utxos = wait_for_utxos(ctx, s_addr)
    target = next((u for u in utxos if str(u.input.transaction_id) == join_tx_id), None)
    if target is None:
        raise RuntimeError(f"JOIN UTxO {join_tx_id} not found at {s_addr}")

    # Validator: `valid_after(validity_range, expiration)` ⇒ lower_bound > expiration_slot.
    tip = ctx.last_block_slot
    validity_start = max(expiration_slot + 1, tip - 5)

    # Enterprise winner address — must match `from_verification_key(winner)`
    # exactly (no stake credential).
    winner_enterprise = Address(
        payment_part=winner_addr.payment_part, network=NETWORK
    )

    pot_lovelace = int(target.output.amount.coin)
    pot_ma = target.output.amount.multi_asset

    # Pre-pick a pure-ADA UTxO from winner for collateral.
    winner_utxos = ctx.utxos(str(winner_addr))
    collateral_utxo = next(
        (u for u in winner_utxos if not u.output.amount.multi_asset
         and int(u.output.amount.coin) >= 5_000_000),
        None,
    )
    if collateral_utxo is None:
        raise RuntimeError("No pure-ADA collateral UTxO at winner address")

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(AnnounceWinner(winner=bytes(winner_addr.payment_part))),
    )
    # Winner funds the tx (so their change can merge into the single output).
    builder.add_input_address(winner_addr)
    builder.collaterals = [collateral_utxo]
    # Oracle must appear in `extra_signatories`.
    builder.required_signers = [oracle_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 120

    # Explicit single output: pot + bet token + winner's leftover ADA, all to
    # winner_enterprise. `merge_change=True` folds any auto-added change at
    # the same address into this output instead of producing a 2nd one.
    builder.add_output(
        TransactionOutput(winner_enterprise, Value(pot_lovelace, pot_ma))
    )
    tx = builder.build_and_sign(
        signing_keys=[oracle_skey, winner_skey],
        change_address=winner_enterprise,
        merge_change=True,
    )
    print(f"  TX has {len(tx.transaction_body.outputs)} output(s):")
    for i, o in enumerate(tx.transaction_body.outputs):
        ma_summary = ""
        if hasattr(o.amount, "multi_asset") and o.amount.multi_asset:
            ma_summary = f" + {sum(len(a) for a in o.amount.multi_asset.values())} asset(s)"
        print(f"    out[{i}] addr={str(o.address)[:50]}... coin={o.amount.coin}{ma_summary}")
    return submit_and_confirm(ctx, tx, winner_enterprise, "ANNOUNCE")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== bet scenario: init → join → wait → announce-winner ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Three fresh wallets (player1, player2, oracle) — on-chain checks require
    # player1 != player2, player2 != oracle, oracle != player1.
    p1_mnemonic = HDWallet.generate_mnemonic(strength=256)
    p2_mnemonic = HDWallet.generate_mnemonic(strength=256)
    o_mnemonic = HDWallet.generate_mnemonic(strength=256)
    p1_skey, p1_addr = wallet_from_mnemonic(p1_mnemonic)
    p2_skey, p2_addr = wallet_from_mnemonic(p2_mnemonic)
    o_skey, o_addr = wallet_from_mnemonic(o_mnemonic)
    print(f"player1: {p1_addr}")
    print(f"player2: {p2_addr}")
    print(f"oracle : {o_addr}")

    fund(ctx, p1_addr, 30_000_000, "player1")
    fund(ctx, p2_addr, 30_000_000, "player2")
    fund(ctx, o_addr, 15_000_000, "oracle")

    compiled = load_compiled_code("bet.bet.mint")
    script = PlutusV3Script(compiled)
    policy_id = plutus_script_hash(script)
    s_addr = script_address(script)
    print(f"Bet script address: {s_addr}")
    print(f"Policy id        : {policy_id.payload.hex()}")

    cfg = slot_config()

    # init_bet computes its own expiration based on the tip RIGHT at INIT
    # build time — yaci-devkit can advance hundreds of slots during funding,
    # so a pre-computed expiration tends to be already past by the time
    # the INIT tx evaluates.
    init_tx, init_datum, expiration_slot = init_bet(
        ctx, p1_skey, p1_addr,
        bytes(o_addr.payment_part), script, s_addr, policy_id,
        stake_lovelace=INITIAL_STAKE, cfg=cfg,
    )

    join_tx, _join_datum = join_bet(
        ctx, p2_skey, p2_addr, script, s_addr, init_tx, init_datum,
    )

    wait_until_slot(ctx, expiration_slot)

    # Oracle declares player1 the winner.
    announce_winner(
        ctx, o_skey, o_addr, p1_skey, p1_addr, script, s_addr, join_tx, expiration_slot,
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

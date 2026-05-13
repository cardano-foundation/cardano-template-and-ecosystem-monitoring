"""
lottery PyCardano scenario.

Two validators:

  lottery_creator.lottery_creator.mint  — parameterised by `_game_index: Int`.
      Mint:  both players must sign and a LOTTERY_TOKEN must be minted (qty=1)
             into an output that already carries a fully populated LotteryDatum.
      Burn:  open path (the lottery spend script enforces who/when).

  lottery.lottery.spend  — parameterised by `(policy_id: PolicyId, _game_index: Int)`.
      Reveal1 (0) — P1 publishes n1; hash(n1) == commit1; state UTxO continues.
      Reveal2 (1) — P2 publishes n2; only AFTER P1 has revealed; state UTxO continues.
      Timeout1 (2) — P1 never revealed; P2 takes the pot and the token is burned.
      Timeout2 (3) — P2 never revealed; P1 takes the pot and the token is burned.
      Settle  (4) — both revealed; winner = parity of (n1+n2), token burned.

Scenario (happy path): create → reveal1 → reveal2 → settle.

Run against a local yaci-devkit instance:
    python lottery.py
"""

import hashlib
import json
import os
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, Optional, Union

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

from uplc.ast import PlutusByteString, PlutusInteger
from uplc.tools import apply as uplc_apply
from uplc.tools import flatten as uplc_flatten
from uplc.tools import unflatten as uplc_unflatten

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

TOKEN_NAME = b"LOTTERY_TOKEN"
GAME_INDEX = 19
# Both players' secrets are UTF-8 digit strings; the validator parses them
# via `int.from_utf8`. SECRET1+SECRET2 = 3+4 = 7 (odd) → player1 wins.
SECRET1 = b"3"
SECRET2 = b"4"
# end_reveal must be far in the future so Reveal1/Reveal2 aren't blocked by
# any time check (the validator's time gate only applies to Timeout1/Timeout2).
END_REVEAL_MS = 9_999_999_999_999
DELTA_MS = 20
BET_LOVELACE = 10_000_000


# ---------------------------------------------------------------------------
# Datum / Redeemer
# ---------------------------------------------------------------------------


@dataclass
class LotteryDatum(PlutusData):
    """Mirrors lottery.LotteryDatum exactly — field order matters."""

    CONSTR_ID = 0
    player1: bytes
    player2: bytes
    commit1: bytes
    commit2: bytes
    n1: bytes
    n2: bytes
    end_reveal: int
    delta: int


@dataclass
class Reveal1(PlutusData):
    """LotteryRedeemer::Reveal1 { n1 } — Constr 0."""

    CONSTR_ID = 0
    n1: bytes


@dataclass
class Reveal2(PlutusData):
    """LotteryRedeemer::Reveal2 { n2 } — Constr 1."""

    CONSTR_ID = 1
    n2: bytes


@dataclass
class Timeout1(PlutusData):
    CONSTR_ID = 2


@dataclass
class Timeout2(PlutusData):
    CONSTR_ID = 3


@dataclass
class Settle(PlutusData):
    CONSTR_ID = 4


# Lottery-creator mint redeemers
@dataclass
class Mint(PlutusData):
    CONSTR_ID = 0


@dataclass
class Burn(PlutusData):
    CONSTR_ID = 1


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


def apply_creator_params(compiled_code: bytes, game_index: int) -> PlutusV3Script:
    """Apply (_game_index)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusInteger(game_index))
    return PlutusV3Script(uplc_flatten(program))


def apply_lottery_params(
    compiled_code: bytes, policy_id_bytes: bytes, game_index: int
) -> PlutusV3Script:
    """Apply (policy_id: PolicyId, _game_index: Int)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(policy_id_bytes))
    program = uplc_apply(program, PlutusInteger(game_index))
    return PlutusV3Script(uplc_flatten(program))


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
    raise TimeoutError(
        f"TX {tx_id} not confirmed at {watch_address} within {timeout_s}s"
    )


def set_tight_validity(ctx: YaciChainContext, builder: TransactionBuilder) -> None:
    tip = ctx.last_block_slot
    builder.validity_start = max(0, tip - 5)
    builder.ttl = tip + 60


# ---------------------------------------------------------------------------
# Scenario steps
# ---------------------------------------------------------------------------


def fund(ctx: YaciChainContext, target: Address, lovelace: int) -> None:
    skey, addr = wallet_at(0)
    print(f"Funding {target} with {lovelace} lovelace ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.add_output(TransactionOutput(target, lovelace))
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, target, "FUND")


def find_state_utxo(
    ctx: YaciChainContext,
    s_addr: Address,
    policy_id: ScriptHash,
    prev_tx_id: Optional[str] = None,
) -> UTxO:
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    if prev_tx_id is not None:
        for u in utxos:
            if str(u.input.transaction_id) == prev_tx_id:
                return u
        raise RuntimeError(f"UTxO from tx {prev_tx_id} not found at {s_addr}")
    for u in utxos:
        ma = u.output.amount.multi_asset
        if ma and any(sh.payload == policy_id.payload for sh in ma):
            return u
    raise RuntimeError(f"Token-bearing UTxO not found at {s_addr}")


def read_datum(utxo: UTxO) -> LotteryDatum:
    """Parse the inline LotteryDatum from a UTxO. pycardano can hand the inline
    datum back as RawCBOR (has `cbor` bytes), RawPlutusData / PlutusData (have
    `to_cbor()`)."""
    d = utxo.output.datum
    if d is None:
        raise RuntimeError("UTxO has no datum")
    if hasattr(d, "cbor"):
        cbor = d.cbor
    elif hasattr(d, "to_cbor"):
        cbor = d.to_cbor()
    else:
        cbor = bytes(d)
    return LotteryDatum.from_cbor(cbor)


def create_game(
    ctx: YaciChainContext,
    coord_skey: ExtendedSigningKey,
    coord_addr: Address,
    p1_skey: ExtendedSigningKey,
    p1_addr: Address,
    p2_skey: ExtendedSigningKey,
    p2_addr: Address,
    creator_script: PlutusV3Script,
    policy_id: ScriptHash,
    lottery_addr: Address,
) -> str:
    """Mint LOTTERY_TOKEN and lock it at the lottery script with the datum."""
    print("CREATE — both players co-sign, coordinator submits ...")
    p1_vkh = bytes(p1_addr.payment_part)
    p2_vkh = bytes(p2_addr.payment_part)

    commit1 = hashlib.blake2b(SECRET1, digest_size=32).digest()
    commit2 = hashlib.blake2b(SECRET2, digest_size=32).digest()
    datum = LotteryDatum(
        player1=p1_vkh,
        player2=p2_vkh,
        commit1=commit1,
        commit2=commit2,
        n1=b"",
        n2=b"",
        end_reveal=END_REVEAL_MS,
        delta=DELTA_MS,
    )

    mint_ma = MultiAsset.from_primitive({policy_id.payload: {TOKEN_NAME: 1}})

    builder = TransactionBuilder(ctx)
    builder.add_input_address(coord_addr)
    builder.mint = mint_ma
    builder.add_minting_script(creator_script, redeemer=Redeemer(Mint()))
    builder.add_output(
        TransactionOutput(
            lottery_addr,
            Value(BET_LOVELACE, mint_ma),
            datum=datum,
        )
    )
    builder.required_signers = [
        coord_addr.payment_part,
        p1_addr.payment_part,
        p2_addr.payment_part,
    ]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[coord_skey, p1_skey, p2_skey],
        change_address=coord_addr,
    )
    return submit_and_confirm(ctx, tx, lottery_addr, "CREATE")


def reveal(
    ctx: YaciChainContext,
    player_skey: ExtendedSigningKey,
    player_addr: Address,
    player_idx: int,
    secret: bytes,
    lottery_script: PlutusV3Script,
    lottery_addr: Address,
    policy_id: ScriptHash,
    prev_tx_id: str,
) -> str:
    """Reveal step — spend state UTxO and re-emit with n1 or n2 set."""
    print(f"REVEAL{player_idx} — player {player_addr.payment_part}... ")
    target = find_state_utxo(ctx, lottery_addr, policy_id, prev_tx_id)
    current = read_datum(target)

    if player_idx == 1:
        new_datum = LotteryDatum(
            player1=current.player1,
            player2=current.player2,
            commit1=current.commit1,
            commit2=current.commit2,
            n1=secret,
            n2=current.n2,
            end_reveal=current.end_reveal,
            delta=current.delta,
        )
        redeemer = Reveal1(n1=secret)
    elif player_idx == 2:
        new_datum = LotteryDatum(
            player1=current.player1,
            player2=current.player2,
            commit1=current.commit1,
            commit2=current.commit2,
            n1=current.n1,
            n2=secret,
            end_reveal=current.end_reveal,
            delta=current.delta,
        )
        redeemer = Reveal2(n2=secret)
    else:
        raise ValueError("player_idx must be 1 or 2")

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=lottery_script,
        datum=None,
        redeemer=Redeemer(redeemer),
    )
    builder.add_input_address(player_addr)
    # Continue the state UTxO carrying the lottery token + datum unchanged value.
    builder.add_output(
        TransactionOutput(lottery_addr, target.output.amount, datum=new_datum)
    )
    builder.required_signers = [player_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[player_skey], change_address=player_addr
    )
    return submit_and_confirm(ctx, tx, lottery_addr, f"REVEAL{player_idx}")


def settle(
    ctx: YaciChainContext,
    p1_skey: ExtendedSigningKey,
    p1_addr: Address,
    p2_skey: ExtendedSigningKey,
    p2_addr: Address,
    lottery_script: PlutusV3Script,
    lottery_addr: Address,
    creator_script: PlutusV3Script,
    policy_id: ScriptHash,
    prev_tx_id: str,
) -> None:
    """Settle — burn the token, pay the bet to the winner."""
    target = find_state_utxo(ctx, lottery_addr, policy_id, prev_tx_id)
    current = read_datum(target)
    n1 = int(current.n1.decode("utf-8"))
    n2 = int(current.n2.decode("utf-8"))
    winner_vkh = current.player1 if (n1 + n2) % 2 == 1 else current.player2
    print(f"SETTLE — n1={n1}, n2={n2}, winner_vkh={winner_vkh.hex()[:12]}... ")

    p1_vkh = bytes(p1_addr.payment_part)
    if winner_vkh == p1_vkh:
        winner_skey, winner_addr = p1_skey, p1_addr
    else:
        winner_skey, winner_addr = p2_skey, p2_addr
    print(f"  Winner is player{'1' if winner_vkh == p1_vkh else '2'}: {winner_addr}")

    burn_ma = MultiAsset.from_primitive({policy_id.payload: {TOKEN_NAME: -1}})

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=lottery_script,
        datum=None,
        redeemer=Redeemer(Settle()),
    )
    builder.add_input_address(winner_addr)
    builder.mint = burn_ma
    builder.add_minting_script(creator_script, redeemer=Redeemer(Burn()))
    # Send the bet payout to the winner; the lottery token is destroyed by the
    # burn so doesn't reappear anywhere.
    builder.add_output(TransactionOutput(winner_addr, BET_LOVELACE))
    builder.required_signers = [winner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[winner_skey], change_address=winner_addr
    )
    submit_and_confirm(ctx, tx, winner_addr, "SETTLE")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== lottery scenario: create → reveal1 → reveal2 → settle ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Fresh wallets for coordinator + both players.
    coord_skey, coord_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    p1_skey, p1_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    p2_skey, p2_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    print(f"Coordinator: {coord_addr}")
    print(f"Player1    : {p1_addr}")
    print(f"Player2    : {p2_addr}")

    fund(ctx, coord_addr, 30_000_000)
    fund(ctx, p1_addr, 30_000_000)
    fund(ctx, p2_addr, 30_000_000)

    # Build both scripts.
    creator_compiled = load_compiled_code("lottery_creator.lottery_creator.mint")
    creator_script = apply_creator_params(creator_compiled, GAME_INDEX)
    policy_id = plutus_script_hash(creator_script)
    print(f"Creator policy id   : {policy_id.payload.hex()}")

    lottery_compiled = load_compiled_code("lottery.lottery.spend")
    lottery_script = apply_lottery_params(
        lottery_compiled, policy_id.payload, GAME_INDEX
    )
    lottery_addr = script_address(lottery_script)
    print(f"Lottery script address: {lottery_addr}")

    # --- Step 1: create game ---
    create_tx = create_game(
        ctx,
        coord_skey, coord_addr,
        p1_skey, p1_addr,
        p2_skey, p2_addr,
        creator_script, policy_id, lottery_addr,
    )

    # --- Step 2: P1 reveals SECRET1 ---
    reveal1_tx = reveal(
        ctx, p1_skey, p1_addr, 1, SECRET1,
        lottery_script, lottery_addr, policy_id, create_tx,
    )

    # --- Step 3: P2 reveals SECRET2 ---
    reveal2_tx = reveal(
        ctx, p2_skey, p2_addr, 2, SECRET2,
        lottery_script, lottery_addr, policy_id, reveal1_tx,
    )

    # --- Step 4: Settle (parity of 3+4 = 7 is odd → P1 wins) ---
    settle(
        ctx,
        p1_skey, p1_addr,
        p2_skey, p2_addr,
        lottery_script, lottery_addr,
        creator_script, policy_id,
        reveal2_tx,
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

"""
vault PyCardano scenario.

A time-locked vault validator parameterised by (owner_vkh, wait_time_ms).
Three redeemers:
  WITHDRAW (0)  — owner schedules / re-schedules a withdrawal. Continuing
                  outputs carrying an InlineDatum WithdrawDatum{lock_time}
                  must have lock_time already in the past (valid_after).
                  Total lovelace returning to the script must match the
                  spent UTxO's lovelace (conservation).
  FINALIZE (1)  — owner takes the funds once tx.validity_start >
                  lock_time + waitTime. No continuing output required.
  CANCEL   (2)  — owner aborts a scheduled withdrawal: funds stay in the
                  script (conservation) but as a datum-less UTxO so the
                  next WITHDRAW must restart the clock.

Scenario:
  Fund a fresh wallet from account 0, then exercise:
    LOCK (datum-less) → WITHDRAW (schedule) → FINALIZE (after cool-down).
  Then on a second locked UTxO:
    LOCK (datum-less) → WITHDRAW (schedule) → CANCEL (revert to datum-less).

Run against a local yaci-devkit instance:
    python vault.py
"""

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
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    Network,
    PlutusData,
    PlutusV3Script,
    Redeemer,
    TransactionBuilder,
    TransactionOutput,
    UTxO,
    plutus_script_hash,
)
from pycardano.backend.blockfrost import ALONZO_COINS_PER_UTXO_WORD
from pycardano.backend.base import ProtocolParameters
from pycardano.plutus import ExecutionUnits

# UPLC parameter application
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
# PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
# blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
BLUEPRINT_PATH = Path(
    os.environ.get(
        "PLUTUS_JSON",
        Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json",
    )
)

# Short cool-down so we don't have to wait minutes for FINALIZE.
WAIT_TIME_MS = 10_000


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions
# ---------------------------------------------------------------------------


@dataclass
class WithdrawDatum(PlutusData):
    CONSTR_ID = 0
    lock_time: int


@dataclass
class Withdraw(PlutusData):
    """Action::WITHDRAW — Constr 0."""

    CONSTR_ID = 0


@dataclass
class Finalize(PlutusData):
    """Action::FINALIZE — Constr 1."""

    CONSTR_ID = 1


@dataclass
class Cancel(PlutusData):
    """Action::CANCEL — Constr 2."""

    CONSTR_ID = 2


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


def apply_vault_params(
    compiled_code: bytes, owner_vkh: bytes, wait_time_ms: int
) -> PlutusV3Script:
    """Apply (owner: VerificationKeyHash, waitTime: Int)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    program = uplc_apply(program, PlutusInteger(wait_time_ms))
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
# Slot / time helpers
# ---------------------------------------------------------------------------


def slot_config() -> tuple[int, int]:
    """Return (zero_time_ms, slot_length_ms) for yaci-devkit."""
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


def fund(ctx: YaciChainContext, target: Address, lovelace: int) -> None:
    skey, addr = wallet_at(0)
    print(f"Funding {target} with {lovelace} lovelace ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.add_output(TransactionOutput(target, lovelace))
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, target, "FUND")


def lock(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    s_addr: Address,
    lovelace: int,
    label: str,
) -> str:
    """
    Initial lock: deposit lovelace at the script with NO datum, mimicking the
    'datum-less / clock-not-started' baseline state used by the mesh scenario.
    """
    print(f"LOCK (no datum) {lovelace} lovelace at {s_addr} ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(TransactionOutput(s_addr, lovelace))
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, s_addr, label)


def find_script_utxo(
    ctx: YaciChainContext, s_addr: Address, prev_tx_id: str
) -> UTxO:
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    for u in utxos:
        if str(u.input.transaction_id) == prev_tx_id:
            return u
    raise RuntimeError(f"UTxO from tx {prev_tx_id} not found at {s_addr}")


def withdraw(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    cfg: tuple[int, int],
) -> str:
    """
    WITHDRAW — schedule the cool-down. Spend the locked UTxO and re-emit a
    UTxO of equal lovelace at the script with an inline WithdrawDatum whose
    lock_time is in the past relative to the tx validity range.
    """
    print(f"WITHDRAW — scheduling cool-down on UTxO from {prev_tx_id[:12]}... ")
    target = find_script_utxo(ctx, s_addr, prev_tx_id)

    tip = ctx.last_block_slot
    validity_start = max(0, tip - 5)
    # lock_time must be < validity_start in ms — push it well before the
    # validity window so valid_after(range, lock_time) succeeds.
    lock_time_ms = slot_to_ms(validity_start, cfg) - 5_000
    new_datum = WithdrawDatum(lock_time=lock_time_ms)
    print(f"  lock_time_ms = {lock_time_ms}; tip_slot = {tip}")

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,  # input was datum-less (or inline) — pycardano handles both
        redeemer=Redeemer(Withdraw()),
    )
    builder.add_input_address(owner_addr)
    builder.add_output(
        TransactionOutput(s_addr, target.output.amount, datum=new_datum)
    )
    builder.required_signers = [owner_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = tip + 60
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, s_addr, "WITHDRAW")


def finalize(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    cfg: tuple[int, int],
) -> None:
    """
    FINALIZE — collect the funds once tip > lock_time + waitTime.

    The validator's check is `valid_after(range, lock_time + waitTime)`,
    i.e. validity_start must be strictly greater than that boundary.
    """
    print(f"FINALIZE — collecting UTxO from {prev_tx_id[:12]}... ")
    target = find_script_utxo(ctx, s_addr, prev_tx_id)

    # Read lock_time from inline datum. pycardano hands the inline datum back
    # as a RawPlutusData / PlutusData; both expose `to_cbor()` for re-parsing
    # into a typed dataclass.
    datum = target.output.datum
    if datum is None:
        raise RuntimeError("Expected an inline datum on the WITHDRAW UTxO")
    # The datum can come back as RawCBOR (has `cbor` bytes), RawPlutusData
    # (has `to_cbor()`), or a PlutusData subclass.
    if hasattr(datum, "cbor"):
        datum_cbor = datum.cbor
    elif hasattr(datum, "to_cbor"):
        datum_cbor = datum.to_cbor()
    else:
        datum_cbor = bytes(datum)
    parsed = WithdrawDatum.from_cbor(datum_cbor)
    lock_time_ms = parsed.lock_time
    finalize_after_ms = lock_time_ms + WAIT_TIME_MS
    finalize_after_slot = ms_to_slot(finalize_after_ms, cfg)
    print(
        f"  lock_time_ms={lock_time_ms}, finalize_after_ms={finalize_after_ms}, "
        f"finalize_after_slot={finalize_after_slot}"
    )

    # Wait until tip > finalize_after_slot
    for _ in range(300):
        tip = ctx.last_block_slot
        if tip > finalize_after_slot:
            break
        time.sleep(1)
    tip = ctx.last_block_slot
    validity_start = max(finalize_after_slot + 1, tip - 5)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Finalize()),
    )
    builder.add_input_address(owner_addr)
    builder.required_signers = [owner_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 60
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    submit_and_confirm(ctx, tx, owner_addr, "FINALIZE")


def cancel(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
) -> str:
    """
    CANCEL — abort the WITHDRAW schedule. Funds stay in the vault as a
    datum-less UTxO (the validator requires conservation; the off-chain
    convention is to also strip the datum to restart the clock).
    """
    print(f"CANCEL — reverting schedule on UTxO from {prev_tx_id[:12]}... ")
    target = find_script_utxo(ctx, s_addr, prev_tx_id)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Cancel()),
    )
    builder.add_input_address(owner_addr)
    # Continuing output WITHOUT datum (resets the timer).
    builder.add_output(TransactionOutput(s_addr, target.output.amount))
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, s_addr, "CANCEL")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print(
        "=== vault scenario: lock×2 → withdraw → finalize ; withdraw → cancel ==="
    )
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    fresh_mnemonic = HDWallet.generate_mnemonic(strength=256)
    owner_skey, owner_addr = wallet_from_mnemonic(fresh_mnemonic)
    print(f"Fresh owner wallet: {owner_addr}")

    fund(ctx, owner_addr, lovelace=60_000_000)

    owner_vkh = bytes(owner_addr.payment_part)
    compiled = load_compiled_code("vault.vault.spend")
    script = apply_vault_params(compiled, owner_vkh, WAIT_TIME_MS)
    s_addr = script_address(script)
    print(f"Vault script address: {s_addr}")

    cfg = slot_config()
    print(f"Slot config: zero_time_ms={cfg[0]}, slot_length_ms={cfg[1]}")

    # --- Branch A: lock → withdraw → finalize (collect the funds) ---
    print("\n--- Branch A: lock → withdraw → finalize ---")
    lock_tx_a = lock(ctx, owner_skey, owner_addr, s_addr, 10_000_000, "LOCK_A")
    withdraw_tx_a = withdraw(
        ctx, owner_skey, owner_addr, script, s_addr, lock_tx_a, cfg
    )
    finalize(ctx, owner_skey, owner_addr, script, s_addr, withdraw_tx_a, cfg)

    # --- Branch B: lock → withdraw → cancel (revert to datum-less) ---
    print("\n--- Branch B: lock → withdraw → cancel ---")
    lock_tx_b = lock(ctx, owner_skey, owner_addr, s_addr, 8_000_000, "LOCK_B")
    withdraw_tx_b = withdraw(
        ctx, owner_skey, owner_addr, script, s_addr, lock_tx_b, cfg
    )
    cancel(ctx, owner_skey, owner_addr, script, s_addr, withdraw_tx_b)

    print("\n=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

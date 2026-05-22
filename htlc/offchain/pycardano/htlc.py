"""
HTLC (Hash Time-Lock Contract) PyCardano scenario.

Demonstrates two HTLC spending paths:
  1. GUESS  — claimer (account 1) reveals the correct preimage to claim UTxO 1.
  2. WITHDRAW — owner (account 0) refunds UTxO 2 after its short expiration passes.

The validator has three parameters (baked in at lock time):
  secret      — sha256 hash of the preimage (ByteArray)
  expiration  — POSIX milliseconds timestamp (Int)
  owner       — owner's 28-byte verification key hash (ByteArray)

Each set of parameters produces a distinct script address, so UTxO 1 and UTxO 2
live at different addresses.

Accounts use the shared 24-word test mnemonic; account 0 = owner/funder,
account 1 = claimer.

Run against a local yaci-devkit instance:
    python htlc.py
"""

import hashlib
import json
import os
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, Union

import requests as http_requests

# PyCardano core
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

# UPLC parameter application (no apply_params_to_script in pycardano 0.19.2)
from uplc.ast import PlutusByteString, PlutusInteger
from uplc.tools import apply as uplc_apply
from uplc.tools import flatten as uplc_flatten
from uplc.tools import unflatten as uplc_unflatten

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# yaci-devkit exposes a Blockfrost-compatible API at /api/v1.
# The blockfrost-python client appends DEFAULT_API_VERSION ('v0') to base_url,
# so we split the path: base_url='http://localhost:8080/api', version='v1'.
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


# ---------------------------------------------------------------------------
# Redeemer definitions
# ---------------------------------------------------------------------------


@dataclass
class Guess(PlutusData):
    """GUESS redeemer — Constr index 0, one field: answer (preimage bytes)."""

    CONSTR_ID = 0
    answer: bytes


@dataclass
class Withdraw(PlutusData):
    """WITHDRAW redeemer — Constr index 1, no fields."""

    CONSTR_ID = 1


# ---------------------------------------------------------------------------
# Helpers — copied verbatim from simple-transfer/vesting for a self-contained
# scenario.
# ---------------------------------------------------------------------------


class YaciChainContext(BlockFrostChainContext):
    """
    BlockFrostChainContext subclass that works around Conway-era protocol
    parameter differences in yaci-devkit's Blockfrost-compatible API.

    yaci-devkit (Conway era) omits several pre-Conway fields
    (decentralisation_param, extra_entropy, min_utxo, coins_per_utxo_word)
    that the stock pycardano 0.19.2 blockfrost backend unconditionally reads.
    This subclass patches those reads to use safe defaults.
    """

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
                # Conway era: decentralisation_param is gone → default 0
                decentralization_param=Fraction(
                    getattr(params, "decentralisation_param", "0")
                ),
                # Conway era: extra_entropy is gone → default None
                extra_entropy=getattr(params, "extra_entropy", None),
                protocol_major_version=int(params.protocol_major_ver),
                protocol_minor_version=int(params.protocol_minor_ver),
                # Conway era: min_utxo is gone → default 0
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
                # Conway era: coins_per_utxo_word is gone → use Alonzo default
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
        """
        Evaluate execution units for a transaction.

        yaci-devkit's evaluate endpoint returns HTTP 202 (instead of 200),
        which the blockfrost-python @request_wrapper treats as an error.
        We override here to handle 202 and parse the ogmios-format result.
        The endpoint also expects the CBOR as a hex-encoded string body.
        """
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
        # Parse ogmios-format evaluation result:
        # {"result": {"EvaluationResult": {"spend:0": {"memory": N, "steps": M}, ...}}}
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
        """
        Submit a transaction, accepting HTTP 202 (which yaci-devkit returns
        instead of 200).  The stock pycardano blockfrost backend only accepts
        200, so we override it here.
        """
        if isinstance(cbor, str):
            cbor = bytes.fromhex(cbor)
        url = f"{self.api.url}/tx/submit"
        headers = {**self.api.default_headers, "Content-Type": "application/cbor"}
        resp = http_requests.post(url, headers=headers, data=cbor)
        if resp.status_code not in (200, 202):
            raise Exception(
                f"Transaction submit failed: HTTP {resp.status_code} — {resp.text}"
            )
        tx_hash = resp.text.strip('"')
        return tx_hash


def make_context() -> YaciChainContext:
    """Return a YaciChainContext pointed at the local yaci-devkit."""
    return YaciChainContext(project_id="Dummy Key", base_url=YACI_BASE)


def wallet_at(account_index: int) -> tuple[ExtendedSigningKey, Address]:
    """Derive (signing_key, address) for the given account index."""
    hd = HDWallet.from_mnemonic(TEST_MNEMONIC)
    payment_hd = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/0/0")
    stake_hd = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/2/0")
    psk = ExtendedSigningKey.from_hdwallet(payment_hd)
    ssk = ExtendedSigningKey.from_hdwallet(stake_hd)
    pvk = psk.to_verification_key()
    svk = ssk.to_verification_key()
    addr = Address(
        payment_part=pvk.hash(),
        staking_part=svk.hash(),
        network=NETWORK,
    )
    return psk, addr


def load_compiled_code(title_prefix: str) -> bytes:
    """Return the raw compiledCode bytes (double-CBOR) from plutus.json."""
    blueprint = json.loads(BLUEPRINT_PATH.read_text())
    v = next(
        x for x in blueprint["validators"] if x["title"].startswith(title_prefix)
    )
    return bytes.fromhex(v["compiledCode"])


def apply_htlc_params(
    compiled_code: bytes,
    secret_hash: bytes,
    expiration_ms: int,
    owner_vkh: bytes,
) -> PlutusV3Script:
    """
    Apply three parameters to the HTLC script using uplc.

    Parameters are applied in the order declared in the validator:
      secret (bytes) → expiration (int) → owner (bytes)

    Each uplc_apply wraps the program in an Apply node; the validator
    function is curried so successive applications saturate it.
    """
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(secret_hash))
    program = uplc_apply(program, PlutusInteger(expiration_ms))
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    flat_cbor = uplc_flatten(program)
    return PlutusV3Script(flat_cbor)


def script_address(script: PlutusV3Script) -> Address:
    """Return the enterprise script address for the given script."""
    return Address(payment_part=plutus_script_hash(script), network=NETWORK)


def wait_for_utxos(
    ctx: BlockFrostChainContext,
    address: Address,
    min_count: int = 1,
    timeout_s: int = 90,
) -> list[UTxO]:
    """Poll until at least min_count UTxOs appear at address, then return them."""
    for _ in range(timeout_s):
        try:
            utxos = ctx.utxos(str(address))
            if len(utxos) >= min_count:
                return utxos
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError(
        f"Timed out after {timeout_s}s waiting for >=={min_count} UTxO(s) at {address}"
    )


def submit_and_confirm(
    ctx: YaciChainContext,
    tx,
    watch_address: Address,
    label: str,
    timeout_s: int = 90,
) -> str:
    """
    Submit a transaction and wait for at least one UTxO at watch_address to
    reference the submitted tx hash (i.e. the output is confirmed on-chain).
    """
    tx_cbor = tx.to_cbor()
    tx_id = str(ctx.submit_tx_cbor(tx_cbor))
    print(f"  Submitted {label}: tx={tx_id}")
    # Poll until the submitted tx appears in the UTxO set
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


# ---------------------------------------------------------------------------
# Slot / time helpers for yaci-devkit
# ---------------------------------------------------------------------------


def slot_config(yaci_base: str) -> tuple[int, int, int]:
    """
    Return (zero_time_ms, zero_slot, slot_length_ms) for yaci-devkit.

    Compute the chain's genesis zero-time (POSIX ms at slot 0) from the
    latest block header: zero_time_sec = block_time_sec - block_slot_num.
    This is the value ogmios uses for slot->POSIX conversion, so it must
    match exactly for the valid_after check to pass.

    NO era offset is applied — Task 10 confirmed that adding 600 s breaks
    the validator's time comparison.
    """
    b = http_requests.get(f"{yaci_base}/v1/blocks/latest", timeout=10).json()
    zero_time_ms = (b["time"] - b["slot"]) * 1000
    return zero_time_ms, 0, 1000


def slot_to_ms(slot: int, cfg: tuple[int, int, int]) -> int:
    """Convert a slot number to POSIX milliseconds."""
    z, zs, sl = cfg
    return z + (slot - zs) * sl


def ms_to_slot(ms: int, cfg: tuple[int, int, int]) -> int:
    """Convert POSIX milliseconds to a slot number."""
    z, zs, sl = cfg
    return (ms - z) // sl + zs


def get_tip_slot(ctx: YaciChainContext) -> int:
    """Return the current chain tip slot number."""
    return ctx.last_block_slot


# ---------------------------------------------------------------------------
# Scenario steps
# ---------------------------------------------------------------------------


def fund_claimer(
    ctx: YaciChainContext,
    claimer_addr: Address,
    lovelace: int = 20_000_000,
) -> None:
    """Step 2: Fund claimer (account 1) from owner (account 0)."""
    owner_skey, owner_addr = wallet_at(0)
    print(f"Funding claimer {claimer_addr} with {lovelace} lovelace from account 0 ...")

    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(TransactionOutput(claimer_addr, lovelace))
    tx = builder.build_and_sign(
        signing_keys=[owner_skey],
        change_address=owner_addr,
    )
    submit_and_confirm(ctx, tx, claimer_addr, "FUND_CLAIMER")


def lock_htlc(
    ctx: YaciChainContext,
    script: PlutusV3Script,
    s_addr: Address,
    lovelace: int,
    label: str,
) -> str:
    """
    Lock lovelace at the HTLC script address.
    No datum is used — the validator's _datum arg is Option<Data> and is ignored.
    Returns the tx_id for later UTxO lookup.
    """
    owner_skey, owner_addr = wallet_at(0)

    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(TransactionOutput(s_addr, lovelace))
    tx = builder.build_and_sign(
        signing_keys=[owner_skey],
        change_address=owner_addr,
    )
    return submit_and_confirm(ctx, tx, s_addr, label)


def claim_guess(
    ctx: YaciChainContext,
    script: PlutusV3Script,
    s_addr: Address,
    lock_tx_id: str,
    preimage: bytes,
    claimer_account: int,
) -> None:
    """
    Step 5: Claimer reveals the preimage via the GUESS redeemer.

    The validator checks: sha2_256(answer) == secret
    So `answer` must be the raw preimage, NOT the hash.
    """
    claimer_skey, claimer_addr = wallet_at(claimer_account)
    print(f"Claimer (account {claimer_account}) claiming UTxO from tx {lock_tx_id[:12]}... "
          f"with preimage={preimage!r} ...")

    utxos = wait_for_utxos(ctx, s_addr)
    target = next(
        (u for u in utxos if str(u.input.transaction_id) == lock_tx_id), None
    )
    if target is None:
        raise RuntimeError(f"Could not find UTxO from tx {lock_tx_id} at {s_addr}")

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,  # no datum was attached at lock time
        redeemer=Redeemer(Guess(answer=preimage)),
    )
    builder.add_input_address(claimer_addr)
    tx = builder.build_and_sign(
        signing_keys=[claimer_skey],
        change_address=claimer_addr,
        auto_ttl_offset=300,
    )
    submit_and_confirm(ctx, tx, claimer_addr, "CLAIM_GUESS")


def wait_for_expiration(
    ctx: YaciChainContext,
    expiration_slot: int,
) -> None:
    """Step 6: Wait until the chain tip passes expiration_slot."""
    print(f"Waiting for tip to pass expiration slot {expiration_slot} ...")
    while True:
        tip = get_tip_slot(ctx)
        if tip > expiration_slot:
            print(f"  Tip is now {tip}, past expiration slot {expiration_slot}.")
            break
        remaining = expiration_slot - tip
        print(f"  Tip={tip}, waiting {remaining} more slots ...")
        time.sleep(max(1, remaining))


def refund_withdraw(
    ctx: YaciChainContext,
    script: PlutusV3Script,
    s_addr: Address,
    lock_tx_id: str,
    expiration_ms: int,
    cfg: tuple[int, int, int],
    owner_account: int = 0,
) -> None:
    """
    Step 7: Owner refunds UTxO 2 via the WITHDRAW redeemer after expiration.

    Requires:
      - validity_start > expiration_slot  (valid_after check)
      - owner's VKH in extra_signatories  (key_signed check)
    """
    owner_skey, owner_addr = wallet_at(owner_account)
    print(f"Owner refunding UTxO from tx {lock_tx_id[:12]}... via WITHDRAW ...")

    utxos = wait_for_utxos(ctx, s_addr)
    target = next(
        (u for u in utxos if str(u.input.transaction_id) == lock_tx_id), None
    )
    if target is None:
        raise RuntimeError(f"Could not find UTxO from tx {lock_tx_id} at {s_addr}")

    tip_slot = get_tip_slot(ctx)
    expiration_slot = ms_to_slot(expiration_ms, cfg)

    # validity_start must be strictly after expiration_slot for valid_after to pass
    validity_start = max(expiration_slot + 1, tip_slot - 5)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,  # no datum was attached at lock time
        redeemer=Redeemer(Withdraw()),
    )
    builder.add_input_address(owner_addr)
    # Validator checks key_signed(extra_signatories, owner)
    builder.required_signers = [owner_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 120
    tx = builder.build_and_sign(
        signing_keys=[owner_skey],
        change_address=owner_addr,
        auto_ttl_offset=300,
    )
    submit_and_confirm(ctx, tx, owner_addr, "REFUND_WITHDRAW")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== HTLC scenario: fund → lock×2 → guess-claim → wait → withdraw-refund ===")

    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Derive accounts
    owner_skey, owner_addr = wallet_at(0)
    _, claimer_addr = wallet_at(1)
    print(f"Owner   (account 0): {owner_addr}")
    print(f"Claimer (account 1): {claimer_addr}")

    owner_vkh = bytes(owner_addr.payment_part)

    # Load the parameterised HTLC script template
    compiled_code = load_compiled_code("htlc.htlc.spend")

    # Fetch slot config for time-to-slot conversions
    cfg = slot_config(YACI_BASE)
    print(f"Slot config: zero_time_ms={cfg[0]}, zero_slot={cfg[1]}, slot_length_ms={cfg[2]}")

    # --- Step 1 + 2: Fund claimer (20 ADA) so it can pay collateral ---
    fund_claimer(ctx, claimer_addr, lovelace=20_000_000)

    # --- Step 3: Lock UTxO 1 — "open-sesame", far-future expiration (~1 hour) ---
    preimage_1 = b"open-sesame"
    secret_1 = hashlib.sha256(preimage_1).digest()
    now_ms = int(time.time() * 1000)
    expiration_1_ms = now_ms + 3_600_000  # 1 hour from now

    script_1 = apply_htlc_params(compiled_code, secret_1, expiration_1_ms, owner_vkh)
    s_addr_1 = script_address(script_1)
    print(f"\nUTxO 1 script address: {s_addr_1}")
    print(f"  secret hash: {secret_1.hex()}")
    print(f"  expiration_ms: {expiration_1_ms} (~1h from now)")

    lock_tx_1 = lock_htlc(ctx, script_1, s_addr_1, lovelace=10_000_000, label="LOCK_1")

    # --- Step 4: Lock UTxO 2 — "another-secret", short expiration (tip + ~10 slots) ---
    preimage_2 = b"another-secret"
    secret_2 = hashlib.sha256(preimage_2).digest()
    tip_slot = get_tip_slot(ctx)
    expiration_2_slot = tip_slot + 10
    expiration_2_ms = slot_to_ms(expiration_2_slot, cfg)

    # Different params → different script hash → different address from UTxO 1
    script_2 = apply_htlc_params(compiled_code, secret_2, expiration_2_ms, owner_vkh)
    s_addr_2 = script_address(script_2)
    print(f"\nUTxO 2 script address: {s_addr_2}")
    print(f"  secret hash: {secret_2.hex()}")
    print(f"  expiration slot: {expiration_2_slot}, ms: {expiration_2_ms}")
    assert str(s_addr_1) != str(s_addr_2), "UTxO 1 and 2 must be at different addresses!"

    lock_tx_2 = lock_htlc(ctx, script_2, s_addr_2, lovelace=8_000_000, label="LOCK_2")

    # --- Step 5: Claimer reveals "open-sesame" to claim UTxO 1 ---
    print("\nStep 5: Claimer claiming UTxO 1 with GUESS redeemer ...")
    claim_guess(
        ctx,
        script=script_1,
        s_addr=s_addr_1,
        lock_tx_id=lock_tx_1,
        preimage=preimage_1,
        claimer_account=1,
    )

    # --- Step 6: Wait for UTxO 2's expiration slot to pass ---
    print(f"\nStep 6: Waiting for expiration slot {expiration_2_slot} to pass ...")
    wait_for_expiration(ctx, expiration_2_slot)

    # --- Step 7: Owner refunds UTxO 2 via WITHDRAW ---
    print("\nStep 7: Owner refunding UTxO 2 with WITHDRAW redeemer ...")
    refund_withdraw(
        ctx,
        script=script_2,
        s_addr=s_addr_2,
        lock_tx_id=lock_tx_2,
        expiration_ms=expiration_2_ms,
        cfg=cfg,
        owner_account=0,
    )

    print("\n=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

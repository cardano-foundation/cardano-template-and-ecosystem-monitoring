"""
vesting PyCardano scenario.

Demonstrates the two vesting paths:
  1. Owner clawback — owner reclaims before the deadline.
  2. Beneficiary claim — beneficiary collects after the deadline.

Accounts use the shared 24-word test mnemonic; account 0 = owner/funder,
account 1 = beneficiary.

Run against a local yaci-devkit instance:
    python vesting.py
"""

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
from pycardano.plutus import ExecutionUnits, Unit

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# yaci-devkit exposes a Blockfrost-compatible API at /api/v1.
# The blockfrost-python client appends DEFAULT_API_VERSION ('v0') to base_url,
# so we split the path: base_url='http://localhost:8080/api', version='v1'.
YACI_BASE = "http://localhost:8080/api"
YACI_BLOCKS_URL = "http://localhost:8080/api/v1/blocks"
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
# Datum definition
# ---------------------------------------------------------------------------


@dataclass
class VestingDatum(PlutusData):
    """
    Plutus datum for the vesting validator.

    CONSTR_ID=0 matches the VestingDatum constructor in the Aiken validator.
    Fields: lock_until (Int), owner (ByteArray), beneficiary (ByteArray).
    """

    CONSTR_ID = 0
    lock_until: int
    owner: bytes
    beneficiary: bytes


# ---------------------------------------------------------------------------
# Helpers — copied verbatim from simple-transfer for self-contained scenario
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
    for i in range(timeout_s):
        try:
            utxos = ctx.utxos(str(address))
            if len(utxos) >= min_count:
                return utxos
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError(
        f"Timed out after {timeout_s}s waiting for ≥{min_count} UTxO(s) at {address}"
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
# Slot/time helpers for yaci-devkit
# ---------------------------------------------------------------------------


def slot_config(yaci_base: str) -> tuple[int, int, int]:
    """
    Return (zero_time_ms, zero_slot, slot_length_ms) for yaci-devkit.

    Compute the chain's genesis zero-time (POSIX ms at slot 0) from the
    latest block header: zero_time_sec = block_time_sec - block_slot_num.
    This is the value ogmios uses for slot→POSIX conversion, so it must
    match exactly for the valid_after check to pass.
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


def fund_beneficiary(
    ctx: YaciChainContext,
    beneficiary_addr: Address,
    lovelace: int = 20_000_000,
) -> None:
    """Fund the beneficiary from account 0 so it can pay collateral."""
    owner_skey, owner_addr = wallet_at(0)
    print(f"Funding beneficiary {beneficiary_addr} with {lovelace} lovelace ...")

    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(TransactionOutput(beneficiary_addr, lovelace))
    tx = builder.build_and_sign(
        signing_keys=[owner_skey],
        change_address=owner_addr,
    )
    submit_and_confirm(ctx, tx, beneficiary_addr, "FUND")


def deposit_at_script(
    ctx: YaciChainContext,
    s_addr: Address,
    script: PlutusV3Script,
    datum: VestingDatum,
    lovelace: int,
    label: str,
) -> str:
    """
    Deposit lovelace at the vesting script with an inline datum.
    Returns the tx_id so the caller can identify the UTxO later.
    """
    owner_skey, owner_addr = wallet_at(0)

    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(
        TransactionOutput(
            s_addr,
            lovelace,
            datum=datum,
        )
    )
    tx = builder.build_and_sign(
        signing_keys=[owner_skey],
        change_address=owner_addr,
    )
    tx_id = submit_and_confirm(ctx, tx, s_addr, label)
    return tx_id


def owner_withdraw(
    ctx: YaciChainContext,
    s_addr: Address,
    script: PlutusV3Script,
    deposit_tx_id: str,
) -> None:
    """
    Owner withdraws the UTxO identified by deposit_tx_id (clawback path).
    The validator requires owner's VKH in extra_signatories.
    """
    owner_skey, owner_addr = wallet_at(0)

    print(f"Owner withdrawing UTxO from tx {deposit_tx_id[:12]}... (clawback) ...")

    # Find the specific UTxO by tx_id
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    target = next(
        (u for u in utxos if str(u.input.transaction_id) == deposit_tx_id), None
    )
    if target is None:
        raise RuntimeError(
            f"Could not find UTxO from tx {deposit_tx_id} at {s_addr}"
        )

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,   # inline datum — pycardano reads it from the UTxO
        redeemer=Redeemer(Unit()),
    )
    builder.add_input_address(owner_addr)
    # Validator checks key_signed(tx.extra_signatories, datum.owner)
    builder.required_signers = [owner_addr.payment_part]
    tx = builder.build_and_sign(
        signing_keys=[owner_skey],
        change_address=owner_addr,
        auto_ttl_offset=300,
    )
    submit_and_confirm(ctx, tx, owner_addr, "OWNER_WITHDRAW")


def wait_for_deadline(
    ctx: YaciChainContext,
    lock_until_slot: int,
    cfg: tuple[int, int, int],
) -> None:
    """Wait until the chain tip passes lock_until_slot."""
    print(f"Waiting for tip to pass slot {lock_until_slot} ...")
    while True:
        tip = get_tip_slot(ctx)
        if tip > lock_until_slot:
            print(f"  Tip is now {tip}, past deadline slot {lock_until_slot}.")
            break
        remaining = lock_until_slot - tip
        print(f"  Tip={tip}, waiting {remaining} more slots ...")
        time.sleep(max(1, remaining))


def beneficiary_withdraw(
    ctx: YaciChainContext,
    s_addr: Address,
    script: PlutusV3Script,
    deposit_tx_id: str,
    lock_until_ms: int,
    cfg: tuple[int, int, int],
) -> None:
    """
    Beneficiary withdraws the UTxO after the deadline.
    Requires validity_start > lock_until slot and beneficiary's signature.
    """
    benef_skey, benef_addr = wallet_at(1)

    print(
        f"Beneficiary withdrawing UTxO from tx {deposit_tx_id[:12]}... "
        f"(deadline path) ..."
    )

    # Find the specific UTxO
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    target = next(
        (u for u in utxos if str(u.input.transaction_id) == deposit_tx_id), None
    )
    if target is None:
        raise RuntimeError(
            f"Could not find UTxO from tx {deposit_tx_id} at {s_addr}"
        )

    tip_slot = get_tip_slot(ctx)
    lock_until_slot = ms_to_slot(lock_until_ms, cfg)

    # validity_start must be strictly after lock_until_slot (valid_after check)
    validity_start = max(lock_until_slot + 1, tip_slot - 5)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,   # inline datum
        redeemer=Redeemer(Unit()),
    )
    builder.add_input_address(benef_addr)
    # Validator checks key_signed(tx.extra_signatories, datum.beneficiary)
    builder.required_signers = [benef_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 120
    tx = builder.build_and_sign(
        signing_keys=[benef_skey],
        change_address=benef_addr,
    )
    submit_and_confirm(ctx, tx, benef_addr, "BENEFICIARY_WITHDRAW")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== vesting scenario: fund → deposit×2 → owner-withdraw → wait → beneficiary-withdraw ===")

    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Derive accounts
    owner_skey, owner_addr = wallet_at(0)
    _, benef_addr = wallet_at(1)
    print(f"Owner     (account 0): {owner_addr}")
    print(f"Beneficiary (account 1): {benef_addr}")

    owner_vkh = bytes(owner_addr.payment_part)
    benef_vkh = bytes(benef_addr.payment_part)

    # Load the parameterless vesting script
    compiled_code = load_compiled_code("vesting.vesting.spend")
    script = PlutusV3Script(compiled_code)
    s_addr = script_address(script)
    print(f"Vesting script address: {s_addr}")

    # Fetch slot config for time-to-slot conversions
    cfg = slot_config(YACI_BASE)
    print(f"Slot config: zero_time_ms={cfg[0]}, zero_slot={cfg[1]}, slot_length_ms={cfg[2]}")

    # Step 1: Fund beneficiary (20 ADA) so it can pay collateral
    fund_beneficiary(ctx, benef_addr, lovelace=20_000_000)

    # Step 2: Deposit 5 ADA for owner clawback (lock_until = now + 1 hour)
    now_ms = int(time.time() * 1000)
    one_hour_ms = 3_600_000
    lock_until_owner_ms = now_ms + one_hour_ms
    datum_owner = VestingDatum(
        lock_until=lock_until_owner_ms,
        owner=owner_vkh,
        beneficiary=benef_vkh,
    )
    print(
        f"Depositing 5 ADA for owner clawback "
        f"(lock_until={lock_until_owner_ms} ms, ~1h from now) ..."
    )
    deposit_tx_owner = deposit_at_script(
        ctx, s_addr, script, datum_owner, 5_000_000, "DEPOSIT_OWNER"
    )

    # Step 3: Deposit 5 ADA for beneficiary claim (lock_until = tip + ~10 slots)
    tip_slot = get_tip_slot(ctx)
    lock_until_benef_slot = tip_slot + 10
    lock_until_benef_ms = slot_to_ms(lock_until_benef_slot, cfg)
    datum_benef = VestingDatum(
        lock_until=lock_until_benef_ms,
        owner=owner_vkh,
        beneficiary=benef_vkh,
    )
    print(
        f"Depositing 5 ADA for beneficiary claim "
        f"(lock_until slot={lock_until_benef_slot}, ms={lock_until_benef_ms}) ..."
    )
    deposit_tx_benef = deposit_at_script(
        ctx, s_addr, script, datum_benef, 5_000_000, "DEPOSIT_BENEF"
    )

    # Step 4: Owner withdraws the first UTxO (clawback — deadline is 1h away)
    # Wait for both deposits to be visible at the script address
    wait_for_utxos(ctx, s_addr, min_count=2)
    owner_withdraw(ctx, s_addr, script, deposit_tx_owner)

    # Step 5: Wait for the beneficiary deadline to pass
    wait_for_deadline(ctx, lock_until_benef_slot, cfg)

    # Step 6: Beneficiary withdraws after deadline
    beneficiary_withdraw(
        ctx, s_addr, script, deposit_tx_benef, lock_until_benef_ms, cfg
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

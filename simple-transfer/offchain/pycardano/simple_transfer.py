"""
simple-transfer PyCardano scenario.

Locks 10 ADA at a parameterised PlutusV3 script (receiver VKH baked in),
then claims it with the receiver's signature.

Accounts use the shared 24-word test mnemonic; account 0 = funder/sender,
account 1 = recipient.

Run against a local yaci-devkit instance:
    python simple_transfer.py
"""

import json
import os
import tempfile
import time
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, Union

import requests as http_requests

# PyCardano core
from pycardano import (
    Address,
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    Network,
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

# UPLC parameter application (no apply_params_to_script in pycardano 0.19.2)
from uplc.ast import PlutusByteString
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
# Helpers
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


def apply_params_to_script(compiled_code: bytes, vkh_bytes: bytes) -> PlutusV3Script:
    """
    Apply a single VerificationKeyHash parameter to a compiled Plutus script.

    PyCardano 0.19.2 does not ship apply_params_to_script; we use the 'uplc'
    library directly.  The flow:
      1. unflatten(compiled_code) — parse the CBOR-wrapped flat UPLC bytes
      2. uplc_apply(program, PlutusByteString(vkh_bytes)) — build Apply node
      3. uplc_flatten(applied) — re-serialise to CBOR-wrapped flat bytes
      4. Wrap in PlutusV3Script
    """
    program = uplc_unflatten(compiled_code)
    applied = uplc_apply(program, PlutusByteString(vkh_bytes))
    flat_cbor = uplc_flatten(applied)
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
# Scenario steps
# ---------------------------------------------------------------------------


def fund_recipient(
    ctx: YaciChainContext,
    recipient_addr: Address,
    lovelace: int = 25_000_000,
) -> None:
    """Send lovelace from account 0 to the recipient address."""
    sender_skey, sender_addr = wallet_at(0)
    print(f"Funding {recipient_addr} with {lovelace} lovelace from account 0 ...")

    builder = TransactionBuilder(ctx)
    builder.add_input_address(sender_addr)
    builder.add_output(TransactionOutput(recipient_addr, lovelace))
    tx = builder.build_and_sign(
        signing_keys=[sender_skey],
        change_address=sender_addr,
    )
    submit_and_confirm(ctx, tx, recipient_addr, "FUND")


def lock_at_script(
    ctx: YaciChainContext,
    sender_account: int,
    recipient_addr: Address,
    lovelace: int = 10_000_000,
) -> Address:
    """Lock lovelace at the script parameterised on recipient's payment VKH."""
    skey, sender_addr = wallet_at(sender_account)

    # Resolve receiver VKH (payment part of recipient_addr)
    receiver_vkh = bytes(recipient_addr.payment_part)

    compiled_code = load_compiled_code("simple_transfer.simpleTransfer")
    script = apply_params_to_script(compiled_code, receiver_vkh)
    s_addr = script_address(script)

    print(
        f"Locking {lovelace} lovelace at script {s_addr} "
        f"(receiver VKH={receiver_vkh.hex()[:12]}...) ..."
    )

    builder = TransactionBuilder(ctx)
    builder.add_input_address(sender_addr)
    # No datum required — validator ignores _datum_opt
    builder.add_output(TransactionOutput(s_addr, lovelace))
    tx = builder.build_and_sign(
        signing_keys=[skey],
        change_address=sender_addr,
    )
    submit_and_confirm(ctx, tx, s_addr, "LOCK")
    return s_addr


def claim_from_script(
    ctx: YaciChainContext,
    receiver_account: int,
) -> None:
    """Claim all UTxOs from the script using the receiver's signing key."""
    skey, receiver_addr = wallet_at(receiver_account)
    receiver_vkh = bytes(receiver_addr.payment_part)

    compiled_code = load_compiled_code("simple_transfer.simpleTransfer")
    script = apply_params_to_script(compiled_code, receiver_vkh)
    s_addr = script_address(script)

    print(f"Claiming from script {s_addr} with account {receiver_account} ...")

    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    print(f"  Found {len(utxos)} UTxO(s) at script address.")

    builder = TransactionBuilder(ctx)
    for utxo in utxos:
        builder.add_script_input(
            utxo=utxo,
            script=script,
            datum=None,         # UTxO was locked without datum; do not include
            redeemer=Redeemer(Unit()),
        )
    builder.add_input_address(receiver_addr)
    # The validator checks that receiver VKH is in tx.extra_signatories
    builder.required_signers = [receiver_addr.payment_part]
    tx = builder.build_and_sign(
        signing_keys=[skey],
        change_address=receiver_addr,
        # yaci-devkit uses short epochs (~600 slots); limit TTL to 300 slots
        # ahead so it stays within the foreseeable era boundary.
        auto_ttl_offset=300,
    )
    submit_and_confirm(ctx, tx, receiver_addr, "CLAIM")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== simple-transfer scenario: fund → lock → claim ===")

    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Derive recipient (account 1)
    _, recipient_addr = wallet_at(1)
    print(f"Recipient (account 1): {recipient_addr}")

    # Step 1: fund recipient so it can pay collateral for the claim TX
    fund_recipient(ctx, recipient_addr, lovelace=25_000_000)

    # Step 2: lock 10 ADA at the parameterised script (sender = account 0)
    lock_at_script(ctx, sender_account=0, recipient_addr=recipient_addr, lovelace=10_000_000)

    # Step 3: claim
    claim_from_script(ctx, receiver_account=1)

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

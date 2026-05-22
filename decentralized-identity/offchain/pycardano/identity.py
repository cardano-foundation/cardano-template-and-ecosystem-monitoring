"""
decentralized-identity PyCardano scenario.

A single spending validator holding (owner_pkh, [delegates]) state at a script
UTxO. Owner-only transitions:
  TransferOwner — rotate the owner key.
  AddDelegate  — append a delegate with an expiry time (must be future).
  RemoveDelegate — drop a delegate.

Scenario: init → add-delegate → remove-delegate → transfer-owner.

Run against a local yaci-devkit instance:
    python identity.py
"""

import json
import os
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Union

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


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions
# ---------------------------------------------------------------------------


@dataclass
class Delegate(PlutusData):
    CONSTR_ID = 0
    key: bytes
    expires: int


@dataclass
class IdentityDatum(PlutusData):
    CONSTR_ID = 0
    owner: bytes
    delegates: List[Delegate]


@dataclass
class TransferOwner(PlutusData):
    CONSTR_ID = 0
    new_owner: bytes


@dataclass
class AddDelegate(PlutusData):
    CONSTR_ID = 1
    delegate: bytes
    expires: int


@dataclass
class RemoveDelegate(PlutusData):
    CONSTR_ID = 2
    delegate: bytes


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


# ---------------------------------------------------------------------------
# Slot/time helpers
# ---------------------------------------------------------------------------


def slot_config() -> tuple[int, int]:
    """Return (zero_time_ms, slot_length_ms) for yaci-devkit."""
    b = http_requests.get(f"{YACI_BASE}/v1/blocks/latest", timeout=10).json()
    zero_time_ms = (b["time"] - b["slot"]) * 1000
    return zero_time_ms, 1000


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


def init_identity(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    s_addr: Address,
    initial_datum: IdentityDatum,
    lovelace: int = 3_000_000,
) -> str:
    """Create the script UTxO with initial IdentityDatum."""
    print(f"INIT identity at {s_addr} with owner={initial_datum.owner.hex()[:12]}...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(
        TransactionOutput(s_addr, lovelace, datum=initial_datum)
    )
    tx = builder.build_and_sign(signing_keys=[owner_skey], change_address=owner_addr)
    return submit_and_confirm(ctx, tx, s_addr, "INIT")


def find_state_utxo(ctx: YaciChainContext, s_addr: Address, prev_tx_id: str) -> UTxO:
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    for u in utxos:
        if str(u.input.transaction_id) == prev_tx_id:
            return u
    raise RuntimeError(f"State UTxO from tx {prev_tx_id} not found at {s_addr}")


def perform_action(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    redeemer_value: PlutusData,
    new_datum: IdentityDatum,
    label: str,
    add_validity_bounds: bool = False,
) -> str:
    """Spend the state UTxO and re-emit with updated datum, preserving value."""
    print(f"{label} → new datum owner={new_datum.owner.hex()[:12]}..., "
          f"delegates={len(new_datum.delegates)}")
    target = find_state_utxo(ctx, s_addr, prev_tx_id)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(redeemer_value),
    )
    builder.add_input_address(owner_addr)
    # Preserve UTxO value (validator requires input_value == output_value)
    builder.add_output(
        TransactionOutput(s_addr, target.output.amount, datum=new_datum)
    )
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[owner_skey], change_address=owner_addr)
    return submit_and_confirm(ctx, tx, s_addr, label)


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== DID scenario: init → add-delegate → remove-delegate → transfer-owner ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Roles: owner = account 0, delegate = account 1, newOwner = account 2.
    owner_skey, owner_addr = wallet_at(0)
    _, delegate_addr = wallet_at(1)
    _, new_owner_addr = wallet_at(2)

    owner_vkh = bytes(owner_addr.payment_part)
    delegate_vkh = bytes(delegate_addr.payment_part)
    new_owner_vkh = bytes(new_owner_addr.payment_part)
    print(f"Owner   : {owner_addr}")
    print(f"Delegate: {delegate_addr}")
    print(f"NewOwner: {new_owner_addr}")

    compiled = load_compiled_code("identity.identity.spend")
    script = PlutusV3Script(compiled)
    s_addr = script_address(script)
    print(f"Identity script address: {s_addr}")

    # Step 1: init
    initial = IdentityDatum(owner=owner_vkh, delegates=[])
    init_tx = init_identity(ctx, owner_skey, owner_addr, s_addr, initial)

    # Step 2: AddDelegate (must include validity bounds; valid_before(expires))
    cfg_zero_time_ms, slot_ms = slot_config()
    tip = ctx.last_block_slot
    # expires must be > validity range end → set far enough into the future
    expires_ms = cfg_zero_time_ms + (tip + 1_000_000) * slot_ms
    add_state = IdentityDatum(
        owner=owner_vkh,
        delegates=[Delegate(key=delegate_vkh, expires=expires_ms)],
    )
    add_tx = perform_action(
        ctx, owner_skey, owner_addr, script, s_addr,
        init_tx, AddDelegate(delegate=delegate_vkh, expires=expires_ms),
        add_state, "ADD_DELEGATE", add_validity_bounds=True,
    )

    # Step 3: RemoveDelegate
    rem_state = IdentityDatum(owner=owner_vkh, delegates=[])
    rem_tx = perform_action(
        ctx, owner_skey, owner_addr, script, s_addr,
        add_tx, RemoveDelegate(delegate=delegate_vkh),
        rem_state, "REMOVE_DELEGATE",
    )

    # Step 4: TransferOwner
    transfer_state = IdentityDatum(owner=new_owner_vkh, delegates=[])
    perform_action(
        ctx, owner_skey, owner_addr, script, s_addr,
        rem_tx, TransferOwner(new_owner=new_owner_vkh),
        transfer_state, "TRANSFER_OWNER",
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

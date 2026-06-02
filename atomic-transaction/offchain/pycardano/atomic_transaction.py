"""
atomic-transaction PyCardano scenario.

A single PlutusV3 validator handles both mint and spend. The mint succeeds
only when the redeemer carries the literal password; the spend is open.
The scenario:
  1. Generate a fresh wallet and fund 50 ADA from account 0.
  2. MINT+LOCK — mint 1 AtomicToken under the validator's policy, send it to
     the script address with the redeemer stored as inline datum.
  3. COLLECT — one transaction that simultaneously spends the locked UTxO
     AND mints a second token. Both tokens (2 in total) go to the wallet.
  4. BURN — burn the 2 tokens via mint(-2) with the same password redeemer.

Run against a local yaci-devkit instance:
    python atomic_transaction.py
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

ASSET_NAME = b"AtomicToken"
PASSWORD = b"super_secret_password"


# ---------------------------------------------------------------------------
# Redeemer
# ---------------------------------------------------------------------------


@dataclass
class MintRedeemer(PlutusData):
    """Constr 0 with one field: the password bytes."""

    CONSTR_ID = 0
    password: bytes


# ---------------------------------------------------------------------------
# Yaci-devkit-compatible chain context (verbatim from prior scenarios)
# ---------------------------------------------------------------------------


class YaciChainContext(BlockFrostChainContext):
    """BlockFrostChainContext patched for yaci-devkit's Conway-era quirks."""

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
    """Pin validity to a small window around the tip so script eval doesn't
    cross yaci-devkit's unannounced era horizon."""
    tip = ctx.last_block_slot
    builder.validity_start = max(0, tip - 5)
    builder.ttl = tip + 60


# ---------------------------------------------------------------------------
# Scenario steps
# ---------------------------------------------------------------------------


def fund_fresh(
    ctx: YaciChainContext, fresh_addr: Address, lovelace: int = 50_000_000
) -> None:
    skey, addr = wallet_at(0)
    print(f"Funding fresh wallet {fresh_addr} with {lovelace} lovelace ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.add_output(TransactionOutput(fresh_addr, lovelace))
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, fresh_addr, "FUND")


def mint_and_lock(
    ctx: YaciChainContext,
    skey: ExtendedSigningKey,
    addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
) -> None:
    """Mint 1 AtomicToken under the validator's own policy; lock at s_addr."""
    print(f"MINT+LOCK 1 {ASSET_NAME!r} at {s_addr} ...")
    redeemer = MintRedeemer(password=PASSWORD)
    mint_ma = MultiAsset.from_primitive({policy_id.payload: {ASSET_NAME: 1}})

    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.mint = mint_ma
    builder.add_minting_script(script, redeemer=Redeemer(redeemer))
    builder.add_output(
        TransactionOutput(
            s_addr,
            Value(2_000_000, mint_ma),
            datum=redeemer,  # inline datum carries the same payload
        )
    )
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, s_addr, "MINT_LOCK")


def collect(
    ctx: YaciChainContext,
    skey: ExtendedSigningKey,
    addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
) -> None:
    """Atomic step: spend the locked UTxO AND mint a 2nd token in one tx."""
    print(f"COLLECT (spend+mint) from {s_addr} ...")
    redeemer = MintRedeemer(password=PASSWORD)
    mint_ma = MultiAsset.from_primitive({policy_id.payload: {ASSET_NAME: 1}})

    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    target = next(
        (
            u
            for u in utxos
            if u.output.amount.multi_asset
            and any(
                sh.payload == policy_id.payload for sh in u.output.amount.multi_asset
            )
        ),
        None,
    )
    if target is None:
        raise RuntimeError(f"No AtomicToken UTxO at {s_addr}")

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,  # inline datum on UTxO
        redeemer=Redeemer(redeemer),
    )
    builder.add_input_address(addr)
    builder.mint = mint_ma
    builder.add_minting_script(script, redeemer=Redeemer(redeemer))
    # Output: 2 tokens (1 from script + 1 minted) back to wallet
    output_ma = MultiAsset.from_primitive({policy_id.payload: {ASSET_NAME: 2}})
    builder.add_output(TransactionOutput(addr, Value(2_000_000, output_ma)))
    builder.required_signers = [addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, addr, "COLLECT")


def burn(
    ctx: YaciChainContext,
    skey: ExtendedSigningKey,
    addr: Address,
    script: PlutusV3Script,
    policy_id: ScriptHash,
    amount: int,
) -> None:
    print(f"BURN {amount} {ASSET_NAME!r} ...")
    redeemer = MintRedeemer(password=PASSWORD)
    mint_ma = MultiAsset.from_primitive({policy_id.payload: {ASSET_NAME: -amount}})

    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.mint = mint_ma
    builder.add_minting_script(script, redeemer=Redeemer(redeemer))
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, addr, "BURN")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== atomic-transaction scenario: mint+lock → collect → burn ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    fresh_mnemonic = HDWallet.generate_mnemonic(strength=256)
    fresh_skey, fresh_addr = wallet_from_mnemonic(fresh_mnemonic)
    print(f"Fresh wallet: {fresh_addr}")

    compiled = load_compiled_code("atomic.placeholder.mint")
    script = PlutusV3Script(compiled)
    policy_id = plutus_script_hash(script)
    s_addr = script_address(script)
    print(f"Atomic script address: {s_addr}")
    print(f"Policy id: {policy_id.payload.hex()}")

    fund_fresh(ctx, fresh_addr, lovelace=50_000_000)
    mint_and_lock(ctx, fresh_skey, fresh_addr, script, s_addr, policy_id)
    collect(ctx, fresh_skey, fresh_addr, script, s_addr, policy_id)
    burn(ctx, fresh_skey, fresh_addr, script, policy_id, amount=2)

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

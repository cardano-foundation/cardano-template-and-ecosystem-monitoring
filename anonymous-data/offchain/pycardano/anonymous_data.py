"""
anonymous-data PyCardano scenario.

Commit/reveal of an off-chain identifier without binding it to a pkh on-chain:
  COMMIT — compute id = blake2b_256(pkh || nonce), mint a singleton token
           whose asset name is `id`, send to script address with inline datum
           = the payload, mint redeemer = `id`.
  REVEAL — spend that UTxO with redeemer = `nonce`. Validator recovers `id`
           from the spent value and checks blake2b_256(pkh || nonce) == id
           for some signer.

Run against a local yaci-devkit instance:
    python anonymous_data.py
"""

import hashlib
import json
import os
import secrets
import time
from fractions import Fraction
from pathlib import Path
from typing import Dict, Union

import requests as http_requests

from pycardano import (
    Address,
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    MultiAsset,
    Network,
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


# ---------------------------------------------------------------------------
# Yaci-devkit-compatible chain context
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
    tip = ctx.last_block_slot
    builder.validity_start = max(0, tip - 5)
    builder.ttl = tip + 60


# ---------------------------------------------------------------------------
# Scenario steps
# ---------------------------------------------------------------------------


def fund_fresh(
    ctx: YaciChainContext, fresh_addr: Address, lovelace: int = 30_000_000
) -> None:
    skey, addr = wallet_at(0)
    print(f"Funding fresh wallet {fresh_addr} with {lovelace} lovelace ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.add_output(TransactionOutput(fresh_addr, lovelace))
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, fresh_addr, "FUND")


def commit(
    ctx: YaciChainContext,
    skey: ExtendedSigningKey,
    addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
    nonce: bytes,
    payload: bytes,
) -> bytes:
    """Mint singleton with asset name = blake2b_256(pkh || nonce); lock at script."""
    pkh = bytes(addr.payment_part)
    id_bytes = hashlib.blake2b(pkh + nonce, digest_size=32).digest()
    print(f"COMMIT id={id_bytes.hex()[:16]}... payload={payload!r}")

    mint_ma = MultiAsset.from_primitive({policy_id.payload: {id_bytes: 1}})

    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.mint = mint_ma
    builder.add_minting_script(script, redeemer=Redeemer(id_bytes))
    builder.add_output(
        TransactionOutput(s_addr, Value(2_000_000, mint_ma), datum=payload)
    )
    builder.required_signers = [addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, s_addr, "COMMIT")
    return id_bytes


def reveal(
    ctx: YaciChainContext,
    skey: ExtendedSigningKey,
    addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
    nonce: bytes,
    id_bytes: bytes,
) -> None:
    """Spend the committed UTxO with nonce as redeemer."""
    print(f"REVEAL id={id_bytes.hex()[:16]}... nonce={nonce.hex()[:16]}...")
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    target = None
    for u in utxos:
        ma = u.output.amount.multi_asset
        if ma:
            for sh, assets in ma.items():
                if sh.payload == policy_id.payload and any(
                    bytes(an.payload if hasattr(an, "payload") else an) == id_bytes
                    for an in assets
                ):
                    target = u
                    break
        if target:
            break
    if target is None:
        raise RuntimeError(f"Committed UTxO with id {id_bytes.hex()[:16]}... not found")

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,  # inline datum
        redeemer=Redeemer(nonce),
    )
    builder.add_input_address(addr)
    # Return the same token to the wallet
    out_ma = MultiAsset.from_primitive({policy_id.payload: {id_bytes: 1}})
    builder.add_output(TransactionOutput(addr, Value(2_000_000, out_ma)))
    builder.required_signers = [addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, addr, "REVEAL")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== anonymous-data scenario: commit → reveal ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    fresh_mnemonic = HDWallet.generate_mnemonic(strength=256)
    fresh_skey, fresh_addr = wallet_from_mnemonic(fresh_mnemonic)
    print(f"Fresh wallet: {fresh_addr}")

    compiled = load_compiled_code("anonymous_data.anonymous_data.mint")
    script = PlutusV3Script(compiled)
    policy_id = plutus_script_hash(script)
    s_addr = script_address(script)
    print(f"Anonymous-data script address: {s_addr}")
    print(f"Policy id: {policy_id.payload.hex()}")

    fund_fresh(ctx, fresh_addr, lovelace=30_000_000)

    nonce = secrets.token_bytes(16)
    payload = b"hello-world"
    id_bytes = commit(ctx, fresh_skey, fresh_addr, script, s_addr, policy_id, nonce, payload)
    reveal(ctx, fresh_skey, fresh_addr, script, s_addr, policy_id, nonce, id_bytes)

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

"""
storage PyCardano scenario.

Two validators:
  * mint.mint.mint  — parameterised by (seed_utxo, validator_hash).
      One-shot minting policy that:
        * consumes the seed UTxO (single-use guarantee),
        * mints exactly one token (asset name = sha2_256(snapshot_id)),
        * sends it to the storage spend address with the matching
          RegistryDatum as inline datum.
  * storage.storage.spend — unparameterised; spend ALWAYS fails. The script
      address is therefore an immutable burial ground for snapshot records.

Scenario:
  1. Resolve the storage script hash (no params on the spend).
  2. Pick a UTxO at account 0 (not a collateral-only utxo) to use as seed.
  3. Apply (seed_utxo, validator_hash) to the mint script.
  4. Mint singleton NFT and send it to the storage script with RegistryDatum.

We don't try to spend the storage UTxO — that path is hard-failed by design.

Run against a local yaci-devkit instance:
    python storage.py
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

# UPLC parameter application (no apply_params_to_script in pycardano 0.19.2)
from uplc.ast import PlutusByteString, PlutusConstr, PlutusInteger
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


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions — mirror lib/storage/types.ak
# ---------------------------------------------------------------------------


@dataclass
class Daily(PlutusData):
    """SnapshotType::Daily — Constr 0, no fields."""

    CONSTR_ID = 0


@dataclass
class Monthly(PlutusData):
    """SnapshotType::Monthly — Constr 1, no fields."""

    CONSTR_ID = 1


@dataclass
class RegistryDatum(PlutusData):
    CONSTR_ID = 0
    snapshot_id: bytes
    snapshot_type: Union[Daily, Monthly]
    commitment_hash: bytes
    published_at: int


@dataclass
class MintRedeemer(PlutusData):
    CONSTR_ID = 0
    snapshot_id: bytes
    snapshot_type: Union[Daily, Monthly]
    commitment_hash: bytes


# ---------------------------------------------------------------------------
# Yaci-devkit-compatible chain context (verbatim from prior scenarios)
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
    raise TimeoutError(
        f"TX {tx_id} not confirmed at {watch_address} within {timeout_s}s"
    )


def set_tight_validity(ctx: YaciChainContext, builder: TransactionBuilder) -> None:
    tip = ctx.last_block_slot
    builder.validity_start = max(0, tip - 5)
    builder.ttl = tip + 60


# ---------------------------------------------------------------------------
# Scenario helpers
# ---------------------------------------------------------------------------


def apply_mint_params(
    compiled_code: bytes,
    seed_tx_id_bytes: bytes,
    seed_index: int,
    validator_hash: bytes,
) -> PlutusV3Script:
    """
    Apply (seed_utxo: OutputReference, validator_hash: ByteArray) to the
    mint policy script.

    Aiken's OutputReference is Constr(0, [transaction_id: ByteArray, output_index: Int]).
    """
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(
        program,
        PlutusConstr(
            0,
            [PlutusByteString(seed_tx_id_bytes), PlutusInteger(seed_index)],
        ),
    )
    program = uplc_apply(program, PlutusByteString(validator_hash))
    return PlutusV3Script(uplc_flatten(program))


def pick_seed_utxo(ctx: YaciChainContext, addr: Address) -> UTxO:
    """
    Return a non-collateral-only UTxO from `addr` to use as the one-shot
    seed. Prefer a UTxO that holds >5 ADA so it isn't yaci-devkit's
    collateral utxo (which is usually 5 ADA exactly).
    """
    utxos = ctx.utxos(str(addr))
    # Take the largest pure-ADA UTxO that isn't 5_000_000 lovelace exactly.
    candidates = [
        u
        for u in utxos
        if int(u.output.amount.coin) > 5_000_000
        and (
            u.output.amount.multi_asset is None
            or len(u.output.amount.multi_asset) == 0
        )
    ]
    if not candidates:
        raise RuntimeError(f"No suitable seed UTxO at {addr}")
    candidates.sort(key=lambda u: int(u.output.amount.coin), reverse=True)
    return candidates[0]


def publish_snapshot(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    storage_addr: Address,
    storage_hash: bytes,
    mint_compiled: bytes,
    snapshot_id: bytes,
    snapshot_type: PlutusData,
    commitment_hash: bytes,
    published_at_ms: int,
) -> str:
    """Mint a snapshot NFT and lock it (with datum) at the storage script."""
    print(
        f"PUBLISH snapshot_id={snapshot_id.decode(errors='replace')} "
        f"type={type(snapshot_type).__name__} ..."
    )
    seed_utxo = pick_seed_utxo(ctx, owner_addr)
    seed_tx_id_bytes = bytes(seed_utxo.input.transaction_id)
    seed_index = seed_utxo.input.index
    print(f"  seed UTxO: {seed_tx_id_bytes.hex()}#{seed_index} ({seed_utxo.output.amount.coin} lovelace)")

    mint_script = apply_mint_params(
        mint_compiled, seed_tx_id_bytes, seed_index, storage_hash
    )
    policy_id: ScriptHash = plutus_script_hash(mint_script)

    asset_name = hashlib.sha256(snapshot_id).digest()
    print(f"  policy id   : {policy_id.payload.hex()}")
    print(f"  asset name  : {asset_name.hex()}")

    redeemer = MintRedeemer(
        snapshot_id=snapshot_id,
        snapshot_type=snapshot_type,
        commitment_hash=commitment_hash,
    )
    datum = RegistryDatum(
        snapshot_id=snapshot_id,
        snapshot_type=snapshot_type,
        commitment_hash=commitment_hash,
        published_at=published_at_ms,
    )

    mint_ma = MultiAsset.from_primitive({policy_id.payload: {asset_name: 1}})

    builder = TransactionBuilder(ctx)
    # Pin the seed UTxO as an explicit input (the policy checks for it).
    builder.add_input(seed_utxo)
    # Pull additional funds for fees / minUTxO from the same address.
    builder.add_input_address(owner_addr)
    builder.mint = mint_ma
    builder.add_minting_script(mint_script, redeemer=Redeemer(redeemer))
    # Output goes to the storage script with the registry datum inline.
    builder.add_output(
        TransactionOutput(
            storage_addr,
            Value(2_000_000, mint_ma),
            datum=datum,
        )
    )
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, storage_addr, "PUBLISH")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== storage scenario: publish daily → publish monthly ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    owner_skey, owner_addr = wallet_at(0)
    print(f"Owner / publisher: {owner_addr}")

    storage_compiled = load_compiled_code("storage.storage.spend")
    storage_script = PlutusV3Script(storage_compiled)
    storage_addr = script_address(storage_script)
    storage_hash = plutus_script_hash(storage_script).payload
    print(f"Storage script address: {storage_addr}")
    print(f"Storage script hash   : {storage_hash.hex()}")

    mint_compiled = load_compiled_code("mint.mint.mint")

    now_ms = int(time.time() * 1000)

    # Snapshot 1 — Daily
    snap_id_1 = f"snap-{now_ms}-daily".encode("utf-8")
    commitment_1 = bytes.fromhex("a" * 64)  # 32-byte SHA-256 commitment
    publish_snapshot(
        ctx,
        owner_skey,
        owner_addr,
        storage_addr,
        storage_hash,
        mint_compiled,
        snap_id_1,
        Daily(),
        commitment_1,
        now_ms,
    )

    # Sleep so the next tx's seed UTxO is freshly available
    time.sleep(2)

    # Snapshot 2 — Monthly
    now_ms_2 = int(time.time() * 1000)
    snap_id_2 = f"snap-{now_ms_2}-monthly".encode("utf-8")
    commitment_2 = bytes.fromhex("b" * 64)
    publish_snapshot(
        ctx,
        owner_skey,
        owner_addr,
        storage_addr,
        storage_hash,
        mint_compiled,
        snap_id_2,
        Monthly(),
        commitment_2,
        now_ms_2,
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

"""
factory PyCardano scenario.

Four validator entry points across three scripts:

  factory_marker.factory_marker.mint  — params (owner, utxo_ref)
      One-shot policy. Mints a single FACTORY_MARKER NFT, requires the seed
      utxo_ref to be consumed in the minting tx. Owner must sign.

  factory.factory.spend  — params (owner, factory_marker_policy)
      CreateProduct {product_policy_id, product_id}:
        - the spent factory UTxO carries the FACTORY_MARKER NFT,
        - exactly one continuing output at the factory address still carries
          the marker,
        - the new product asset (product_policy_id, product_id) is minted,
        - the new product policy is appended to the FactoryDatum products list,
        - owner signs.

  product.product.mint  — params (owner, factory_marker_policy, product_id)
      Mints exactly one (product_policy_id, product_id) token. Requires the
      factory UTxO (carrying FACTORY_MARKER) to be spent in the same tx and
      the product token to be sent to a script address with an inline
      ProductDatum. Owner signs.

  product.product.spend  — params (owner, factory_marker_policy, product_id)
      Owner-only spend; not exercised in this happy-path scenario.

Scenario:
   bootstrap factory (one-shot marker mint + lock at factory script with
   empty FactoryDatum) → create product #1 (mint + lock at product addr) →
   create product #2.

Run against a local yaci-devkit instance:
    python factory.py
"""

import json
import os
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Optional, Union

import requests as http_requests

from pycardano import (
    Address,
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
# PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
# blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
BLUEPRINT_PATH = Path(
    os.environ.get(
        "PLUTUS_JSON",
        Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json",
    )
)

FACTORY_MARKER_NAME = b"FACTORY_MARKER"


# ---------------------------------------------------------------------------
# Datum / Redeemer types
# ---------------------------------------------------------------------------


@dataclass
class FactoryDatum(PlutusData):
    """types.FactoryDatum { products: List<PolicyId> }."""

    CONSTR_ID = 0
    products: List[bytes]


@dataclass
class ProductDatum(PlutusData):
    """types.ProductDatum { tag: ByteArray }."""

    CONSTR_ID = 0
    tag: bytes


@dataclass
class CreateProduct(PlutusData):
    """factory.FactoryRedeemer::CreateProduct { product_policy_id, product_id }."""

    CONSTR_ID = 0
    product_policy_id: bytes
    product_id: bytes


@dataclass
class EmptyRedeemer(PlutusData):
    """`Data` redeemer placeholder for the marker mint / product mint."""

    CONSTR_ID = 0


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


def apply_marker_params(
    compiled_code: bytes, owner_vkh: bytes, seed_tx_id: bytes, seed_index: int
) -> PlutusV3Script:
    """Apply (owner: VerificationKeyHash, utxo_ref: OutputReference)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    program = uplc_apply(
        program,
        PlutusConstr(
            0,
            [PlutusByteString(seed_tx_id), PlutusInteger(seed_index)],
        ),
    )
    return PlutusV3Script(uplc_flatten(program))


def apply_factory_params(
    compiled_code: bytes, owner_vkh: bytes, marker_policy_id: bytes
) -> PlutusV3Script:
    """Apply (owner: VerificationKeyHash, factory_marker_policy: PolicyId)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    program = uplc_apply(program, PlutusByteString(marker_policy_id))
    return PlutusV3Script(uplc_flatten(program))


def apply_product_params(
    compiled_code: bytes,
    owner_vkh: bytes,
    marker_policy_id: bytes,
    product_id: bytes,
) -> PlutusV3Script:
    """Apply (owner, factory_marker_policy, product_id)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    program = uplc_apply(program, PlutusByteString(marker_policy_id))
    program = uplc_apply(program, PlutusByteString(product_id))
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


def pick_seed_utxo(ctx: YaciChainContext, addr: Address) -> UTxO:
    """Largest pure-ADA UTxO with > 10 ADA (so we still have headroom for fees + minUTxO)."""
    utxos = ctx.utxos(str(addr))
    candidates = [
        u
        for u in utxos
        if int(u.output.amount.coin) > 10_000_000
        and (
            u.output.amount.multi_asset is None
            or len(u.output.amount.multi_asset) == 0
        )
    ]
    if not candidates:
        raise RuntimeError(f"No suitable seed UTxO at {addr}")
    candidates.sort(key=lambda u: int(u.output.amount.coin), reverse=True)
    return candidates[0]


def read_factory_datum(utxo: UTxO) -> FactoryDatum:
    d = utxo.output.datum
    if d is None:
        raise RuntimeError("Factory UTxO has no datum")
    if hasattr(d, "cbor"):
        cbor = d.cbor
    elif hasattr(d, "to_cbor"):
        cbor = d.to_cbor()
    else:
        cbor = bytes(d)
    return FactoryDatum.from_cbor(cbor)


def find_factory_utxo(
    ctx: YaciChainContext,
    factory_addr: Address,
    marker_policy: ScriptHash,
    prev_tx_id: Optional[str] = None,
) -> UTxO:
    utxos = wait_for_utxos(ctx, factory_addr, min_count=1)
    if prev_tx_id is not None:
        for u in utxos:
            if str(u.input.transaction_id) == prev_tx_id:
                return u
        raise RuntimeError(
            f"Factory UTxO from tx {prev_tx_id} not found at {factory_addr}"
        )
    for u in utxos:
        ma = u.output.amount.multi_asset
        if ma and any(sh.payload == marker_policy.payload for sh in ma):
            return u
    raise RuntimeError(f"Factory UTxO with marker not found at {factory_addr}")


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


def create_factory(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    marker_script: PlutusV3Script,
    factory_addr: Address,
    seed_utxo: UTxO,
) -> str:
    """Mint the FACTORY_MARKER NFT (one-shot) and lock it at the factory script
    with an empty FactoryDatum."""
    print("CREATE_FACTORY ...")
    marker_policy = plutus_script_hash(marker_script)
    mint_ma = MultiAsset.from_primitive(
        {marker_policy.payload: {FACTORY_MARKER_NAME: 1}}
    )

    builder = TransactionBuilder(ctx)
    # Seed UTxO must be a spent input so the one-shot guarantee fires.
    builder.add_input(seed_utxo)
    builder.add_input_address(owner_addr)
    builder.mint = mint_ma
    builder.add_minting_script(marker_script, redeemer=Redeemer(EmptyRedeemer()))
    builder.add_output(
        TransactionOutput(
            factory_addr,
            Value(2_000_000, mint_ma),
            datum=FactoryDatum(products=[]),
        )
    )
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, factory_addr, "CREATE_FACTORY")


def create_product(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    factory_script: PlutusV3Script,
    factory_addr: Address,
    marker_policy: ScriptHash,
    product_script: PlutusV3Script,
    product_addr: Address,
    product_id: bytes,
    tag: bytes,
    prev_factory_tx_id: Optional[str] = None,
) -> str:
    """Spend the factory UTxO (append product policy to its datum) AND mint
    one (product_policy_id, product_id) token at the product script address
    with a ProductDatum."""
    print(f"CREATE_PRODUCT id={product_id!r} tag={tag!r} ...")
    factory_utxo = find_factory_utxo(
        ctx, factory_addr, marker_policy, prev_factory_tx_id
    )
    current = read_factory_datum(factory_utxo)
    product_policy = plutus_script_hash(product_script)

    new_products = list(current.products) + [product_policy.payload]
    new_factory_datum = FactoryDatum(products=new_products)

    mint_ma = MultiAsset.from_primitive(
        {product_policy.payload: {product_id: 1}}
    )

    builder = TransactionBuilder(ctx)
    # Spend the factory state UTxO with the CreateProduct redeemer.
    builder.add_script_input(
        utxo=factory_utxo,
        script=factory_script,
        datum=None,
        redeemer=Redeemer(
            CreateProduct(
                product_policy_id=product_policy.payload,
                product_id=product_id,
            )
        ),
    )
    builder.add_input_address(owner_addr)
    # Mint the new product token.
    builder.mint = mint_ma
    builder.add_minting_script(product_script, redeemer=Redeemer(EmptyRedeemer()))
    # Continuing factory output — keeps the marker, updates the datum.
    builder.add_output(
        TransactionOutput(
            factory_addr,
            factory_utxo.output.amount,
            datum=new_factory_datum,
        )
    )
    # Send the new product token to the product script address with a
    # ProductDatum so it satisfies `product.mint`'s output check.
    builder.add_output(
        TransactionOutput(
            product_addr,
            Value(2_000_000, mint_ma),
            datum=ProductDatum(tag=tag),
        )
    )
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, factory_addr, "CREATE_PRODUCT")


def read_product_tag(
    ctx: YaciChainContext, product_addr: Address, product_id: bytes
) -> bytes:
    utxos = wait_for_utxos(ctx, product_addr, min_count=1)
    for u in utxos:
        if u.output.datum is None:
            continue
        d = u.output.datum
        if hasattr(d, "cbor"):
            cbor = d.cbor
        elif hasattr(d, "to_cbor"):
            cbor = d.to_cbor()
        else:
            cbor = bytes(d)
        try:
            pd = ProductDatum.from_cbor(cbor)
        except Exception:
            continue
        return pd.tag
    raise RuntimeError(f"No ProductDatum at {product_addr} for {product_id!r}")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== factory scenario: create-factory → create-product × 2 → read tag ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    owner_skey, owner_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    print(f"Owner: {owner_addr}")

    fund(ctx, owner_addr, 200_000_000)

    owner_vkh = bytes(owner_addr.payment_part)

    # ---- Build marker policy (one-shot, parameterised by a seed UTxO) ----
    seed_utxo = pick_seed_utxo(ctx, owner_addr)
    seed_tx_id = bytes(seed_utxo.input.transaction_id)
    seed_index = seed_utxo.input.index
    print(f"  seed UTxO: {seed_tx_id.hex()}#{seed_index}")

    marker_compiled = load_compiled_code("factory_marker.factory_marker.mint")
    marker_script = apply_marker_params(
        marker_compiled, owner_vkh, seed_tx_id, seed_index
    )
    marker_policy = plutus_script_hash(marker_script)
    print(f"Marker policy id   : {marker_policy.payload.hex()}")

    factory_compiled = load_compiled_code("factory.factory.spend")
    factory_script = apply_factory_params(
        factory_compiled, owner_vkh, marker_policy.payload
    )
    factory_addr = script_address(factory_script)
    print(f"Factory script addr: {factory_addr}")

    # ---- Bootstrap the factory ----
    create_tx = create_factory(
        ctx, owner_skey, owner_addr, marker_script, factory_addr, seed_utxo
    )

    # ---- Mint product widget-001 ----
    product_compiled = load_compiled_code("product.product.mint")
    prod1_id = b"widget-001"
    prod1_script = apply_product_params(
        product_compiled, owner_vkh, marker_policy.payload, prod1_id
    )
    prod1_addr = script_address(prod1_script)
    print(f"Product#1 policy id : {plutus_script_hash(prod1_script).payload.hex()}")

    prod1_tx = create_product(
        ctx, owner_skey, owner_addr,
        factory_script, factory_addr, marker_policy,
        prod1_script, prod1_addr,
        product_id=prod1_id, tag=b"blue",
        prev_factory_tx_id=create_tx,
    )

    # ---- Mint product widget-002 ----
    prod2_id = b"widget-002"
    prod2_script = apply_product_params(
        product_compiled, owner_vkh, marker_policy.payload, prod2_id
    )
    prod2_addr = script_address(prod2_script)
    print(f"Product#2 policy id : {plutus_script_hash(prod2_script).payload.hex()}")

    create_product(
        ctx, owner_skey, owner_addr,
        factory_script, factory_addr, marker_policy,
        prod2_script, prod2_addr,
        product_id=prod2_id, tag=b"red",
        prev_factory_tx_id=prod1_tx,
    )

    # ---- Read back product#1 tag (datum-only read, no tx) ----
    tag = read_product_tag(ctx, prod1_addr, prod1_id)
    print(f"Product#1 tag      : {tag.decode(errors='replace')}")

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

"""
escrow PyCardano scenario.

Two-party asset swap with explicit recipient opt-in. The validator uses
Plutus V3's `cardano/address.Address` type (Credential + optional staking
credential) and an MValue alias for `Pairs<PolicyId, Pairs<AssetName, Int>>`,
which encodes at the Data layer as a CBOR map keyed by policy id, with each
value being a CBOR map of asset name → quantity.

Lifecycle (lovelace-only, no native tokens — keeps MValue trivial):
  1. Fund two fresh wallets: initiator, recipient.
  2. INITIATE — initiator locks 5 ADA at the escrow script with an
     `Initiation` datum naming themselves and the 5 ADA bundle.
  3. RECIPIENT_DEPOSIT — recipient spends the script UTxO and re-emits it
     with an `ActiveEscrow` datum naming both parties + both bundles, and
     adds 7 ADA to the on-script value.
  4. COMPLETE_TRADE — both parties co-sign; initiator receives recipient's
     bundle (7 ADA), recipient receives initiator's bundle (5 ADA).

Run against a local yaci-devkit instance:
    python escrow.py
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
# PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
# blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
BLUEPRINT_PATH = Path(
    os.environ.get(
        "PLUTUS_JSON",
        Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json",
    )
)


# ---------------------------------------------------------------------------
# Plutus V3 Address encoding
# ---------------------------------------------------------------------------
# Address {
#   payment_credential: Credential,
#   stake_credential: Option<Referenced<Credential>>,
# }
# Credential = VerificationKey(hash) | Script(hash)        → Constr 0 | 1
# Referenced = Inline(a) | Pointer(...)                    → Constr 0 | 1
# Option     = Some(a) | None                              → Constr 0 | 1


@dataclass
class VerificationKeyCred(PlutusData):
    CONSTR_ID = 0
    hash: bytes


@dataclass
class ScriptCred(PlutusData):
    CONSTR_ID = 1
    hash: bytes


@dataclass
class InlineRef(PlutusData):
    CONSTR_ID = 0
    cred: Union[VerificationKeyCred, ScriptCred]


@dataclass
class NoStakeCred(PlutusData):
    """Option's None — Constr 1, no fields."""

    CONSTR_ID = 1


@dataclass
class SomeStakeCred(PlutusData):
    """Option's Some, wrapping a Referenced<Credential>."""

    CONSTR_ID = 0
    cred: InlineRef


@dataclass
class PlutusAddr(PlutusData):
    CONSTR_ID = 0
    payment: Union[VerificationKeyCred, ScriptCred]
    stake: Union[NoStakeCred, SomeStakeCred]


def plutus_addr_from_wallet(addr: Address) -> PlutusAddr:
    """Convert a wallet Address (payment_part + optional staking_part) into the
    Plutus V3 `cardano/address.Address` value."""
    pay_hash = bytes(addr.payment_part)
    payment = VerificationKeyCred(hash=pay_hash)
    if addr.staking_part is not None:
        stake_hash = bytes(addr.staking_part)
        stake = SomeStakeCred(cred=InlineRef(cred=VerificationKeyCred(hash=stake_hash)))
    else:
        stake = NoStakeCred()
    return PlutusAddr(payment=payment, stake=stake)


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions
# ---------------------------------------------------------------------------
#
# MValue = Pairs<PolicyId, Pairs<AssetName, Int>>
# Pairs<K,V> ≡ CBOR map at the Data layer (Aiken docs). In pycardano this
# is `Dict[K, V]` as a field type. MValue is a *type alias*, not a wrapper —
# the field is `Dict[bytes, Dict[bytes, int]]` directly.
#
# Lovelace-only convention: {b"": {b"": amount}}.


@dataclass
class Initiation(PlutusData):
    CONSTR_ID = 0
    initiator: PlutusAddr
    initiator_assets: Dict[bytes, Dict[bytes, int]]


@dataclass
class ActiveEscrow(PlutusData):
    CONSTR_ID = 1
    initiator: PlutusAddr
    initiator_assets: Dict[bytes, Dict[bytes, int]]
    recipient: PlutusAddr
    recipient_assets: Dict[bytes, Dict[bytes, int]]


# EscrowRedeemer in declaration order: RecipientDeposit | CancelTrade | CompleteTrade
@dataclass
class RecipientDeposit(PlutusData):
    CONSTR_ID = 0
    recipient: PlutusAddr
    recipient_assets: Dict[bytes, Dict[bytes, int]]


@dataclass
class CancelTrade(PlutusData):
    CONSTR_ID = 1


@dataclass
class CompleteTrade(PlutusData):
    CONSTR_ID = 2


def lovelace_mvalue(amount: int) -> Dict[bytes, Dict[bytes, int]]:
    """MValue containing only lovelace."""
    return {b"": {b"": amount}}


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


def fund(ctx: YaciChainContext, target: Address, lovelace: int, label: str) -> None:
    skey, addr = wallet_at(0)
    print(f"Funding {target} with {lovelace} lovelace ({label}) ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.add_output(TransactionOutput(target, lovelace))
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, target, f"FUND_{label}")


def initiate(
    ctx: YaciChainContext,
    init_skey: ExtendedSigningKey,
    init_addr: Address,
    s_addr: Address,
    initiator_lovelace: int,
) -> tuple[str, Initiation]:
    """INITIATE — initiator locks their bundle at the escrow with an
    Initiation datum naming themselves."""
    print(f"INITIATE — initiator locks {initiator_lovelace} lovelace at {s_addr} ...")
    datum = Initiation(
        initiator=plutus_addr_from_wallet(init_addr),
        initiator_assets=lovelace_mvalue(initiator_lovelace),
    )
    builder = TransactionBuilder(ctx)
    builder.add_input_address(init_addr)
    builder.add_output(TransactionOutput(s_addr, initiator_lovelace, datum=datum))
    tx = builder.build_and_sign(signing_keys=[init_skey], change_address=init_addr)
    tx_id = submit_and_confirm(ctx, tx, s_addr, "INITIATE")
    return tx_id, datum


def find_script_utxo(ctx: YaciChainContext, s_addr: Address, prev_tx_id: str) -> UTxO:
    utxos = wait_for_utxos(ctx, s_addr)
    for u in utxos:
        if str(u.input.transaction_id) == prev_tx_id:
            return u
    raise RuntimeError(f"Script UTxO {prev_tx_id} not found at {s_addr}")


def deposit(
    ctx: YaciChainContext,
    recip_skey: ExtendedSigningKey,
    recip_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    init_tx_id: str,
    init_datum: Initiation,
    recipient_lovelace: int,
) -> tuple[str, ActiveEscrow]:
    """RECIPIENT_DEPOSIT — transition Initiation → ActiveEscrow. Recipient
    spends the script UTxO and re-emits with the recipient's bundle added,
    naming themselves in the new datum."""
    print(f"RECIPIENT_DEPOSIT — recipient adds {recipient_lovelace} lovelace ...")
    target = find_script_utxo(ctx, s_addr, init_tx_id)

    recip_plutus = plutus_addr_from_wallet(recip_addr)
    recip_mv = lovelace_mvalue(recipient_lovelace)
    new_datum = ActiveEscrow(
        initiator=init_datum.initiator,
        initiator_assets=init_datum.initiator_assets,
        recipient=recip_plutus,
        recipient_assets=recip_mv,
    )
    new_lovelace = int(target.output.amount.coin) + recipient_lovelace

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(
            RecipientDeposit(recipient=recip_plutus, recipient_assets=recip_mv)
        ),
    )
    builder.add_input_address(recip_addr)
    builder.add_output(TransactionOutput(s_addr, new_lovelace, datum=new_datum))
    builder.required_signers = [recip_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[recip_skey], change_address=recip_addr)
    tx_id = submit_and_confirm(ctx, tx, s_addr, "DEPOSIT")
    return tx_id, new_datum


def complete_trade(
    ctx: YaciChainContext,
    init_skey: ExtendedSigningKey,
    init_addr: Address,
    recip_skey: ExtendedSigningKey,
    recip_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    active_tx_id: str,
    active_datum: ActiveEscrow,
) -> str:
    """COMPLETE_TRADE — both parties co-sign; atomic swap of bundles.
    Initiator receives recipient_assets, recipient receives initiator_assets."""
    print(f"COMPLETE_TRADE — initiator & recipient co-sign ...")
    target = find_script_utxo(ctx, s_addr, active_tx_id)

    # Extract lovelace amounts from the MValues.
    init_lovelace = active_datum.initiator_assets.get(b"", {}).get(b"", 0)
    recip_lovelace = active_datum.recipient_assets.get(b"", {}).get(b"", 0)
    if init_lovelace == 0 or recip_lovelace == 0:
        raise RuntimeError(
            "Expected lovelace-only MValues; got "
            f"init={active_datum.initiator_assets}, recip={active_datum.recipient_assets}"
        )

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(CompleteTrade()),
    )
    builder.add_input_address(init_addr)
    # Crossed payouts: initiator receives recipient's bundle, vice versa.
    builder.add_output(TransactionOutput(init_addr, recip_lovelace))
    builder.add_output(TransactionOutput(recip_addr, init_lovelace))
    builder.required_signers = [init_addr.payment_part, recip_addr.payment_part]
    set_tight_validity(ctx, builder)
    # Both must sign the tx witness set.
    tx = builder.build_and_sign(
        signing_keys=[init_skey, recip_skey],
        change_address=init_addr,
    )
    return submit_and_confirm(ctx, tx, init_addr, "COMPLETE")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== escrow scenario: initiate → deposit → complete ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Two fresh wallets — initiator, recipient.
    init_mnemonic = HDWallet.generate_mnemonic(strength=256)
    recip_mnemonic = HDWallet.generate_mnemonic(strength=256)
    init_skey, init_addr = wallet_from_mnemonic(init_mnemonic)
    recip_skey, recip_addr = wallet_from_mnemonic(recip_mnemonic)
    print(f"initiator: {init_addr}")
    print(f"recipient: {recip_addr}")

    fund(ctx, init_addr, 30_000_000, "initiator")
    fund(ctx, recip_addr, 30_000_000, "recipient")

    compiled = load_compiled_code("escrow.escrow.spend")
    script = PlutusV3Script(compiled)
    s_addr = script_address(script)
    print(f"Escrow script address: {s_addr}")

    init_tx, init_datum = initiate(
        ctx, init_skey, init_addr, s_addr, initiator_lovelace=5_000_000,
    )
    active_tx, active_datum = deposit(
        ctx, recip_skey, recip_addr, script, s_addr, init_tx, init_datum,
        recipient_lovelace=7_000_000,
    )
    complete_trade(
        ctx, init_skey, init_addr, recip_skey, recip_addr,
        script, s_addr, active_tx, active_datum,
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

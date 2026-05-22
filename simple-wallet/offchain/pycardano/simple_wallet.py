"""
simple-wallet PyCardano scenario.

Three validators wired together:

  intent.payment_intent.spend (1 param: owner)
      — Holds a PaymentIntent { recipient, lovelace_amt, data } and is spent
        when the owner authorises (key_signed). Used as input during
        ExecuteTx so its datum can be read.

  wallet.wallet.mint (2 params: owner, intent_script_hash)
      — Mint:  attaches an INTENT_MARKER NFT to a brand-new PaymentIntent
              UTxO at the intent script. Owner must sign and the marker must
              accompany a well-formed PaymentIntent datum.
        Burn:  any single-token destruction; owner signs. Used by ExecuteTx
              to retire a fulfilled intent.

  funds.funds.spend (2 params: owner, wallet_script_hash)
      — ExecuteTx: consume one intent UTxO (identified by its marker), pay
                   the recipient exactly `lovelace_amt`, burn the marker.
                   Owner co-signs.
        Withdraw : owner-only escape hatch.

Scenario (happy path):
   fund(owner) → add_funds → create_intent → execute_intent → withdraw_funds

Run against a local yaci-devkit instance:
    python simple_wallet.py
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

from uplc.ast import PlutusByteString
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

INTENT_TOKEN_NAME = b"INTENT_MARKER"


# ---------------------------------------------------------------------------
# Plutus V3 Address encoding (cardano/address.Address)
# ---------------------------------------------------------------------------


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
    cred: Union["VerificationKeyCred", "ScriptCred"]


@dataclass
class NoStakeCred(PlutusData):
    CONSTR_ID = 1


@dataclass
class SomeStakeCred(PlutusData):
    CONSTR_ID = 0
    cred: InlineRef


@dataclass
class PlutusAddr(PlutusData):
    CONSTR_ID = 0
    payment: Union[VerificationKeyCred, ScriptCred]
    stake: Union[SomeStakeCred, NoStakeCred]


def plutus_addr_from_wallet(addr: Address) -> PlutusAddr:
    pay_hash = bytes(addr.payment_part)
    payment = VerificationKeyCred(hash=pay_hash)
    if addr.staking_part is not None:
        stake_hash = bytes(addr.staking_part)
        stake = SomeStakeCred(cred=InlineRef(cred=VerificationKeyCred(hash=stake_hash)))
    else:
        stake = NoStakeCred()
    return PlutusAddr(payment=payment, stake=stake)


# ---------------------------------------------------------------------------
# Datum / Redeemer types
# ---------------------------------------------------------------------------


@dataclass
class PaymentIntent(PlutusData):
    """intent.PaymentIntent { recipient: Address, lovelace_amt: Int, data: ByteArray }."""

    CONSTR_ID = 0
    recipient: PlutusAddr
    lovelace_amt: int
    data: bytes


# wallet.WalletRedeemer = Mint | Burn
@dataclass
class WalletMint(PlutusData):
    CONSTR_ID = 0


@dataclass
class WalletBurn(PlutusData):
    CONSTR_ID = 1


# funds.Action = ExecuteTx | Withdraw
@dataclass
class ExecuteTx(PlutusData):
    CONSTR_ID = 0


@dataclass
class Withdraw(PlutusData):
    CONSTR_ID = 1


# Funds datum is `Option<Data>` — we use a permissive placeholder. The
# validator does not care what shape the datum has, just that the UTxO
# carries one (or is datum-less). We use an empty Constr 0 as a benign
# default, mirroring the meshjs reference (`mConStr0([0, []])`).
@dataclass
class FundsDatum(PlutusData):
    """Empty datum placeholder for funds.spend; the validator ignores it."""

    CONSTR_ID = 0


# Intent spend redeemer is `_redeemer: Data`; anything is fine. We use an
# empty Constr 0 sentinel.
@dataclass
class IntentSpendRedeemer(PlutusData):
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


def apply_intent_params(compiled_code: bytes, owner_vkh: bytes) -> PlutusV3Script:
    """Apply (owner: VerificationKeyHash)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    return PlutusV3Script(uplc_flatten(program))


def apply_wallet_params(
    compiled_code: bytes, owner_vkh: bytes, intent_script_hash: bytes
) -> PlutusV3Script:
    """Apply (owner: VerificationKeyHash, intent_script_hash: ScriptHash)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    program = uplc_apply(program, PlutusByteString(intent_script_hash))
    return PlutusV3Script(uplc_flatten(program))


def apply_funds_params(
    compiled_code: bytes, owner_vkh: bytes, wallet_script_hash: bytes
) -> PlutusV3Script:
    """Apply (owner: VerificationKeyHash, wallet_script_hash: ScriptHash)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(owner_vkh))
    program = uplc_apply(program, PlutusByteString(wallet_script_hash))
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
# Datum read helpers
# ---------------------------------------------------------------------------


def read_intent_datum(utxo: UTxO) -> PaymentIntent:
    d = utxo.output.datum
    if d is None:
        raise RuntimeError("Intent UTxO has no datum")
    if hasattr(d, "cbor"):
        cbor = d.cbor
    elif hasattr(d, "to_cbor"):
        cbor = d.to_cbor()
    else:
        cbor = bytes(d)
    return PaymentIntent.from_cbor(cbor)


def plutus_addr_to_wallet(pa: PlutusAddr) -> Address:
    """Convert a PaymentIntent.recipient back to a `pycardano.Address`."""
    if isinstance(pa.payment, VerificationKeyCred):
        pay_hash = pa.payment.hash
        from pycardano import VerificationKeyHash
        pay_part = VerificationKeyHash(pay_hash)
    elif isinstance(pa.payment, ScriptCred):
        pay_hash = pa.payment.hash
        pay_part = ScriptHash(pay_hash)
    else:
        raise RuntimeError(f"Unknown payment credential: {pa.payment}")
    stake_part = None
    if isinstance(pa.stake, SomeStakeCred):
        inner = pa.stake.cred.cred
        from pycardano import VerificationKeyHash
        if isinstance(inner, VerificationKeyCred):
            stake_part = VerificationKeyHash(inner.hash)
        elif isinstance(inner, ScriptCred):
            stake_part = ScriptHash(inner.hash)
    return Address(payment_part=pay_part, staking_part=stake_part, network=NETWORK)


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


def add_funds(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    funds_addr: Address,
    lovelace: int,
) -> str:
    """Deposit lovelace at the funds script address with a placeholder datum."""
    print(f"ADD_FUNDS {lovelace} lovelace -> {funds_addr} ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(
        TransactionOutput(funds_addr, lovelace, datum=FundsDatum())
    )
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, funds_addr, "ADD_FUNDS")


def create_intent(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    recipient_addr: Address,
    intent_addr: Address,
    wallet_script: PlutusV3Script,
    lovelace_amt: int,
    data: bytes,
) -> str:
    """Mint INTENT_MARKER NFT and lock it at the intent script."""
    print(f"CREATE_INTENT amount={lovelace_amt} recipient={recipient_addr} ...")
    policy_id = plutus_script_hash(wallet_script)
    mint_ma = MultiAsset.from_primitive({policy_id.payload: {INTENT_TOKEN_NAME: 1}})

    intent_datum = PaymentIntent(
        recipient=plutus_addr_from_wallet(recipient_addr),
        lovelace_amt=lovelace_amt,
        data=data,
    )

    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.mint = mint_ma
    builder.add_minting_script(wallet_script, redeemer=Redeemer(WalletMint()))
    # The marker NFT must land at the intent script with the inline PaymentIntent datum.
    builder.add_output(
        TransactionOutput(
            intent_addr,
            Value(2_000_000, mint_ma),
            datum=intent_datum,
        )
    )
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, intent_addr, "CREATE_INTENT")


def find_intent_utxo(
    ctx: YaciChainContext,
    intent_addr: Address,
    policy_id: ScriptHash,
) -> UTxO:
    utxos = wait_for_utxos(ctx, intent_addr, min_count=1)
    for u in utxos:
        ma = u.output.amount.multi_asset
        if ma and any(sh.payload == policy_id.payload for sh in ma):
            return u
    raise RuntimeError(f"Intent UTxO with marker not found at {intent_addr}")


def find_funds_utxo(
    ctx: YaciChainContext, funds_addr: Address
) -> UTxO:
    """Return any datum-bearing UTxO at the funds address."""
    utxos = wait_for_utxos(ctx, funds_addr, min_count=1)
    for u in utxos:
        if u.output.datum is not None:
            return u
    raise RuntimeError(f"No datum-bearing UTxO at {funds_addr}")


def execute_intent(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    intent_script: PlutusV3Script,
    intent_addr: Address,
    wallet_script: PlutusV3Script,
    funds_script: PlutusV3Script,
    funds_addr: Address,
) -> str:
    """Consume one intent UTxO, pay the recipient, burn the marker."""
    print("EXECUTE_INTENT ...")
    policy_id = plutus_script_hash(wallet_script)
    intent_utxo = find_intent_utxo(ctx, intent_addr, policy_id)
    funds_utxo = find_funds_utxo(ctx, funds_addr)

    intent_datum = read_intent_datum(intent_utxo)
    payee = plutus_addr_to_wallet(intent_datum.recipient)
    payout = int(intent_datum.lovelace_amt)
    print(f"  payee={payee} amount={payout}")

    burn_ma = MultiAsset.from_primitive(
        {policy_id.payload: {INTENT_TOKEN_NAME: -1}}
    )

    builder = TransactionBuilder(ctx)
    # Spend funds (script) — covers the payout from the script-locked pool.
    builder.add_script_input(
        utxo=funds_utxo,
        script=funds_script,
        datum=None,
        redeemer=Redeemer(ExecuteTx()),
    )
    # Spend intent (script) — its datum tells us payee + amount.
    builder.add_script_input(
        utxo=intent_utxo,
        script=intent_script,
        datum=None,
        redeemer=Redeemer(IntentSpendRedeemer()),
    )
    # Burn the intent marker.
    builder.mint = burn_ma
    builder.add_minting_script(wallet_script, redeemer=Redeemer(WalletBurn()))
    # Pay exactly `lovelace_amt` to the recipient.
    builder.add_output(TransactionOutput(payee, payout))
    builder.add_input_address(owner_addr)
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, payee, "EXECUTE_INTENT")


def withdraw_funds(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    funds_script: PlutusV3Script,
    funds_addr: Address,
) -> str:
    """Owner-only sweep of one funds UTxO back to the owner."""
    print("WITHDRAW_FUNDS ...")
    funds_utxo = find_funds_utxo(ctx, funds_addr)
    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=funds_utxo,
        script=funds_script,
        datum=None,
        redeemer=Redeemer(Withdraw()),
    )
    builder.add_input_address(owner_addr)
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, owner_addr, "WITHDRAW_FUNDS")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print(
        "=== simple-wallet scenario: add-funds → create-intent → execute → withdraw ==="
    )
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    owner_skey, owner_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    recipient_skey, recipient_addr = wallet_from_mnemonic(
        HDWallet.generate_mnemonic(strength=256)
    )
    print(f"Owner    : {owner_addr}")
    print(f"Recipient: {recipient_addr}")

    fund(ctx, owner_addr, 100_000_000)

    owner_vkh = bytes(owner_addr.payment_part)

    # Build scripts. Parameter chain: intent → wallet (depends on intent) →
    # funds (depends on wallet).
    intent_compiled = load_compiled_code("intent.payment_intent.spend")
    intent_script = apply_intent_params(intent_compiled, owner_vkh)
    intent_hash = bytes(plutus_script_hash(intent_script))
    intent_addr = script_address(intent_script)
    print(f"Intent script hash : {intent_hash.hex()}")
    print(f"Intent script addr : {intent_addr}")

    wallet_compiled = load_compiled_code("wallet.wallet.mint")
    wallet_script = apply_wallet_params(wallet_compiled, owner_vkh, intent_hash)
    wallet_hash = bytes(plutus_script_hash(wallet_script))
    print(f"Wallet policy id   : {wallet_hash.hex()}")

    funds_compiled = load_compiled_code("funds.funds.spend")
    funds_script = apply_funds_params(funds_compiled, owner_vkh, wallet_hash)
    funds_addr = script_address(funds_script)
    print(f"Funds script addr  : {funds_addr}")

    # 1. Add funds to the script-controlled vault.
    add_funds(ctx, owner_skey, owner_addr, funds_addr, 20_000_000)

    # 2. Create an intent: owner authorises sending 5 ADA to recipient.
    create_intent(
        ctx,
        owner_skey, owner_addr,
        recipient_addr,
        intent_addr,
        wallet_script,
        lovelace_amt=5_000_000,
        data=b"test-payment",
    )

    # 3. Execute the intent: pay recipient, burn marker, consume both script
    # UTxOs in the same tx.
    execute_intent(
        ctx,
        owner_skey, owner_addr,
        intent_script, intent_addr,
        wallet_script,
        funds_script, funds_addr,
    )

    # 4. Top up and then withdraw the rest to demonstrate the escape hatch.
    add_funds(ctx, owner_skey, owner_addr, funds_addr, 10_000_000)
    withdraw_funds(ctx, owner_skey, owner_addr, funds_script, funds_addr)

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

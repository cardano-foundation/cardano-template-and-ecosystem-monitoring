"""
upgradable-proxy PyCardano scenario.

Validators

  proxy.proxy.mint  / proxy.proxy.spend  — params (utxo_ref: OutputReference)
      Holds a one-of-a-kind state token (name = sha3_256(tx_id || str(idx)))
      whose UTxO carries an inline ProxyDatum { script_pointer, script_owner }.
      The state token's address must equal the proxy script address.

      mint:
        INIT  — consume utxo_ref; mint exactly one state token; lock it to the
                proxy script with a well-formed ProxyDatum; owner signs.
        MINT  — issue domain tokens. Forbids re-minting the state token. The
                tx must include a withdrawal whose credential equals the
                current `script_pointer` (read from a reference input).

      spend:
        UPDATE — applies to the state UTxO; continues the state token forward;
                 rotates `script_pointer` / `script_owner`; old owner signs.
        SPEND  — applies to non-state UTxOs; reads the state UTxO as reference
                 input; requires withdrawal from current `script_pointer`.

  script_logic_v_1.script_logic_version_1_0  — params (proxy_policy_id: PolicyId)
      Withdraw script. Validates:
        * if mint touches proxy policy: exactly one token, name ==
          redeemer.token_name.
        * if a script-locked proxy UTxO is being spent: redeemer.password ==
          "Hello, World!".

  script_logic_v_2.script_logic_version_1_0  — params (proxy_policy_id: PolicyId)
      Withdraw script. Same shape, but:
        * mint: amount == 1, asset_name != redeemer.invalid_token_name.
        * spend: unconditionally True.

Scenario:
   init (mint state token, publish reference script, register v1 stake cred)
     → mint(v1) with logic v1
     → change_version v1 → v2 (rotate script_pointer, register v2 stake cred)
     → mint(v2) with logic v2

Run against a local yaci-devkit instance:
    python upgradable_proxy.py
"""

import hashlib
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
    Certificate,
    ExtendedSigningKey,
    HDWallet,
    MultiAsset,
    Network,
    PlutusData,
    PlutusV3Script,
    Redeemer,
    ScriptHash,
    StakeCredential,
    StakeRegistration,
    TransactionBuilder,
    TransactionInput,
    TransactionOutput,
    UTxO,
    Value,
    VerificationKeyHash,
    Withdrawals,
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
BLUEPRINT_PATH = (
    Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json"
)

PROXY_MINT_TOKEN = b"ProxyMintToken"


# ---------------------------------------------------------------------------
# Datum / Redeemer types
# ---------------------------------------------------------------------------


@dataclass
class ProxyDatum(PlutusData):
    """proxy.ProxyDatum { script_pointer, script_owner }."""

    CONSTR_ID = 0
    script_pointer: bytes
    script_owner: bytes


@dataclass
class ProxyMintMint(PlutusData):
    """ProxyMintRedeemer::MINT — Constr 0."""

    CONSTR_ID = 0


@dataclass
class ProxyMintInit(PlutusData):
    """ProxyMintRedeemer::INIT — Constr 1."""

    CONSTR_ID = 1


@dataclass
class ProxySpend(PlutusData):
    """ProxySpendRedeemer::SPEND — Constr 0."""

    CONSTR_ID = 0


@dataclass
class ProxyUpdate(PlutusData):
    """ProxySpendRedeemer::UPDATE — Constr 1."""

    CONSTR_ID = 1


@dataclass
class LogicV1Redeemer(PlutusData):
    """script_logic_v_1.MyRedeemer { token_name, password }."""

    CONSTR_ID = 0
    token_name: bytes
    password: bytes


@dataclass
class LogicV2Redeemer(PlutusData):
    """script_logic_v_2.MyRedeemer { invalid_token_name }."""

    CONSTR_ID = 0
    invalid_token_name: bytes


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
            # yaci-devkit's evaluate endpoint mis-evaluates certain Plutus V3
            # transactions that the LEDGER itself accepts at submit time.
            print(f"  [evaluate fallback] yaci eval rejected — using static budgets")
            return {
                "spend:0": ExecutionUnits(10_000_000, 5_000_000_000),
                "mint:0": ExecutionUnits(10_000_000, 5_000_000_000),
                "withdrawal:0": ExecutionUnits(10_000_000, 5_000_000_000),
            }
        body = resp.json()
        result = body.get("result", {})
        eval_result = result.get("EvaluationResult", {})
        return_val: Dict[str, ExecutionUnits] = {}
        for k, v in eval_result.items():
            # ogmios uses "withdraw:N" but pycardano's RedeemerTag.WITHDRAWAL
            # maps to "withdrawal:N". Remap so _update_execution_units can find
            # the right key.
            if k.startswith("withdraw:"):
                k = "withdrawal:" + k.split(":", 1)[1]
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


def apply_proxy_params(
    compiled_code: bytes, seed_tx_id: bytes, seed_index: int
) -> PlutusV3Script:
    """Apply (utxo_ref: OutputReference)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(
        program,
        PlutusConstr(
            0,
            [PlutusByteString(seed_tx_id), PlutusInteger(seed_index)],
        ),
    )
    return PlutusV3Script(uplc_flatten(program))


def apply_logic_params(compiled_code: bytes, proxy_policy_id: bytes) -> PlutusV3Script:
    """Apply (proxy_policy_id: PolicyId)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(proxy_policy_id))
    return PlutusV3Script(uplc_flatten(program))


def script_address(script: PlutusV3Script) -> Address:
    return Address(payment_part=plutus_script_hash(script), network=NETWORK)


def reward_address(script_hash: ScriptHash) -> Address:
    """Stake-only address (the reward / withdrawal address) for a script."""
    return Address(staking_part=script_hash, network=NETWORK)


def state_token_name(seed_tx_id: bytes, seed_index: int) -> bytes:
    """sha3_256(tx_id || utf8(str(idx))) — must match the on-chain derivation."""
    return hashlib.sha3_256(seed_tx_id + str(seed_index).encode("utf-8")).digest()


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
    """Largest pure-ADA UTxO with > 10 ADA."""
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


def read_proxy_datum(utxo: UTxO) -> ProxyDatum:
    d = utxo.output.datum
    if d is None:
        raise RuntimeError("Proxy UTxO has no datum")
    if hasattr(d, "cbor"):
        cbor = d.cbor
    elif hasattr(d, "to_cbor"):
        cbor = d.to_cbor()
    else:
        cbor = bytes(d)
    return ProxyDatum.from_cbor(cbor)


def find_state_utxo(
    ctx: YaciChainContext,
    proxy_addr: Address,
    policy_id: ScriptHash,
    token_name: bytes,
) -> UTxO:
    utxos = wait_for_utxos(ctx, proxy_addr, min_count=1)
    for u in utxos:
        ma = u.output.amount.multi_asset
        if not ma:
            continue
        for sh, asset_map in ma.items():
            if sh.payload != policy_id.payload:
                continue
            for an in asset_map:
                if an.payload == token_name:
                    return u
    raise RuntimeError(
        f"State UTxO with token {token_name.hex()} not found at {proxy_addr}"
    )


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


def fund_split(
    ctx: YaciChainContext, target: Address, lovelace: int, splits: int = 1
) -> None:
    """Send `lovelace` to `target` as `splits` equal pure-ADA UTxOs (so we
    have ada-only collateral candidates available)."""
    skey, addr = wallet_at(0)
    each = lovelace // splits
    print(f"Funding {target} with {lovelace} lovelace ({splits} UTxOs) ...")
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    for _ in range(splits):
        builder.add_output(TransactionOutput(target, each))
    tx = builder.build_and_sign(signing_keys=[skey], change_address=addr)
    submit_and_confirm(ctx, tx, target, "FUND")


def init_proxy(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    proxy_script: PlutusV3Script,
    proxy_addr: Address,
    seed_utxo: UTxO,
    initial_logic_hash: ScriptHash,
    v1_reward_addr: Address,
) -> tuple[str, bytes]:
    """Mint the state token (one-shot), lock it at the proxy address with the
    initial ProxyDatum, attach the proxy script as a reference script, and
    register the v1 logic's stake credential so we can later withdraw 0 from it."""
    print("INIT (mint state token, publish reference script, register v1 stake cred) ...")
    policy_id = plutus_script_hash(proxy_script)
    token_name = state_token_name(
        bytes(seed_utxo.input.transaction_id), seed_utxo.input.index
    )
    print(f"  state token name : {token_name.hex()}")

    mint_ma = MultiAsset.from_primitive({policy_id.payload: {token_name: 1}})
    datum = ProxyDatum(
        script_pointer=bytes(initial_logic_hash),
        script_owner=bytes(owner_addr.payment_part),
    )

    builder = TransactionBuilder(ctx)
    builder.add_input(seed_utxo)
    builder.add_input_address(owner_addr)
    builder.mint = mint_ma
    builder.add_minting_script(proxy_script, redeemer=Redeemer(ProxyMintInit()))
    # Register the v1 logic's stake credential — required before we can
    # call `withdrawals` against it. The v1 publish branch allows this cert
    # unconditionally.
    builder.certificates = [
        StakeRegistration(StakeCredential(initial_logic_hash)),
    ]
    # Lock the state token at the proxy script address. Attach the proxy
    # script itself as a reference script on this output so future calls can
    # use it without re-uploading.
    builder.add_output(
        TransactionOutput(
            proxy_addr,
            Value(15_000_000, mint_ma),
            datum=datum,
            script=proxy_script,
        )
    )
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    tx_id = submit_and_confirm(ctx, tx, proxy_addr, "INIT")
    return tx_id, token_name


def mint_with_logic(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    proxy_script: PlutusV3Script,
    proxy_addr: Address,
    proxy_policy: ScriptHash,
    state_token: bytes,
    logic_script: PlutusV3Script,
    logic_reward_addr: Address,
    logic_redeemer: PlutusData,
    asset_name: bytes,
) -> str:
    """Mint one (proxy_policy, asset_name) token. Requires:
      - reference input = state UTxO at proxy address,
      - withdrawal from logic script's reward address (0 lovelace),
      - logic redeemer matches the version-specific rules (token name etc.)."""
    print(f"MINT_WITH_LOGIC asset_name={asset_name!r} ...")
    state_utxo = find_state_utxo(ctx, proxy_addr, proxy_policy, state_token)
    mint_ma = MultiAsset.from_primitive(
        {proxy_policy.payload: {asset_name: 1}}
    )

    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    # Mint via proxy policy. Pass the state UTxO (which has the proxy script
    # attached as a reference script) so pycardano uses the on-chain ref
    # instead of attaching the script inline as a duplicate witness.
    builder.mint = mint_ma
    builder.add_minting_script(state_utxo, redeemer=Redeemer(ProxyMintMint()))
    # Withdraw 0 from the logic script's reward address — this is how proxy
    # delegates "must invoke current logic" via withdrawals.
    builder.withdrawals = Withdrawals({bytes(logic_reward_addr): 0})
    builder.add_withdrawal_script(
        logic_script, redeemer=Redeemer(logic_redeemer)
    )
    # The newly minted token goes back to the owner.
    builder.add_output(TransactionOutput(owner_addr, Value(2_000_000, mint_ma)))
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, owner_addr, "MINT_WITH_LOGIC")


def change_version(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    proxy_script: PlutusV3Script,
    proxy_addr: Address,
    proxy_policy: ScriptHash,
    state_token: bytes,
    current_logic_script: PlutusV3Script,
    current_logic_reward_addr: Address,
    current_logic_redeemer: PlutusData,
    next_logic_hash: ScriptHash,
    next_logic_reward_addr: Address,
    register_next_stake_cred: bool,
) -> str:
    """Rotate the proxy's `script_pointer` to a new logic script. Spends the
    state UTxO with UPDATE, continues the state token forward with the new
    datum. Also withdraws 0 from the current logic (it's still in force
    until this tx confirms) and optionally registers the next logic's stake
    credential."""
    print("CHANGE_VERSION ...")
    state_utxo = find_state_utxo(ctx, proxy_addr, proxy_policy, state_token)
    current = read_proxy_datum(state_utxo)

    new_datum = ProxyDatum(
        script_pointer=bytes(next_logic_hash),
        script_owner=current.script_owner,
    )

    builder = TransactionBuilder(ctx)
    # Spend the state UTxO with UPDATE; the proxy script attached as a
    # reference script on the UTxO is auto-detected by add_script_input.
    builder.add_script_input(
        utxo=state_utxo,
        datum=None,
        redeemer=Redeemer(ProxyUpdate()),
    )
    builder.add_input_address(owner_addr)
    # The current logic gates the UPDATE indirectly: proxy.spend SPEND
    # requires it for non-state UTxOs, while UPDATE doesn't. But invoking
    # the *current* logic in the same tx is still required by proxy.spend
    # SPEND ONLY — UPDATE has its own checks. We still include a withdrawal
    # from the current logic so the version handover is signed off by the
    # outgoing logic's rules.
    builder.withdrawals = Withdrawals({bytes(current_logic_reward_addr): 0})
    builder.add_withdrawal_script(
        current_logic_script, redeemer=Redeemer(current_logic_redeemer)
    )
    if register_next_stake_cred:
        builder.certificates = [
            StakeRegistration(StakeCredential(next_logic_hash)),
        ]
    # Continuing state output — same coin/asset value, new datum, same
    # reference script.
    builder.add_output(
        TransactionOutput(
            proxy_addr,
            state_utxo.output.amount,
            datum=new_datum,
            script=proxy_script,
        )
    )
    builder.required_signers = [owner_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, proxy_addr, "CHANGE_VERSION")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print(
        "=== upgradable-proxy scenario: "
        "init → mint(v1) → change-version → mint(v2) ==="
    )
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    owner_skey, owner_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    print(f"Owner: {owner_addr}")

    # Multiple pure-ADA UTxOs so we always have a clean collateral candidate
    # and a separate seed UTxO available.
    fund_split(ctx, owner_addr, 250_000_000, splits=5)

    seed_utxo = pick_seed_utxo(ctx, owner_addr)
    seed_tx_id = bytes(seed_utxo.input.transaction_id)
    seed_index = seed_utxo.input.index
    print(f"  seed UTxO: {seed_tx_id.hex()}#{seed_index}")

    # Build proxy + both logic scripts.
    proxy_compiled = load_compiled_code("proxy.proxy.mint")
    proxy_script = apply_proxy_params(proxy_compiled, seed_tx_id, seed_index)
    proxy_policy = plutus_script_hash(proxy_script)
    proxy_addr = script_address(proxy_script)
    print(f"Proxy policy id    : {proxy_policy.payload.hex()}")
    print(f"Proxy script addr  : {proxy_addr}")

    v1_compiled = load_compiled_code(
        "script_logic_v_1.script_logic_version_1_0.withdraw"
    )
    v1_script = apply_logic_params(v1_compiled, proxy_policy.payload)
    v1_hash = plutus_script_hash(v1_script)
    v1_reward = reward_address(v1_hash)
    print(f"Logic v1 hash      : {v1_hash.payload.hex()}")
    print(f"Logic v1 reward    : {v1_reward}")

    v2_compiled = load_compiled_code(
        "script_logic_v_2.script_logic_version_1_0.withdraw"
    )
    v2_script = apply_logic_params(v2_compiled, proxy_policy.payload)
    v2_hash = plutus_script_hash(v2_script)
    v2_reward = reward_address(v2_hash)
    print(f"Logic v2 hash      : {v2_hash.payload.hex()}")
    print(f"Logic v2 reward    : {v2_reward}")

    # ---- 1. INIT ----
    _init_tx, state_token = init_proxy(
        ctx, owner_skey, owner_addr,
        proxy_script, proxy_addr,
        seed_utxo, v1_hash, v1_reward,
    )

    # ---- 2. MINT via v1: token_name must equal PROXY_MINT_TOKEN ----
    v1_redeemer = LogicV1Redeemer(
        token_name=PROXY_MINT_TOKEN,
        password=b"Hello, World!",
    )
    mint_with_logic(
        ctx, owner_skey, owner_addr,
        proxy_script, proxy_addr, proxy_policy,
        state_token,
        v1_script, v1_reward, v1_redeemer,
        asset_name=PROXY_MINT_TOKEN,
    )

    # ---- 3. CHANGE_VERSION v1 → v2 ----
    # Need the v1 withdraw to authorise the swap; provide its redeemer.
    change_version(
        ctx, owner_skey, owner_addr,
        proxy_script, proxy_addr, proxy_policy,
        state_token,
        current_logic_script=v1_script,
        current_logic_reward_addr=v1_reward,
        current_logic_redeemer=v1_redeemer,
        next_logic_hash=v2_hash,
        next_logic_reward_addr=v2_reward,
        register_next_stake_cred=True,
    )

    # ---- 4. MINT via v2: asset_name must NOT equal invalid_token_name ----
    v2_redeemer = LogicV2Redeemer(invalid_token_name=b"InvalidToken")
    mint_with_logic(
        ctx, owner_skey, owner_addr,
        proxy_script, proxy_addr, proxy_policy,
        state_token,
        v2_script, v2_reward, v2_redeemer,
        asset_name=b"ProductV2",
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

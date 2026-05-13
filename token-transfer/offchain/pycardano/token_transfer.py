"""
token-transfer PyCardano scenario.

Demonstrates the full token-transfer lifecycle:
  1. Generate a fresh 24-word mnemonic and derive a new wallet.
  2. Fund the fresh wallet with 30 ADA from account 0 (shared test mnemonic).
  3. Mint 10 TestAsset tokens under an always-true PlutusV3 minting policy.
     Send them to the fresh wallet.
  4. Lock all 10 tokens at the parameterised script address
     (parameters: fresh_wallet_vkh, always_true_policy_id, b"TestAsset").
  5. Unlock back to the fresh wallet — receiver signs, outputs return all
     10 TestAsset units to the fresh wallet, no foreign tokens leave the
     script.

Run against a local yaci-devkit instance:
    python token_transfer.py
"""

import json
import os
import time
from fractions import Fraction
from pathlib import Path
from typing import Dict, Union

import requests as http_requests

# PyCardano core
from pycardano import (
    Address,
    AssetName,
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

# Always-true PlutusV3 minting policy (same as evolutionsdk reference).
# This is a minimal valid CBOR-wrapped flat UPLC script that always succeeds.
ALWAYS_TRUE_SCRIPT = PlutusV3Script(bytes.fromhex("46450101002499"))


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
    """Derive (signing_key, address) for the given account index from the shared test mnemonic."""
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


def wallet_from_mnemonic(mnemonic: str) -> tuple[ExtendedSigningKey, Address]:
    """Derive (signing_key, address) for account 0 from an arbitrary mnemonic."""
    hd = HDWallet.from_mnemonic(mnemonic)
    payment_hd = hd.derive_from_path("m/1852'/1815'/0'/0/0")
    stake_hd = hd.derive_from_path("m/1852'/1815'/0'/2/0")
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


def apply_token_transfer_params(
    compiled_code: bytes,
    receiver_vkh: bytes,
    policy_bytes: bytes,
    asset_name_bytes: bytes,
) -> PlutusV3Script:
    """
    Apply three parameters to the token_transfer script using uplc.

    Parameters are applied in the order declared in the validator:
      receiver (bytes, 28-byte VKH) → policy (bytes, 28-byte PolicyId) → assetName (bytes)

    Each uplc_apply wraps the program in an Apply node; the validator
    function is curried so successive applications saturate it.
    """
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(receiver_vkh))
    program = uplc_apply(program, PlutusByteString(policy_bytes))
    program = uplc_apply(program, PlutusByteString(asset_name_bytes))
    flat_cbor = uplc_flatten(program)
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
    for _ in range(timeout_s):
        try:
            utxos = ctx.utxos(str(address))
            if len(utxos) >= min_count:
                return utxos
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError(
        f"Timed out after {timeout_s}s waiting for >=={min_count} UTxO(s) at {address}"
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


def build_multiasset(policy_id: ScriptHash, token_name: bytes, amount: int) -> MultiAsset:
    """Build a MultiAsset containing a single asset."""
    return MultiAsset.from_primitive({policy_id.payload: {token_name: amount}})


# ---------------------------------------------------------------------------
# Scenario steps
# ---------------------------------------------------------------------------


def fund_fresh_wallet(
    ctx: YaciChainContext,
    fresh_addr: Address,
    lovelace: int = 30_000_000,
) -> None:
    """Step 2: Send lovelace from account 0 to the fresh wallet."""
    funder_skey, funder_addr = wallet_at(0)
    print(f"Funding fresh wallet {fresh_addr} with {lovelace} lovelace from account 0 ...")

    builder = TransactionBuilder(ctx)
    builder.add_input_address(funder_addr)
    builder.add_output(TransactionOutput(fresh_addr, lovelace))
    tx = builder.build_and_sign(
        signing_keys=[funder_skey],
        change_address=funder_addr,
    )
    submit_and_confirm(ctx, tx, fresh_addr, "FUND")


def mint_tokens(
    ctx: YaciChainContext,
    fresh_skey: ExtendedSigningKey,
    fresh_addr: Address,
    policy_id: ScriptHash,
    token_name: bytes = b"TestAsset",
    amount: int = 10,
) -> None:
    """
    Step 3: Mint `amount` of token_name under the always-true minting policy.
    Sends minted tokens to fresh_addr.
    """
    print(f"Minting {amount} {token_name!r} tokens (policy={policy_id.payload.hex()[:12]}...) ...")

    mint_multiasset = build_multiasset(policy_id, token_name, amount)

    builder = TransactionBuilder(ctx)
    builder.add_input_address(fresh_addr)
    builder.mint = mint_multiasset
    builder.add_minting_script(ALWAYS_TRUE_SCRIPT, redeemer=Redeemer(Unit()))
    # Send 2 ADA + tokens to the fresh wallet
    token_output = TransactionOutput(
        fresh_addr,
        Value(2_000_000, mint_multiasset),
    )
    builder.add_output(token_output)
    tx = builder.build_and_sign(
        signing_keys=[fresh_skey],
        change_address=fresh_addr,
    )
    submit_and_confirm(ctx, tx, fresh_addr, "MINT")


def lock_tokens(
    ctx: YaciChainContext,
    fresh_skey: ExtendedSigningKey,
    fresh_addr: Address,
    spend_script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
    token_name: bytes = b"TestAsset",
    amount: int = 10,
) -> None:
    """
    Step 4: Lock all tokens at the script address.
    The validator ignores the datum, so we lock without one.
    """
    print(f"Locking {amount} {token_name!r} tokens at script {s_addr} ...")

    token_multiasset = build_multiasset(policy_id, token_name, amount)

    # Wait for the fresh wallet to have the minted tokens
    # (find UTxO containing the tokens)
    for _ in range(90):
        try:
            utxos = ctx.utxos(str(fresh_addr))
            token_utxo = None
            for u in utxos:
                amt = u.output.amount
                if isinstance(amt, Value) and amt.multi_asset:
                    for sh, assets in amt.multi_asset.items():
                        if sh.payload == policy_id.payload:
                            token_utxo = u
                            break
                if token_utxo:
                    break
            if token_utxo:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise TimeoutError("Timed out waiting for minted token UTxO at fresh wallet")

    builder = TransactionBuilder(ctx)
    builder.add_input_address(fresh_addr)
    # Lock: 2 ADA + the 10 tokens at the script address (no datum required)
    builder.add_output(
        TransactionOutput(s_addr, Value(2_000_000, token_multiasset))
    )
    tx = builder.build_and_sign(
        signing_keys=[fresh_skey],
        change_address=fresh_addr,
    )
    submit_and_confirm(ctx, tx, s_addr, "LOCK")


def unlock_tokens(
    ctx: YaciChainContext,
    fresh_skey: ExtendedSigningKey,
    fresh_addr: Address,
    spend_script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
    token_name: bytes = b"TestAsset",
    amount: int = 10,
) -> None:
    """
    Step 5: Unlock tokens from the script back to the fresh wallet.

    - The receiver (fresh_addr payment VKH) must sign the transaction.
    - All token outputs return to the fresh wallet.
    - auto_ttl_offset=300 keeps the TTL within yaci-devkit's short epoch boundary.
    """
    print(f"Unlocking {amount} {token_name!r} tokens from script {s_addr} ...")

    # Find the script UTxO containing the tokens
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    # Pick the UTxO that holds our target token
    target_utxo = None
    for u in utxos:
        amt = u.output.amount
        if isinstance(amt, Value) and amt.multi_asset:
            for sh in amt.multi_asset:
                if sh.payload == policy_id.payload:
                    target_utxo = u
                    break
        if target_utxo:
            break
    if target_utxo is None:
        raise RuntimeError(f"Could not find token UTxO at script address {s_addr}")

    token_multiasset = build_multiasset(policy_id, token_name, amount)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target_utxo,
        script=spend_script,
        datum=None,          # UTxO locked without datum
        redeemer=Redeemer(Unit()),
    )
    builder.add_input_address(fresh_addr)
    # Return all tokens + 2 ADA to the fresh wallet
    builder.add_output(
        TransactionOutput(fresh_addr, Value(2_000_000, token_multiasset))
    )
    # Validator checks receiver VKH is in tx.extra_signatories
    builder.required_signers = [fresh_addr.payment_part]
    tx = builder.build_and_sign(
        signing_keys=[fresh_skey],
        change_address=fresh_addr,
        auto_ttl_offset=300,
    )
    submit_and_confirm(ctx, tx, fresh_addr, "UNLOCK")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== token-transfer scenario: generate → fund → mint → lock → unlock ===")

    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Step 1: Generate a fresh 24-word mnemonic and derive wallet
    # HDWallet.generate_mnemonic(strength=256) produces 24 words (256-bit entropy)
    fresh_mnemonic = HDWallet.generate_mnemonic(strength=256)
    print(f"Fresh mnemonic ({len(fresh_mnemonic.split())} words): {fresh_mnemonic[:40]}...")
    fresh_skey, fresh_addr = wallet_from_mnemonic(fresh_mnemonic)
    fresh_vkh = bytes(fresh_addr.payment_part)
    print(f"Fresh wallet: {fresh_addr}")
    print(f"Fresh wallet VKH: {fresh_vkh.hex()}")

    # Derive funder (account 0) info for display
    _, funder_addr = wallet_at(0)
    print(f"Funder (account 0): {funder_addr}")

    # Compute policy_id for the always-true minting policy
    policy_id = plutus_script_hash(ALWAYS_TRUE_SCRIPT)
    print(f"Always-true policy id: {policy_id.payload.hex()}")

    # Compute the parameterised spend script
    compiled_code = load_compiled_code("token_transfer.token_transfer.spend")
    spend_script = apply_token_transfer_params(
        compiled_code,
        receiver_vkh=fresh_vkh,
        policy_bytes=policy_id.payload,
        asset_name_bytes=b"TestAsset",
    )
    s_addr = script_address(spend_script)
    print(f"Token-transfer script address: {s_addr}")

    # Step 2: Fund fresh wallet with 30 ADA from account 0
    fund_fresh_wallet(ctx, fresh_addr, lovelace=30_000_000)

    # Step 3: Mint 10 TestAsset tokens to fresh wallet
    mint_tokens(
        ctx,
        fresh_skey=fresh_skey,
        fresh_addr=fresh_addr,
        policy_id=policy_id,
        token_name=b"TestAsset",
        amount=10,
    )

    # Step 4: Lock all 10 tokens at the script address
    lock_tokens(
        ctx,
        fresh_skey=fresh_skey,
        fresh_addr=fresh_addr,
        spend_script=spend_script,
        s_addr=s_addr,
        policy_id=policy_id,
        token_name=b"TestAsset",
        amount=10,
    )

    # Step 5: Unlock tokens back to the fresh wallet
    unlock_tokens(
        ctx,
        fresh_skey=fresh_skey,
        fresh_addr=fresh_addr,
        spend_script=spend_script,
        s_addr=s_addr,
        policy_id=policy_id,
        token_name=b"TestAsset",
        amount=10,
    )

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

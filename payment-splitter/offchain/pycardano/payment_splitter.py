"""
payment-splitter PyCardano scenario.

The validator is parameterised by a list of payee VKHs. When spending, the
script enforces:
  * every output's payment credential is one of the payees (no leakage), and
  * each payee receives an equal share (accounting for fee-payer change).

Because the fee-payer must itself be a payee (otherwise its change credential
is not in the payee set), this scenario uses account 0 as both funder and
payee[0]. The other four payees are accounts 1..4.

Run against a local yaci-devkit instance:
    python payment_splitter.py
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

from uplc.ast import PlutusByteString, PlutusList
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
PAYEE_COUNT = 5


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions
# ---------------------------------------------------------------------------


@dataclass
class SplitterDatum(PlutusData):
    CONSTR_ID = 0
    owner: bytes


@dataclass
class SplitterRedeemer(PlutusData):
    CONSTR_ID = 0
    message: bytes


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


def apply_payee_list(compiled_code: bytes, payee_vkhs: List[bytes]) -> PlutusV3Script:
    """Apply List<VerificationKeyHash> as a single parameter."""
    program = uplc_unflatten(compiled_code)
    plist = PlutusList(value=[PlutusByteString(v) for v in payee_vkhs])
    program = uplc_apply(program, plist)
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
    raise TimeoutError(f"TX {tx_id} not confirmed at {watch_address} within {timeout_s}s")


def set_tight_validity(ctx: YaciChainContext, builder: TransactionBuilder) -> None:
    tip = ctx.last_block_slot
    builder.validity_start = max(0, tip - 5)
    builder.ttl = tip + 60


# ---------------------------------------------------------------------------
# Scenario steps
# ---------------------------------------------------------------------------


def lock_ada(
    ctx: YaciChainContext,
    payer_skey: ExtendedSigningKey,
    payer_addr: Address,
    s_addr: Address,
    lovelace: int,
) -> str:
    """Lock funds at the splitter script with an InlineDatum carrying the
    payer's vkh as owner."""
    print(f"LOCK {lovelace} lovelace at {s_addr} ...")
    datum = SplitterDatum(owner=bytes(payer_addr.payment_part))
    builder = TransactionBuilder(ctx)
    builder.add_input_address(payer_addr)
    builder.add_output(TransactionOutput(s_addr, lovelace, datum=datum))
    tx = builder.build_and_sign(signing_keys=[payer_skey], change_address=payer_addr)
    return submit_and_confirm(ctx, tx, s_addr, "LOCK")


def payout(
    ctx: YaciChainContext,
    payer_skey: ExtendedSigningKey,
    payer_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    payee_addrs: List[Address],
    lock_tx_id: str,
) -> None:
    """Spend the script UTxO and distribute equal lovelace shares to all payees."""
    print(f"PAYOUT — splitting equal shares to {len(payee_addrs)} payees ...")
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    target = next(
        (u for u in utxos if str(u.input.transaction_id) == lock_tx_id), None
    )
    if target is None:
        raise RuntimeError(f"Locked UTxO from tx {lock_tx_id} not found at {s_addr}")

    total = int(target.output.amount.coin)
    share = total // len(payee_addrs)
    print(f"  Total at script: {total} lovelace → share={share} per payee")

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,  # inline datum on UTxO
        redeemer=Redeemer(SplitterRedeemer(message=b"Payday")),
    )
    builder.add_input_address(payer_addr)
    for addr in payee_addrs:
        builder.add_output(TransactionOutput(addr, share))
    builder.required_signers = [payer_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(signing_keys=[payer_skey], change_address=payer_addr)
    submit_and_confirm(ctx, tx, payee_addrs[1], "PAYOUT")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print(f"=== payment-splitter scenario: lock → payout (across {PAYEE_COUNT} payees) ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Payer is also payee[0] so its change output's credential is in the payee set.
    payer_skey, payer_addr = wallet_at(0)
    payee_addrs = [payer_addr]
    payee_vkhs = [bytes(payer_addr.payment_part)]
    for i in range(1, PAYEE_COUNT):
        _, addr = wallet_at(i)
        payee_addrs.append(addr)
        payee_vkhs.append(bytes(addr.payment_part))
    print(f"Payer/payee[0]: {payer_addr}")
    for i, a in enumerate(payee_addrs[1:], 1):
        print(f"  payee[{i}]    : {a}")

    compiled = load_compiled_code("payment_splitter.split_payment.spend")
    script = apply_payee_list(compiled, payee_vkhs)
    s_addr = script_address(script)
    print(f"Splitter script address: {s_addr}")

    lock_tx = lock_ada(ctx, payer_skey, payer_addr, s_addr, lovelace=50_000_000)
    payout(ctx, payer_skey, payer_addr, script, s_addr, payee_addrs, lock_tx)

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

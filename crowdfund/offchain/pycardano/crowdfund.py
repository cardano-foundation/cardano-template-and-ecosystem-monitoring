"""
crowdfund PyCardano scenario.

The validator is parameterised by (beneficiary, goal, deadline). It holds a
single script UTxO whose datum is a ledger of contributions
(`Pairs<VerificationKeyHash, Int>`). Three actions:

  DONATE   (0) — extend the ledger and grow the pot. Validator checks:
                  lovelace_in < lovelace_out_at_script AND
                  sum(new wallets) == new pot's lovelace.
  WITHDRAW (1) — beneficiary takes the pot after the deadline iff the goal
                  was met.
  RECLAIM  (2) — donors recover their stake after the deadline if the goal
                  failed. Supports batch reclaim across multiple signers.
                  The continuing-output datum on a partial reclaim is wrapped
                  in `Some(...)`.

Scenario exercises both terminal outcomes on two parameter sets:

  Campaign A: small goal — owner inits, donor donates, beneficiary withdraws.
  Campaign B: unreachable goal — donor reclaims after the deadline.

Run against a local yaci-devkit instance:
    python crowdfund.py
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

from uplc.ast import PlutusByteString, PlutusInteger
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
# Datum / Redeemer
# ---------------------------------------------------------------------------


@dataclass
class CrowdfundDatum(PlutusData):
    """
    Constr 0 with one field: `wallets : Pairs<VerificationKeyHash, Int>`.

    Aiken's `Pairs<K,V>` is encoded as a Plutus Data Map at the wire level,
    so a `Dict[bytes, int]` here matches the on-chain shape.
    """

    CONSTR_ID = 0
    wallets: Dict[bytes, int]


@dataclass
class SomeCrowdfundDatum(PlutusData):
    """
    `Some(CrowdfundDatum {..})` — Option wrapper required by the RECLAIM
    partial-reclaim branch (`expect Some(CrowdfundDatum { wallets }) = ...`).
    """

    CONSTR_ID = 0
    inner: CrowdfundDatum


@dataclass
class Donate(PlutusData):
    """Action::DONATE — Constr 0."""

    CONSTR_ID = 0


@dataclass
class Withdraw(PlutusData):
    """Action::WITHDRAW — Constr 1."""

    CONSTR_ID = 1


@dataclass
class Reclaim(PlutusData):
    """Action::RECLAIM — Constr 2."""

    CONSTR_ID = 2


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


def apply_crowdfund_params(
    compiled_code: bytes,
    beneficiary_vkh: bytes,
    goal: int,
    deadline_ms: int,
) -> PlutusV3Script:
    """Apply (beneficiary, goal, deadline)."""
    program = uplc_unflatten(compiled_code)
    program = uplc_apply(program, PlutusByteString(beneficiary_vkh))
    program = uplc_apply(program, PlutusInteger(goal))
    program = uplc_apply(program, PlutusInteger(deadline_ms))
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
# Slot / time helpers
# ---------------------------------------------------------------------------


def slot_config() -> tuple[int, int]:
    """Return (zero_time_ms, slot_length_ms) for yaci-devkit."""
    b = http_requests.get(f"{YACI_BASE}/v1/blocks/latest", timeout=10).json()
    zero_time_ms = (b["time"] - b["slot"]) * 1000
    return zero_time_ms, 1000


def slot_to_ms(slot: int, cfg: tuple[int, int]) -> int:
    z, sl = cfg
    return z + slot * sl


def ms_to_slot(ms: int, cfg: tuple[int, int]) -> int:
    z, sl = cfg
    return (ms - z) // sl


def wait_for_slot(ctx: YaciChainContext, target_slot: int) -> None:
    print(f"Waiting for tip to pass slot {target_slot} ...")
    for _ in range(300):
        tip = ctx.last_block_slot
        if tip > target_slot:
            return
        time.sleep(1)
    raise TimeoutError(f"Did not reach slot {target_slot}")


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


def init_campaign(
    ctx: YaciChainContext,
    owner_skey: ExtendedSigningKey,
    owner_addr: Address,
    s_addr: Address,
    initial_amount: int,
) -> str:
    """Create the script UTxO with `{owner_vkh: initial_amount}` ledger."""
    owner_vkh = bytes(owner_addr.payment_part)
    datum = CrowdfundDatum(wallets={owner_vkh: initial_amount})
    print(
        f"INIT campaign at {s_addr} with owner {owner_vkh.hex()[:12]}... "
        f"contributing {initial_amount} lovelace ..."
    )
    builder = TransactionBuilder(ctx)
    builder.add_input_address(owner_addr)
    builder.add_output(TransactionOutput(s_addr, initial_amount, datum=datum))
    tx = builder.build_and_sign(
        signing_keys=[owner_skey], change_address=owner_addr
    )
    return submit_and_confirm(ctx, tx, s_addr, "INIT")


def find_state_utxo(
    ctx: YaciChainContext, s_addr: Address, prev_tx_id: Optional[str] = None
) -> UTxO:
    utxos = wait_for_utxos(ctx, s_addr, min_count=1)
    if prev_tx_id is not None:
        for u in utxos:
            if str(u.input.transaction_id) == prev_tx_id:
                return u
        raise RuntimeError(f"UTxO from tx {prev_tx_id} not found at {s_addr}")
    # Fallback: first UTxO carrying an inline datum.
    for u in utxos:
        if u.output.datum is not None:
            return u
    raise RuntimeError(f"No datum-bearing UTxO at {s_addr}")


def read_wallets(utxo: UTxO) -> Dict[bytes, int]:
    """Extract the `wallets` map from the inline datum (un-wrapped form)."""
    d = utxo.output.datum
    if d is None:
        raise RuntimeError("UTxO has no datum")
    if hasattr(d, "cbor"):
        cbor = d.cbor
    elif hasattr(d, "to_cbor"):
        cbor = d.to_cbor()
    else:
        cbor = bytes(d)
    parsed = CrowdfundDatum.from_cbor(cbor)
    return dict(parsed.wallets)


def donate(
    ctx: YaciChainContext,
    donor_skey: ExtendedSigningKey,
    donor_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    amount: int,
) -> str:
    """Append `(donor_vkh, amount)` to the ledger and grow the pot."""
    print(f"DONATE {amount} lovelace from {donor_addr} ...")
    target = find_state_utxo(ctx, s_addr, prev_tx_id)
    wallets = read_wallets(target)
    donor_vkh = bytes(donor_addr.payment_part)
    wallets[donor_vkh] = wallets.get(donor_vkh, 0) + amount

    new_total = int(target.output.amount.coin) + amount
    new_datum = CrowdfundDatum(wallets=wallets)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Donate()),
    )
    builder.add_input_address(donor_addr)
    builder.add_output(TransactionOutput(s_addr, new_total, datum=new_datum))
    builder.required_signers = [donor_addr.payment_part]
    set_tight_validity(ctx, builder)
    tx = builder.build_and_sign(
        signing_keys=[donor_skey], change_address=donor_addr
    )
    return submit_and_confirm(ctx, tx, s_addr, "DONATE")


def withdraw(
    ctx: YaciChainContext,
    ben_skey: ExtendedSigningKey,
    ben_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    deadline_slot: int,
) -> None:
    """Beneficiary drains the campaign pot after the deadline."""
    print(f"WITHDRAW (beneficiary) — claiming pot after deadline ...")
    target = find_state_utxo(ctx, s_addr, prev_tx_id)

    tip = ctx.last_block_slot
    validity_start = max(deadline_slot + 1, tip - 5)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Withdraw()),
    )
    builder.add_input_address(ben_addr)
    builder.required_signers = [ben_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 60
    tx = builder.build_and_sign(
        signing_keys=[ben_skey], change_address=ben_addr
    )
    submit_and_confirm(ctx, tx, ben_addr, "WITHDRAW")


def reclaim(
    ctx: YaciChainContext,
    donor_skey: ExtendedSigningKey,
    donor_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    deadline_slot: int,
) -> None:
    """
    Single-donor reclaim. If `donor` is the only signer, validator deducts
    only their stake. If the resulting pot is empty, no continuing output is
    required; otherwise emit one wrapped in `Some(CrowdfundDatum(..))`.
    """
    donor_vkh = bytes(donor_addr.payment_part)
    print(f"RECLAIM for donor {donor_vkh.hex()[:12]}... ")
    target = find_state_utxo(ctx, s_addr, prev_tx_id)
    wallets = read_wallets(target)
    my_donation = wallets.get(donor_vkh)
    if not my_donation:
        raise RuntimeError("Donor has no recorded contribution to reclaim")

    pot_lovelace = int(target.output.amount.coin)
    remaining = pot_lovelace - my_donation
    new_wallets = {k: v for k, v in wallets.items() if k != donor_vkh}

    tip = ctx.last_block_slot
    validity_start = max(deadline_slot + 1, tip - 5)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Reclaim()),
    )
    builder.add_input_address(donor_addr)
    builder.required_signers = [donor_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 60

    if remaining > 0 and len(new_wallets) > 0:
        # Partial reclaim — rebuild the script UTxO with the donor removed.
        new_datum = SomeCrowdfundDatum(inner=CrowdfundDatum(wallets=new_wallets))
        builder.add_output(TransactionOutput(s_addr, remaining, datum=new_datum))
    tx = builder.build_and_sign(
        signing_keys=[donor_skey], change_address=donor_addr
    )
    submit_and_confirm(ctx, tx, donor_addr, "RECLAIM")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print(
        "=== crowdfund scenario: init+donate → withdraw (success) ; "
        "init+donate → reclaim (failed) ==="
    )
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Fresh wallets keep token balances clean and predictable.
    owner_skey, owner_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    ben_skey, ben_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    donor_skey, donor_addr = wallet_from_mnemonic(HDWallet.generate_mnemonic(strength=256))
    print(f"Owner       : {owner_addr}")
    print(f"Beneficiary : {ben_addr}")
    print(f"Donor       : {donor_addr}")

    fund(ctx, owner_addr, 30_000_000)
    fund(ctx, ben_addr, 30_000_000)
    fund(ctx, donor_addr, 30_000_000)

    ben_vkh = bytes(ben_addr.payment_part)
    compiled = load_compiled_code("crowdfund.crowdfund.spend")
    cfg = slot_config()
    print(f"Slot config: zero_time_ms={cfg[0]}, slot_length_ms={cfg[1]}")

    # -----------------------------------------------------------------------
    # Campaign A — small goal; gets met; beneficiary withdraws.
    # -----------------------------------------------------------------------
    print("\n--- Campaign A: goal=10 ADA; gets met; beneficiary WITHDRAW ---")
    goal_a = 10_000_000
    deadline_a_slot = ctx.last_block_slot + 15
    deadline_a_ms = slot_to_ms(deadline_a_slot, cfg)
    script_a = apply_crowdfund_params(compiled, ben_vkh, goal_a, deadline_a_ms)
    s_addr_a = script_address(script_a)
    print(f"Campaign A script address: {s_addr_a}")

    init_tx_a = init_campaign(ctx, owner_skey, owner_addr, s_addr_a, 6_000_000)
    donate_tx_a = donate(
        ctx, donor_skey, donor_addr, script_a, s_addr_a, init_tx_a, 5_000_000
    )
    wait_for_slot(ctx, deadline_a_slot)
    withdraw(
        ctx, ben_skey, ben_addr, script_a, s_addr_a, donate_tx_a, deadline_a_slot
    )

    # -----------------------------------------------------------------------
    # Campaign B — unreachable goal; donor reclaims.
    # -----------------------------------------------------------------------
    print("\n--- Campaign B: goal=100 ADA; never met; donor RECLAIM ---")
    goal_b = 100_000_000
    deadline_b_slot = ctx.last_block_slot + 15
    deadline_b_ms = slot_to_ms(deadline_b_slot, cfg)
    script_b = apply_crowdfund_params(compiled, ben_vkh, goal_b, deadline_b_ms)
    s_addr_b = script_address(script_b)
    print(f"Campaign B script address: {s_addr_b}")

    init_tx_b = init_campaign(ctx, owner_skey, owner_addr, s_addr_b, 5_000_000)
    donate_tx_b = donate(
        ctx, donor_skey, donor_addr, script_b, s_addr_b, init_tx_b, 4_000_000
    )
    wait_for_slot(ctx, deadline_b_slot)
    reclaim(
        ctx, donor_skey, donor_addr, script_b, s_addr_b, donate_tx_b, deadline_b_slot
    )

    print("\n=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

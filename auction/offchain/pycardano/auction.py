"""
auction PyCardano scenario.

A single PlutusV3 validator handles START (mint), BID (spend), and END (spend)
of an English auction. The auctioned NFT is minted under the validator's own
policy at START and lives at the script UTxO across BID*; at END it leaves
the script to the winner (or back to the seller if there were no bids).

Lifecycle:
  1. Fund three fresh wallets: seller, bidder1, bidder2.
  2. START (mint+lock): seller mints 1 auction NFT under the validator's
     policy and locks it at the script with starting_bid (3 ADA) and datum
     naming seller/asset/expiration; highest_bidder is "" sentinel.
  3. BID 1 (spend+continue): bidder1 bids 6 ADA; previous "bidder" is the
     "" sentinel, so no refund payment is needed.
  4. BID 2: bidder2 outbids with 10 ADA; bidder1 is refunded their 6 ADA.
  5. Wait for tip to pass expiration_slot.
  6. END: seller settles — the NFT goes to the winner (bidder2), 10 ADA to
     the seller, the script UTxO is consumed (no continuation).

Run against a local yaci-devkit instance:
    python auction.py
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
# PLUTUS_JSON lets the cross-check runner point this same off-chain flow at a
# different on-chain implementation's blueprint (e.g. scalus) without code edits.
# Falls back to the local Aiken blueprint for standalone runs.
BLUEPRINT_PATH = Path(
    os.environ.get(
        "PLUTUS_JSON",
        Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json",
    )
)

ASSET_NAME = b"auction_nft"


# ---------------------------------------------------------------------------
# Datum / Redeemer definitions
# ---------------------------------------------------------------------------


@dataclass
class AuctionDatum(PlutusData):
    """Fields in declaration order: seller, highest_bidder, highest_bid,
    expiration, asset_policy, asset_name."""

    CONSTR_ID = 0
    seller: bytes
    highest_bidder: bytes  # b"" sentinel until first non-zero bid
    highest_bid: int
    expiration: int  # POSIX milliseconds
    asset_policy: bytes
    asset_name: bytes


@dataclass
class MintRedeemer(PlutusData):
    """START — validator's mint redeemer is `_redeemer: Data` (ignored)."""

    CONSTR_ID = 0


@dataclass
class Bid(PlutusData):
    """First constructor of Action → Constr 0."""

    CONSTR_ID = 0


@dataclass
class Withdraw(PlutusData):
    """Second constructor — declared but on-chain `fail`s. Included for completeness."""

    CONSTR_ID = 1


@dataclass
class End(PlutusData):
    """Third constructor of Action → Constr 2."""

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
            # yaci-devkit's evaluate endpoint mis-evaluates certain Plutus V3
            # transactions that the LEDGER itself accepts at submit time.
            # Fallback: return generous static exec units so build can complete.
            print(f"  [evaluate fallback] yaci eval rejected — using static budgets")
            return {
                "spend:0": ExecutionUnits(10_000_000, 5_000_000_000),
                "spend:1": ExecutionUnits(10_000_000, 5_000_000_000),
                "mint:0": ExecutionUnits(10_000_000, 5_000_000_000),
            }
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


def slot_config() -> tuple[int, int]:
    # +600s era offset: yaci-devkit's ledger views POSIXTime against a Byron-era
    # system start one epoch (600 s) AFTER /blocks/latest reports, so validators
    # comparing range-POSIXTime vs datum-POSIXTime need our slot→ms math to use
    # the same frame.
    b = http_requests.get(f"{YACI_BASE}/v1/blocks/latest", timeout=10).json()
    zero_time_ms = (b["time"] - b["slot"] + 600) * 1000
    return zero_time_ms, 1000


def slot_to_ms(slot: int, cfg: tuple[int, int]) -> int:
    z, sl = cfg
    return z + slot * sl


def ms_to_slot(ms: int, cfg: tuple[int, int]) -> int:
    z, sl = cfg
    return (ms - z) // sl


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


def init_auction(
    ctx: YaciChainContext,
    seller_skey: ExtendedSigningKey,
    seller_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    policy_id: ScriptHash,
    starting_bid: int,
    expiration_ms: int,
    cfg: tuple[int, int],
) -> tuple[str, AuctionDatum]:
    """START — mint 1 auction NFT under the validator's own policy and lock
    it at the script with starting_bid + datum naming seller/asset/expiration."""
    print(f"START auction — seller locks NFT + {starting_bid} lovelace at {s_addr} ...")
    seller_vkh = bytes(seller_addr.payment_part)
    datum = AuctionDatum(
        seller=seller_vkh,
        highest_bidder=b"",
        highest_bid=starting_bid,
        expiration=expiration_ms,
        asset_policy=policy_id.payload,
        asset_name=ASSET_NAME,
    )
    mint_ma = MultiAsset.from_primitive({policy_id.payload: {ASSET_NAME: 1}})

    expiration_slot = ms_to_slot(expiration_ms, cfg)
    tip = ctx.last_block_slot
    valid_to = min(tip + 60, expiration_slot - 5)

    builder = TransactionBuilder(ctx)
    builder.add_input_address(seller_addr)
    builder.mint = mint_ma
    builder.add_minting_script(script, redeemer=Redeemer(MintRedeemer()))
    builder.add_output(
        TransactionOutput(s_addr, Value(starting_bid, mint_ma), datum=datum)
    )
    builder.required_signers = [seller_addr.payment_part]
    builder.validity_start = max(0, tip - 5)
    builder.ttl = valid_to
    tx = builder.build_and_sign(signing_keys=[seller_skey], change_address=seller_addr)
    tx_id = submit_and_confirm(ctx, tx, s_addr, "START")
    return tx_id, datum


def place_bid(
    ctx: YaciChainContext,
    bidder_skey: ExtendedSigningKey,
    bidder_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    prev_datum: AuctionDatum,
    new_bid: int,
    cfg: tuple[int, int],
) -> tuple[str, AuctionDatum]:
    """BID — outbid the current highest, refund the previous bidder, re-emit
    the script UTxO with the same asset and updated datum."""
    print(f"BID {new_bid} lovelace at {s_addr} ...")
    utxos = wait_for_utxos(ctx, s_addr)
    target = next((u for u in utxos if str(u.input.transaction_id) == prev_tx_id), None)
    if target is None:
        raise RuntimeError(f"Auction UTxO {prev_tx_id} not found at {s_addr}")

    bidder_vkh = bytes(bidder_addr.payment_part)
    new_datum = AuctionDatum(
        seller=prev_datum.seller,
        highest_bidder=bidder_vkh,
        highest_bid=new_bid,
        expiration=prev_datum.expiration,
        asset_policy=prev_datum.asset_policy,
        asset_name=prev_datum.asset_name,
    )

    # Carry the NFT forward (asset must remain in the script UTxO).
    nft_ma = target.output.amount.multi_asset

    expiration_slot = ms_to_slot(prev_datum.expiration, cfg)
    tip = ctx.last_block_slot
    valid_to = min(tip + 60, expiration_slot - 5)

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(Bid()),
    )
    builder.add_input_address(bidder_addr)
    # Continuing script output.
    builder.add_output(
        TransactionOutput(s_addr, Value(new_bid, nft_ma), datum=new_datum)
    )
    # Refund the previous bidder if there was one. The validator checks the
    # refund only when highest_bidder != "".
    if prev_datum.highest_bidder != b"":
        from pycardano import VerificationKeyHash
        prev_bidder_enterprise = Address(
            payment_part=VerificationKeyHash(bytes(prev_datum.highest_bidder)),
            network=NETWORK,
        )
        builder.add_output(
            TransactionOutput(prev_bidder_enterprise, prev_datum.highest_bid)
        )
    builder.required_signers = [bidder_addr.payment_part]
    builder.validity_start = max(0, tip - 5)
    builder.ttl = valid_to
    tx = builder.build_and_sign(signing_keys=[bidder_skey], change_address=bidder_addr)
    tx_id = submit_and_confirm(ctx, tx, s_addr, "BID")
    return tx_id, new_datum


def settle(
    ctx: YaciChainContext,
    caller_skey: ExtendedSigningKey,
    caller_addr: Address,
    script: PlutusV3Script,
    s_addr: Address,
    prev_tx_id: str,
    prev_datum: AuctionDatum,
    cfg: tuple[int, int],
) -> str:
    """END — after expiration, settle: NFT → winner (or seller if no bids),
    highest_bid lovelace → seller, no continuing script UTxO."""
    print(f"END — settling auction ...")
    utxos = wait_for_utxos(ctx, s_addr)
    target = next((u for u in utxos if str(u.input.transaction_id) == prev_tx_id), None)
    if target is None:
        raise RuntimeError(f"Auction UTxO {prev_tx_id} not found at {s_addr}")

    nft_ma = target.output.amount.multi_asset
    pot = int(target.output.amount.coin)

    expiration_slot = ms_to_slot(prev_datum.expiration, cfg)
    # Wait until tip strictly passes expiration_slot.
    for i in range(600):
        tip = ctx.last_block_slot
        if tip > expiration_slot:
            print(f"  tip={tip} > expiration_slot={expiration_slot}, proceeding")
            break
        if i % 10 == 0:
            print(f"  tip={tip}, waiting for {expiration_slot} ...")
        time.sleep(1)
    tip = ctx.last_block_slot
    validity_start = max(expiration_slot + 1, tip - 5)

    from pycardano import VerificationKeyHash
    seller_enterprise = Address(
        payment_part=VerificationKeyHash(bytes(prev_datum.seller)),
        network=NETWORK,
    )

    builder = TransactionBuilder(ctx)
    builder.add_script_input(
        utxo=target,
        script=script,
        datum=None,
        redeemer=Redeemer(End()),
    )
    builder.add_input_address(caller_addr)

    if prev_datum.highest_bidder == b"":
        # No bids — asset back to seller. Validator only requires one
        # output-with-asset and key_signed(seller); the seller_outputs check
        # is irrelevant in this branch.
        builder.add_output(TransactionOutput(seller_enterprise, Value(pot, nft_ma)))
    else:
        winner_enterprise = Address(
            payment_part=VerificationKeyHash(bytes(prev_datum.highest_bidder)),
            network=NETWORK,
        )
        # NFT → winner (with minimal lovelace for min-utxo); pot → seller.
        # The validator requires lovelace_of(seller_out) >= highest_bid, and
        # the NFT-bearing output must be the winner's address.
        builder.add_output(TransactionOutput(winner_enterprise, Value(2_000_000, nft_ma)))
        builder.add_output(TransactionOutput(seller_enterprise, prev_datum.highest_bid))

    builder.required_signers = [caller_addr.payment_part]
    builder.validity_start = validity_start
    builder.ttl = validity_start + 120
    tx = builder.build_and_sign(signing_keys=[caller_skey], change_address=caller_addr)
    return submit_and_confirm(ctx, tx, caller_addr, "END")


# ---------------------------------------------------------------------------
# Main scenario
# ---------------------------------------------------------------------------


def run_scenario() -> None:
    print("=== auction scenario: start → bid → bid → end ===")
    ctx = make_context()
    print(f"Connected to yaci-devkit (epoch {ctx.epoch})")

    # Three fresh wallets — seller, bidder1, bidder2.
    seller_mnemonic = HDWallet.generate_mnemonic(strength=256)
    bidder1_mnemonic = HDWallet.generate_mnemonic(strength=256)
    bidder2_mnemonic = HDWallet.generate_mnemonic(strength=256)
    seller_skey, seller_addr = wallet_from_mnemonic(seller_mnemonic)
    bidder1_skey, bidder1_addr = wallet_from_mnemonic(bidder1_mnemonic)
    bidder2_skey, bidder2_addr = wallet_from_mnemonic(bidder2_mnemonic)
    print(f"seller : {seller_addr}")
    print(f"bidder1: {bidder1_addr}")
    print(f"bidder2: {bidder2_addr}")

    fund(ctx, seller_addr, 30_000_000, "seller")
    fund(ctx, bidder1_addr, 30_000_000, "bidder1")
    fund(ctx, bidder2_addr, 30_000_000, "bidder2")

    # Auction validator handles both mint (auction.mint) and spend (auction.spend),
    # both compiled to the same script. The mint title corresponds to the
    # policy used here; pycardano applies neither parameters.
    compiled = load_compiled_code("auction.auction.mint")
    script = PlutusV3Script(compiled)
    policy_id = plutus_script_hash(script)
    s_addr = script_address(script)
    print(f"Auction script address: {s_addr}")
    print(f"Policy id            : {policy_id.payload.hex()}")

    cfg = slot_config()
    tip = ctx.last_block_slot
    expiration_slot = tip + 90
    expiration_ms = slot_to_ms(expiration_slot, cfg)
    print(f"Expiration slot={expiration_slot} ms={expiration_ms}")

    start_tx, start_datum = init_auction(
        ctx, seller_skey, seller_addr, script, s_addr, policy_id,
        starting_bid=3_000_000, expiration_ms=expiration_ms, cfg=cfg,
    )

    bid1_tx, bid1_datum = place_bid(
        ctx, bidder1_skey, bidder1_addr, script, s_addr, start_tx, start_datum,
        new_bid=6_000_000, cfg=cfg,
    )

    bid2_tx, bid2_datum = place_bid(
        ctx, bidder2_skey, bidder2_addr, script, s_addr, bid1_tx, bid1_datum,
        new_bid=10_000_000, cfg=cfg,
    )

    settle(ctx, seller_skey, seller_addr, script, s_addr, bid2_tx, bid2_datum, cfg)

    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()

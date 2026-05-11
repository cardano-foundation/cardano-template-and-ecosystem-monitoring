use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{from_script, from_verification_key}
use cardano/assets.{from_lovelace, lovelace_of, policies}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, find_input,
  placeholder,
}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after, valid_before}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use mocktail/virgin_validity_range.{mock_interval}

// English auction.
//
// The auctioned item (an NFT) is locked at the script address along with
// the current best bid in lovelace. Datum tracks state, redeemer drives the
// state machine: mint = START, then BID*, then END after expiration.

pub type AuctionDatum {
  seller: VerificationKeyHash,
  highest_bidder: VerificationKeyHash,
  // Empty bytes ("") = no bids yet. Sentinel chosen over Option to keep the
  // datum representation flat and easier to compare on-chain.
  highest_bid: Int,
  expiration: Int,
  asset_policy: ByteArray,
  asset_name: ByteArray,
}

pub type Action {
  BID
  WITHDRAW
  END
}

validator auction {
  // START — minting policy invocation creates the initial auction UTxO.
  // Enforces: one script output, seller signed, no bidder yet, bid >= 0,
  // expiration still in the future, and the auctioned asset is actually
  // present in the value. The minted token is the auction's identity.
  mint(_redeemer: Data, policy_id: ByteArray, transaction: Transaction) {
    let Transaction { outputs, extra_signatories, validity_range, .. } =
      transaction

    let outputs_to_script =
      list.filter(
        outputs,
        fn(output) { output.address == from_script(policy_id) },
      )

    expect list.length(outputs_to_script) == 1
    expect Some(auction_output) = list.head(outputs_to_script)
    let Output { datum, value, .. } = auction_output

    expect InlineDatum(datum_data) = datum
    expect AuctionDatum {
      seller,
      highest_bidder,
      highest_bid,
      expiration,
      asset_policy,
      asset_name: _asset_name,
    } = datum_data

    let has_auction_asset =
      list.has(
        list.map(policies(value), fn(policy) { policy }),
        asset_policy,
      )

    and {
      key_signed(extra_signatories, seller),
      highest_bidder == "",
      highest_bid >= 0,
      // valid_before(range, point) <=> range.upper_bound < point.
      // Anchoring expiration in datum (vs. as a script parameter) lets the
      // seller schedule each auction independently with the same script.
      valid_before(validity_range, expiration),
      has_auction_asset,
    }
  }

  spend(
    input_datum: Option<AuctionDatum>,
    redeemer: Action,
    spent_output_ref: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      transaction

    expect Some(spent_input) = find_input(inputs, spent_output_ref)
    let Output { value: input_value, address: script_address, .. } =
      spent_input.output

    expect Some(datum_data) = input_datum
    let AuctionDatum {
      seller,
      highest_bidder,
      highest_bid,
      expiration,
      asset_policy,
      asset_name,
    } = datum_data

    when redeemer is {
      // BID — rebuild the auction UTxO at the same script address with a
      // strictly higher bid, the asset still present, the previous bidder
      // refunded their stake, and seller/asset/expiration unchanged. Refund
      // happens in the same tx so we never need a separate "withdraw" path
      // for losing bidders.
      BID -> {
        let continuing_outputs =
          list.filter(
            outputs,
            fn(output) { output.address == script_address },
          )

        expect list.length(continuing_outputs) == 1
        expect Some(continuing_output) = list.head(continuing_outputs)
        let Output { value: out_value, datum: out_datum, .. } =
          continuing_output

        expect InlineDatum(out_datum_data) = out_datum
        expect new_datum: AuctionDatum = out_datum_data
        let new_highest = new_datum.highest_bidder
        let new_bid = new_datum.highest_bid

        let has_auction_asset_in =
          list.has(
            list.map(policies(input_value), fn(policy) { policy }),
            asset_policy,
          )

        let has_auction_asset_out =
          list.has(
            list.map(policies(out_value), fn(policy) { policy }),
            asset_policy,
          )

        // First bid has no previous bidder (sentinel ""), so nothing to
        // refund — checking would fail spuriously.
        let check_refund =
          if highest_bidder == "" {
            True
          } else {
            list.any(
              outputs,
              fn(output) {
                output.address == from_verification_key(highest_bidder) && lovelace_of(
                  output.value,
                ) == highest_bid
              },
            )
          }

        and {
          valid_before(validity_range, expiration),
          new_bid > highest_bid,
          key_signed(extra_signatories, new_highest),
          new_datum.seller == seller,
          new_datum.asset_policy == asset_policy,
          new_datum.asset_name == asset_name,
          has_auction_asset_in,
          has_auction_asset_out,
          check_refund,
          new_datum.expiration == expiration,
          // Non-decreasing — the bidder can pile on extra ada for the next
          // bidder to refund, but can't drain.
          lovelace_of(out_value) >= lovelace_of(input_value),
        }
      }

      // WITHDRAW is currently always-fail. Refunds happen inline in BID; a
      // dedicated withdraw path would need per-bidder accounting (e.g. a
      // separate refund UTxO per losing bidder).
      WITHDRAW -> fail

      // END — settles the auction after expiration. Asset goes to the
      // winner (or back to seller if no bids). Seller receives the highest
      // bid. No continuing auction UTxO — the script lifetime ends here.
      END -> {
        let outputs_with_asset =
          list.filter(
            outputs,
            fn(o) {
              list.has(
                list.map(policies(o.value), fn(policy) { policy }),
                asset_policy,
              )
            },
          )

        let addresses_mapped = list.map(outputs, fn(o) { o.address })

        expect Some(item_out) = list.head(outputs_with_asset)

        let check_no_continuing = !list.has(addresses_mapped, script_address)
        let check_asset_count = list.length(outputs_with_asset) == 1

        if highest_bidder == "" {
          let check_item_to_seller =
            item_out.address == from_verification_key(seller)

          and {
            // valid_after(range, point) <=> range.lower_bound > point.
            // I.e. the tx is forced to be valid only AFTER expiration.
            valid_after(validity_range, expiration),
            check_item_to_seller,
            check_no_continuing,
            check_asset_count,
            key_signed(extra_signatories, seller),
          }
        } else {
          let seller_outputs =
            list.filter(
              outputs,
              fn(o) { o.address == from_verification_key(seller) },
            )
          expect Some(seller_out) = list.head(seller_outputs)
          let check_seller_count = list.length(seller_outputs) >= 1

          let check_item_to_winner =
            item_out.address == from_verification_key(highest_bidder)
          let check_seller_payment =
            lovelace_of(seller_out.value) >= highest_bid

          and {
            valid_after(validity_range, expiration),
            check_no_continuing,
            check_asset_count,
            check_item_to_winner,
            check_seller_count,
            check_seller_payment,
          }
        }
      }
    }
  }

  // Reject any other purpose (e.g. stake withdrawals) to prevent the script
  // hash from authorising unintended actions.
  else(_) {
    fail
  }
}

// ============= TESTS =============

/// Test auction initialization via mint.
test should_init_auction() {
  let starting_bid = 3_000_000

  let initial_datum =
    AuctionDatum {
      seller: mock_pub_key_hash(1),
      highest_bidder: "",
      highest_bid: starting_bid,
      expiration: 1753939940,
      asset_policy: mock_policy_id(1),
      asset_name: "auction_nft",
    }

  let tx =
    Transaction {
      ..placeholder,
      outputs: [
        Output {
          address: from_script(mock_policy_id(1)),
          value:
            from_lovelace(starting_bid)
            |> assets.add(mock_policy_id(1), "auction_nft", 1),
          datum: InlineDatum(initial_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1752989540), Some(1752990020)),
    }

  auction.mint(NoDatum, mock_policy_id(1), tx)
}

/// Test bidding: new highest bidder replaces previous one.
test should_accept_higher_bid() {
  let starting_bid = 3_000_000

  let initial_datum =
    AuctionDatum {
      seller: mock_pub_key_hash(1),
      highest_bidder: "",
      highest_bid: starting_bid,
      expiration: 1753939940,
      asset_policy: mock_policy_id(1),
      asset_name: "auction_nft",
    }

  let new_bid = 6_000_000

  let updated_datum =
    AuctionDatum {
      seller: mock_pub_key_hash(1),
      highest_bidder: mock_pub_key_hash(2),
      highest_bid: new_bid,
      expiration: 1753939940,
      asset_policy: mock_policy_id(1),
      asset_name: "auction_nft",
    }

  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value:
              from_lovelace(starting_bid)
              |> assets.add(mock_policy_id(1), "auction_nft", 1),
            datum: InlineDatum(initial_datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(1)),
          value:
            from_lovelace(new_bid)
            |> assets.add(mock_policy_id(1), "auction_nft", 1),
          datum: InlineDatum(updated_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(2)],
      validity_range: mock_interval(Some(1753162820), Some(1753163120)),
    }

  auction.spend(
    Some(initial_datum),
    BID,
    mock_utxo_ref(1, 0),
    tx,
  )
}

/// Test settlement: seller gets ADA, winner gets item, auction closed.
test should_settle_auction() {
  let final_datum =
    AuctionDatum {
      seller: mock_pub_key_hash(1),
      highest_bidder: mock_pub_key_hash(2),
      highest_bid: 6_000_000,
      expiration: 1753939940,
      asset_policy: mock_policy_id(1),
      asset_name: "auction_nft",
    }

  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value:
              from_lovelace(6_000_000)
              |> assets.add(mock_policy_id(1), "auction_nft", 1),
            datum: InlineDatum(final_datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        // Item goes to winner (highest bidder).
        Output {
          address: from_verification_key(mock_pub_key_hash(2)),
          value:
            from_lovelace(1_000_000)
            |> assets.add(mock_policy_id(1), "auction_nft", 1),
          datum: NoDatum,
          reference_script: None,
        },
        // Seller receives winning bid in ADA.
        Output {
          address: from_verification_key(mock_pub_key_hash(1)),
          value: from_lovelace(6_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [],
      validity_range: mock_interval(Some(1754027120), Some(1754027420)),
    }

  auction.spend(
    Some(final_datum),
    END,
    mock_utxo_ref(1, 0),
    tx,
  )
}

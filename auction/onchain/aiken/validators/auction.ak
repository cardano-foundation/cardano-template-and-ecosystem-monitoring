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


/// Represents the state of an English auction.
///
/// The auction is for a single item (e.g. an NFT) that is held in the script
/// UTXO alongside the ADA bids.
///
/// Lifecycle:
/// 1. Seller initializes auction (no highest bidder yet).
/// 2. Bidders place higher bids; previous highest bidder becomes withdrawable.
/// 3. After expiration, seller or winner settles the auction.
pub type AuctionDatum {
  /// Seller who is offering the item.
  seller: VerificationKeyHash,
  /// Current highest bidder ("" if no bids yet).
  highest_bidder: VerificationKeyHash,
  /// Current highest bid in lovelace.
  highest_bid: Int,
  /// Auction expiration time (slot / POSIX time).
  expiration: Int,
  /// Policy id of the auctioned asset.
  asset_policy: ByteArray,
  /// Asset name of the auctioned asset.
  asset_name: ByteArray,
}

/// Actions on the auction validator.
///
/// - START: controlled by the minting policy (initial UTXO + item).
/// - BID: place a higher bid during the auction period.
/// - WITHDRAW: (to be extended) previous highest bidder reclaims their funds.
/// - END: settle after expiration – seller gets ADA, winner gets the item.
pub type Action {
  BID
  WITHDRAW
  END
}

/// Main auction validator
validator auction {

  /// Minting policy: Initializes a new auction.
  ///
  /// Responsibilities:
  /// - Mint the unique auction token / or use a known policy id.
  /// - Create a script output holding:
  ///   - The auctioned item.
  ///   - Starting bid (can be 0 or >0).
  ///   - Inline AuctionDatum with empty highest_bidder.
  mint(_redeemer: Data, policy_id: ByteArray, transaction: Transaction) {
    let Transaction { outputs, extra_signatories, validity_range, .. } =
      transaction

    // Find outputs going to this script address.
    let outputs_to_script =
      list.filter(
        outputs,
        fn(output) { output.address == from_script(policy_id) },
      )

    // Exactly one output to the script – the auction UTXO.
    expect list.length(outputs_to_script) == 1
    expect Some(auction_output) = list.head(outputs_to_script)
    let Output { datum, value, .. } = auction_output

    // Extract datum.
    expect InlineDatum(datum_data) = datum
    expect AuctionDatum {
      seller,
      highest_bidder,
      highest_bid,
      expiration,
      asset_policy,
      asset_name,
    } = datum_data

    // Check that the output actually holds the auctioned asset.
    let has_auction_asset =
      list.has(
        list.map(policies(value), fn(policy) { policy }),
        asset_policy,
      )

    and {
      // Seller must sign.
      key_signed(extra_signatories, seller)?,
      // No highest bidder at start.
      (highest_bidder == "")?,
      // Starting bid must be non-negative.
      (highest_bid >= 0)?,
      // Auction must not be expired at creation.
      valid_before(validity_range, expiration)?,
      // Script UTXO must contain the asset being auctioned.
      has_auction_asset?,
    }
  }

  /// Spending validator: controls auction state transitions.
  ///
  /// BID:
  /// - New bid must exceed current highest_bid.
  /// - Auction must not be expired.
  /// - Highest bidder must sign and deposit additional ADA.
  ///
  /// WITHDRAW:
  /// - Stubbed for now; full refund accounting can be added later.
  ///
  /// END:
  /// - Auction must be expired.
  /// - Seller receives ADA.
  /// - Winner receives the item.
  /// - Contract consumes the auction UTXO with no continuing auction output.
  spend(
    input_datum: Option<AuctionDatum>,
    redeemer: Action,
    spent_output_ref: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      transaction

    // Find the input being spent (auction UTXO).
    expect Some(spent_input) = find_input(inputs, spent_output_ref)
    let Output { value: input_value, address: script_address, .. } =
      spent_input.output

    // Extract current datum.
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
      BID -> {
        // Find continuing auction output at the same script address.
        let continuing_outputs =
          list.filter(
            outputs,
            fn(output) { output.address == script_address },
          )

        // Exactly one continuing auction output.
        expect list.length(continuing_outputs) == 1
        expect Some(continuing_output) = list.head(continuing_outputs)
        let Output { value: out_value, datum: out_datum, .. } =
          continuing_output

        // New state.
        expect InlineDatum(out_datum_data) = out_datum
        expect new_datum: AuctionDatum = out_datum_data
        let new_highest = new_datum.highest_bidder
        let new_bid = new_datum.highest_bid

        // Auctioned asset must stay locked in the script.
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

        and {
          // Auction not expired.
          valid_before(validity_range, expiration)?,
          // New bid strictly larger than current highest.
          (new_bid > highest_bid)?,
          // Highest bidder must sign.
          key_signed(extra_signatories, new_highest)?,
          // Seller and auctioned asset must remain unchanged.
          (new_datum.seller == seller)?,
          (new_datum.asset_policy == asset_policy)?,
          (new_datum.asset_name == asset_name)?,
          // Auctioned asset stays at script.
          has_auction_asset_in?,
          has_auction_asset_out?,
          // Datum expiration unchanged.
          (new_datum.expiration == expiration)?,
          // Value at script non-decreasing in lovelace.
          (lovelace_of(out_value) >= lovelace_of(input_value))?,
        }
      }

      WITHDRAW -> {
        // Minimal safety: forbid arbitrary WITHDRAW on main auction UTXO
        // until a full per-bidder refund pattern is implemented.
        fail
      }

      END -> {
        // Precompute helper lists outside `and {}`.
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

        let seller_outputs =
          list.filter(
            outputs,
            fn(o) { o.address == from_verification_key(seller) },
          )

        and {
          // 1. Auction expired.
          valid_after(validity_range, expiration)?,

          // 2. Exactly two outputs (winner + seller).
          (list.length(outputs) == 2)?,

          // 3. No continuing auction at script address.
          (not list.has(
            list.map(outputs, fn(o) { o.address }),
            script_address,
          ))?,

          // 4. Exactly one asset‑carrying output and one seller output.
          (list.length(outputs_with_asset) == 1)?,
          (list.length(seller_outputs) == 1)?,

          expect Some(item_out) = list.head(outputs_with_asset),
          expect Some(seller_out) = list.head(seller_outputs),

          // 5. Item goes to highest bidder.
          (item_out.address == from_verification_key(highest_bidder))?,

          // 6. Seller output has no datum.
          (seller_out.datum == NoDatum)?,

          // 7. Someone actually bid.
          (highest_bidder != "")?,
        }
      }
    }
  }

  /// Catch-all for any other redeemer - always fails.
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

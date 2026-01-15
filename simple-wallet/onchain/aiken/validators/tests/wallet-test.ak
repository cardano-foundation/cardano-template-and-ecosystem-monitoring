use cardano/assets.{from_asset}
use intent.{PaymentIntent}
use mocktail.{
  complete, mint, mocktail_tx, required_signer_hash, tx_out, tx_out_inline_datum,
}
use mocktail/virgin_address.{mock_pub_key_address, mock_script_address}
use mocktail/virgin_key_hash.{
  mock_policy_id, mock_pub_key_hash, mock_script_hash,
}
use wallet.{Burn, Mint}

const owner_pkh = mock_pub_key_hash(0)

const recipient_address = mock_pub_key_address(9, None)

const attacker = mock_pub_key_hash(1)

const wallet_policy = mock_policy_id(0)

const intent_script_hash = mock_script_hash(1)

const intent_script_addr = mock_script_address(1, None)

const intent_marker_assetname = "INTENT_MARKER"

test wallet_mint_valid() {
  let intent_datum =
    PaymentIntent {
      recipient: recipient_address,
      lovelace_amt: 5_000_000,
      data: "hello",
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> mint(True, 1, wallet_policy, intent_marker_assetname)
      |> tx_out(
          True,
          intent_script_addr,
          from_asset(wallet_policy, intent_marker_assetname, 1),
        )
      |> tx_out_inline_datum(True, intent_datum)
      |> complete()

  wallet.wallet.mint(owner_pkh, intent_script_hash, Mint, wallet_policy, tx)
}

test wallet_mint_wrong_signer() {
  let intent_datum =
    PaymentIntent {
      recipient: recipient_address,
      lovelace_amt: 5_000_000,
      data: "hello",
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, attacker)
      |> mint(True, 1, wallet_policy, intent_marker_assetname)
      |> tx_out(
          True,
          intent_script_addr,
          from_asset(wallet_policy, intent_marker_assetname, 1),
        )
      |> tx_out_inline_datum(True, intent_datum)
      |> complete()

  !wallet.wallet.mint(owner_pkh, intent_script_hash, Mint, wallet_policy, tx)
}

test wallet_mint_wrong_quantity() {
  let intent_datum =
    PaymentIntent {
      recipient: recipient_address,
      lovelace_amt: 5_000_000,
      data: "hello",
    }
  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> mint(True, 2, wallet_policy, intent_marker_assetname)
      |> tx_out(
          True,
          intent_script_addr,
          from_asset(wallet_policy, intent_marker_assetname, 1),
        )
      |> tx_out_inline_datum(True, intent_datum)
      |> complete()

  !wallet.wallet.mint(owner_pkh, intent_script_hash, Mint, wallet_policy, tx)
}

test wallet_burn_valid() {
  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> mint(True, -1, wallet_policy, intent_marker_assetname)
      |> complete()

  wallet.wallet.mint(owner_pkh, intent_script_hash, Burn, wallet_policy, tx)
}

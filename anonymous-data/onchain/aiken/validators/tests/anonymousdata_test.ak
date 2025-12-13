use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray.{concat}
use anonymousdata
use cardano/assets.{from_asset}
use cardano/transaction.{InlineDatum, Input, Output}
use mocktail.{
  add_input, complete, mint, mocktail_tx, required_signer_hash, tx_out,
  tx_out_inline_datum,
}
use mocktail/virgin_address.{mock_script_address}
use mocktail/virgin_key_hash.{
  mock_policy_id, mock_pub_key_hash, mock_script_hash,
}
use mocktail/virgin_output_reference.{mock_utxo_ref}

// --------------------------------------------------
// Shared test constants
// --------------------------------------------------

const nonce = "nonce-123"

const signer_pkh = mock_pub_key_hash(0)

const wrong_pkh = mock_pub_key_hash(1)

const script_hash = mock_script_hash(1)

const script_addr = mock_script_address(1, None)

const policy_id = mock_policy_id(0)

const id = blake2b_256(concat(signer_pkh, nonce))

// --------------------------------------------------
// Mint tests
// --------------------------------------------------

test mint_valid() {
  let tx =
    mocktail_tx()
      |> mint(True, 1, policy_id, script_hash)
      |> tx_out(True, script_addr, from_asset(policy_id, script_hash, 1))
      |> tx_out_inline_datum(True, id)
      |> complete()

  anonymousdata.anonymousdata.mint(script_hash, id, policy_id, tx)
}

test mint_invalid_wrong_datum() {
  let wrong_id = "wrong-id"

  let tx =
    mocktail_tx()
      |> mint(True, 1, policy_id, script_hash)
      |> tx_out(True, script_addr, from_asset(policy_id, script_hash, 1))
      |> tx_out_inline_datum(True, wrong_id)
      |> complete()

  !anonymousdata.anonymousdata.mint(script_hash, id, policy_id, tx)
}

// --------------------------------------------------
// Spend tests
// --------------------------------------------------

test spend_valid() {
  let oref = mock_utxo_ref(0, 0)

  let input =
    Input {
      output_reference: oref,
      output: Output {
        address: script_addr,
        value: from_asset(policy_id, script_hash, 1),
        datum: InlineDatum(id),
        reference_script: None,
      },
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, signer_pkh)
      |> complete()
      |> add_input(True, input)

  anonymousdata.anonymousdata.spend(script_hash, None, nonce, oref, tx)
}

test spend_invalid_wrong_nonce() {
  let wrong_nonce = "wrong-nonce"
  let oref = mock_utxo_ref(0, 0)

  let input =
    Input {
      output_reference: oref,
      output: Output {
        address: script_addr,
        value: from_asset(policy_id, script_hash, 1),
        datum: InlineDatum(id),
        reference_script: None,
      },
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, signer_pkh)
      |> complete()
      |> add_input(True, input)

  !anonymousdata.anonymousdata.spend(script_hash, None, wrong_nonce, oref, tx)
}

test spend_invalid_wrong_signer() {
  let oref = mock_utxo_ref(0, 0)

  let input =
    Input {
      output_reference: oref,
      output: Output {
        address: script_addr,
        value: from_asset(policy_id, script_hash, 1),
        datum: InlineDatum(id),
        reference_script: None,
      },
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, wrong_pkh)
      |> complete()
      |> add_input(True, input)

  !anonymousdata.anonymousdata.spend(script_hash, None, nonce, oref, tx)
}

use cardano/assets.{from_asset, from_lovelace}
use cardano/transaction.{InlineDatum, Input, Output}
use funds.{ExecuteTx, Withdraw}
use intent.{PaymentIntent}
use mocktail.{
  add_input, complete, mint, mocktail_tx, required_signer_hash, tx_out,
}
use mocktail/virgin_address.{mock_pub_key_address, mock_script_address}
use mocktail/virgin_key_hash.{mock_pub_key_hash, mock_script_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}

const owner_pkh = mock_pub_key_hash(0)

const attacker = mock_pub_key_hash(1)

const wallet_script_hash = mock_script_hash(3)

const funds_script_addr = mock_script_address(0, None)

const intent_script_addr = mock_script_address(1, None)

const intent_marker = "INTENT_MARKER"

const recipient_addr = mock_pub_key_address(3, None)

fn mk_funds_input(oref, amount) {
  Input {
    output_reference: oref,
    output: Output {
      address: funds_script_addr,
      value: from_lovelace(amount),
      datum: InlineDatum(""),
      reference_script: None,
    },
  }
}

fn mk_intent_ref_input(recipient, amount) {
  Input {
    output_reference: mock_utxo_ref(1, 0),
    output: Output {
      address: intent_script_addr,
      value: from_asset(wallet_script_hash, intent_marker, 1),
      datum: InlineDatum(
        PaymentIntent { recipient, lovelace_amt: amount, data: "hello" },
      ),
      reference_script: None,
    },
  }
}

// --------------------------------------------------
// ExecuteTx — VALID
// --------------------------------------------------

test funds_execute_valid() {
  let funds_oref = mock_utxo_ref(0, 0)

  let funds_input = mk_funds_input(funds_oref, 5_000_000)
  let intent_ref = mk_intent_ref_input(recipient_addr, 5_000_000)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> tx_out(True, recipient_addr, from_lovelace(5_000_000))
      |> mint(True, -1, wallet_script_hash, intent_marker)
      |> complete()
      |> add_input(True, funds_input)
      |> add_input(True, intent_ref)

  funds.funds.spend(
    owner_pkh,
    wallet_script_hash,
    None,
    ExecuteTx,
    funds_oref,
    tx,
  )
}

// --------------------------------------------------
// ExecuteTx — FAIL: missing burn
// --------------------------------------------------

test funds_execute_missing_burn() {
  let funds_oref = mock_utxo_ref(0, 0)

  let funds_input = mk_funds_input(funds_oref, 5_000_000)
  let intent_ref = mk_intent_ref_input(recipient_addr, 5_000_000)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> tx_out(True, recipient_addr, from_lovelace(5_000_000))
      |> complete()
      |> add_input(True, funds_input)
      |> add_input(True, intent_ref)

  !funds.funds.spend(
    owner_pkh,
    wallet_script_hash,
    None,
    ExecuteTx,
    funds_oref,
    tx,
  )
}

// --------------------------------------------------
// ExecuteTx — FAIL: wrong payout amount
// --------------------------------------------------

test funds_execute_wrong_amount() {
  let funds_oref = mock_utxo_ref(0, 0)

  let funds_input = mk_funds_input(funds_oref, 10_000_000)
  let intent_ref = mk_intent_ref_input(recipient_addr, 10_000_000)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> tx_out(True, recipient_addr, from_lovelace(11_000_000))
      // WRONG AMOUNT
      |> mint(True, -1, wallet_script_hash, intent_marker)
      |> complete()
      |> add_input(True, funds_input)
      |> add_input(True, intent_ref)

  !funds.funds.spend(
    owner_pkh,
    wallet_script_hash,
    None,
    ExecuteTx,
    funds_oref,
    tx,
  )
}

// --------------------------------------------------
// ExecuteTx — FAIL: wrong signer
// --------------------------------------------------

test funds_execute_wrong_signer() {
  let funds_oref = mock_utxo_ref(0, 0)

  let funds_input = mk_funds_input(funds_oref, 5_000_000)
  let intent_ref = mk_intent_ref_input(recipient_addr, 5_000_000)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, attacker)
      |> tx_out(True, recipient_addr, from_lovelace(5_000_000))
      |> mint(True, -1, wallet_script_hash, intent_marker)
      |> complete()
      |> add_input(True, funds_input)
      |> add_input(True, intent_ref)

  !funds.funds.spend(
    owner_pkh,
    wallet_script_hash,
    None,
    ExecuteTx,
    funds_oref,
    tx,
  )
}

// --------------------------------------------------
// Withdraw — VALID
// --------------------------------------------------

test funds_withdraw_valid() {
  let funds_oref = mock_utxo_ref(0, 0)
  let funds_input = mk_funds_input(funds_oref, 5_000_000)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> complete()
      |> add_input(True, funds_input)

  funds.funds.spend(
    owner_pkh,
    wallet_script_hash,
    None,
    Withdraw,
    funds_oref,
    tx,
  )
}

// --------------------------------------------------
// Withdraw — FAIL: wrong signer
// --------------------------------------------------

test funds_withdraw_wrong_signer() {
  let funds_oref = mock_utxo_ref(0, 0)
  let funds_input = mk_funds_input(funds_oref, 5_000_000)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, attacker)
      |> complete()
      |> add_input(True, funds_input)

  !funds.funds.spend(
    owner_pkh,
    wallet_script_hash,
    None,
    Withdraw,
    funds_oref,
    tx,
  )
}

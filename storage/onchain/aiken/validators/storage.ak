use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{Datum, OutputReference, Transaction}
use cardano/transaction as tx

pub type StorageDatum {
  owner: VerificationKeyHash,
  key: ByteArray,
  value: ByteArray,
}

pub type StorageAction {
  Set { key: ByteArray, value: ByteArray }
  Delete
}

fn has_any_datum(d: Datum) -> Bool {
  when d is {
    Datum.NoDatum -> False
    _ -> True
  }
}

pub fn spend(
  datum_opt: Option<StorageDatum>,
  action: StorageAction,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  // Require a typed datum (state must exist)
  expect Some(datum) = datum_opt

  // Authorization: owner must sign
  if !list.has(tx.extra_signatories, datum.owner) {
    False
  } else {
    // Find our own input to learn the script address (to reason about continuation outputs)
    expect Some(own_input) = tx.inputs |> tx.find_input(own_ref)
    let own_addr = own_input.output.address

    // Collect outputs that go back to the same script address
    let script_outputs =
      tx.outputs
        |> list.filter(fn(o) { o.address == own_addr })

    when action is {
      Set { .. } ->
        // Require continuation output with a datum (hash or inline)
        script_outputs
          |> list.any(fn(o) { has_any_datum(o.datum) })

      Delete ->
        // Require no continuation output (closing)
        script_outputs |> list.is_empty()
    }
  }
}

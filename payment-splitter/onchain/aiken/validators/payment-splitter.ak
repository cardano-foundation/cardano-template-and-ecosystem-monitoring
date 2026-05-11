use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/option
use cardano/address.{Address, VerificationKey}
use cardano/assets.{from_lovelace, lovelace_of}
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

// Pays a fixed list of payees an equal share of whatever this UTxO holds.
// Any payee can trigger settlement; outputs are constrained to the payee set
// and each payee's net (output - their own change) must be the same. The
// payees list is a script parameter, so each splitter group has its own hash.

pub type Datum {
  owner: VerificationKeyHash,
}

pub type Redeemer {
  message: ByteArray,
}

validator split_payment(script_hashes: List<VerificationKeyHash>) {
  spend(
    _datum: Option<Datum>,
    _redeemer: Redeemer,
    _spent_output: OutputReference,
    transaction: Transaction,
  ) {
    let payees =
      list.map(script_hashes, fn(script_hash) { VerificationKey(script_hash) })

    let Transaction { outputs, inputs, fee, .. } = transaction

    let output_credentials =
      list.map(outputs, fn(output) { output.address.payment_credential })

    // Closed-set rule: every distinct output credential must be a payee.
    // Prevents skimming to outside addresses.
    let has_no_additional_payees =
      list.difference(list.unique(output_credentials), payees) == []

    // For each payee, compute their "received" amount accounting for the
    // fact that the fee-payer is also one of the payees and gets change
    // back. Without this correction, the fee-payer would appear to receive
    // more and the equality check would always fail.
    let output_values =
      list.map(
        payees,
        fn(payee) {
          let payee_outputs =
            list.filter(
              outputs,
              fn(output) { output.address.payment_credential == payee },
            )

          let payee_output_sum =
            list.foldr(
              payee_outputs,
              0,
              fn(output, acc) { acc + lovelace_of(output.value) },
            )

          let payee_input =
            list.filter(
              inputs,
              fn(input) { input.output.address.payment_credential == payee },
            )

          let payee_input_sum =
            list.foldr(
              payee_input,
              0,
              fn(input, acc) { acc + lovelace_of(input.output.value) },
            )

          if payee_input_sum > 0 {
            // Fee-payer: subtract their original balance (minus fee) so we
            // measure only the share newly assigned to them.
            let change = payee_input_sum - fee
            payee_output_sum - change
          } else {
            payee_output_sum
          }
        },
      )
    let is_split_equally =
      list.all(
        output_values,
        fn(value) {
          let first_output_value = option.or_else(list.head(output_values), 0)
          value == first_output_value
        },
      )

    and {
      has_no_additional_payees,
      is_split_equally,
    }
  }

  else(_) {
    fail
  }
}

test should_split_equally() {
  let output_utxo =
    OutputReference {
      transaction_id: #"9ba4830b0cc39293e4666a99fcea97df262a7a89813e580b3b609771e5578a8e",
      output_index: 0,
    }
  let transaction =
    Transaction {
      ..placeholder,
      fee: 846025,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: #"672af664f96a3a8b99b886c076b376339b4ab3e6e440bdb67bd1290da05499fd",
            output_index: 0,
          },
          output: Output {
            address: Address {
              payment_credential: VerificationKey(
                #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
              ),
              stake_credential: None,
            },
            value: from_lovelace(41961442),
            datum: NoDatum,
            reference_script: None,
          },
        },
        Input {
          output_reference: OutputReference {
            transaction_id: #"9ce9a7a289bda4a543710e8bcdf7ecc2225210c499ba3dc335bf44f10277c6c5",
            output_index: 0,
          },
          output: Output {
            address: Address {
              payment_credential: VerificationKey(
                #"29ab97f98df7b26c5bfea0c68a727194eca3a14fe41bbe640bce1b8c",
              ),
              stake_credential: None,
            },
            value: from_lovelace(15000000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
            ),
            stake_credential: None,
          },
          value: from_lovelace(3000000),
          datum: NoDatum,
          reference_script: None,
        },
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
            ),
            stake_credential: None,
          },
          value: from_lovelace(41115417),
          datum: NoDatum,
          reference_script: None,
        },
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"3cea9e9f66482d00cdacd2087d27173d534b76ce7e3cc86e8a07f434",
            ),
            stake_credential: None,
          },
          value: from_lovelace(3000000),
          datum: NoDatum,
          reference_script: None,
        },
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"01f3855a5b36569e6ce1bdd8286f2b8b4e764b0e1a90a3e3d8357490",
            ),
            stake_credential: None,
          },
          value: from_lovelace(3000000),
          datum: NoDatum,
          reference_script: None,
        },
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"ce63d3ad78867ac366cabe17e3f15f76d05e0f99827986f92413c4d8",
            ),
            stake_credential: None,
          },
          value: from_lovelace(3000000),
          datum: NoDatum,
          reference_script: None,
        },
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"06cae4f91a7e73521cfb42a0dcfe0d90feff52ffa096467995bfb503",
            ),
            stake_credential: None,
          },
          value: from_lovelace(3000000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [
        #"52bd00e69e371daa373c021c3f4321356902016c320e41526e239406",
      ],
    }

  let script_hashes =
    [
      #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
      #"3cea9e9f66482d00cdacd2087d27173d534b76ce7e3cc86e8a07f434",
      #"01f3855a5b36569e6ce1bdd8286f2b8b4e764b0e1a90a3e3d8357490",
      #"ce63d3ad78867ac366cabe17e3f15f76d05e0f99827986f92413c4d8",
      #"06cae4f91a7e73521cfb42a0dcfe0d90feff52ffa096467995bfb503",
    ]

  let datum =
    Datum { owner: #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445" }

  let redeemer = Redeemer { message: "Payday" }

  split_payment.spend(
    script_hashes,
    Some(datum),
    redeemer,
    output_utxo,
    transaction,
  )
}

test payment_splitter_should_fail() fail {
  let output_utxo =
    OutputReference {
      transaction_id: #"9ba4830b0cc39293e4666a99fcea97df262a7a89813e580b3b609771e5578a8e",
      output_index: 0,
    }
  let transaction =
    Transaction {
      ..placeholder,
      fee: 846025,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: #"672af664f96a3a8b99b886c076b376339b4ab3e6e440bdb67bd1290da05499fd",
            output_index: 0,
          },
          output: Output {
            address: Address {
              payment_credential: VerificationKey(
                #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
              ),
              stake_credential: None,
            },
            value: from_lovelace(41961442),
            datum: NoDatum,
            reference_script: None,
          },
        },
        Input {
          output_reference: OutputReference {
            transaction_id: #"9ce9a7a289bda4a543710e8bcdf7ecc2225210c499ba3dc335bf44f10277c6c5",
            output_index: 0,
          },
          output: Output {
            address: Address {
              payment_credential: VerificationKey(
                #"29ab97f98df7b26c5bfea0c68a727194eca3a14fe41bbe640bce1b8c",
              ),
              stake_credential: None,
            },
            value: from_lovelace(16000000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
            ),
            stake_credential: None,
          },
          value: from_lovelace(8000000),
          datum: NoDatum,
          reference_script: None,
        },
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
            ),
            stake_credential: None,
          },
          value: from_lovelace(41115417),
          datum: NoDatum,
          reference_script: None,
        },
        Output {
          address: Address {
            payment_credential: VerificationKey(
              #"3cea9e9f66482d00cdacd2087d27173d534b76ce7e3cc86e8a07f434",
            ),
            stake_credential: None,
          },
          value: from_lovelace(8000000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [
        #"52bd00e69e371daa373c021c3f4321356902016c320e41526e239406",
      ],
    }

  let script_hashes =
    [
      #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445",
      #"3cea9e9f66482d00cdacd2087d27173d534b76ce7e3cc86e8a07f434",
      #"01f3855a5b36569e6ce1bdd8286f2b8b4e764b0e1a90a3e3d8357490",
      #"ce63d3ad78867ac366cabe17e3f15f76d05e0f99827986f92413c4d8",
      #"06cae4f91a7e73521cfb42a0dcfe0d90feff52ffa096467995bfb503",
    ]

  let datum =
    Datum { owner: #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445" }

  let redeemer = Redeemer { message: "Payday" }
  split_payment.spend(
    script_hashes,
    Some(datum),
    redeemer,
    output_utxo,
    transaction,
  )
}

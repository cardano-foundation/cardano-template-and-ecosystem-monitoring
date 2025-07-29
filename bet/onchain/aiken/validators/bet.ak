use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{from_script, from_verification_key}
use cardano/assets.{from_lovelace, lovelace_of, policies}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, find_input,
  placeholder,
}

pub type BetDatum {
  player1: VerificationKeyHash,
  player2: Option<VerificationKeyHash>,
  oracle: VerificationKeyHash,
}

pub type Action {
  JOIN
  ANNOUNCE_WINNER { winner: VerificationKeyHash }
}

validator bet {
  mint(_redeemer: Data, policy_id: ByteArray, self: Transaction) {
    let Transaction { outputs, extra_signatories, .. } = self
    let script_outputs =
      list.filter(
        outputs,
        fn(output) { output.address == from_script(policy_id) },
      )

    expect list.length(script_outputs) == 1
    expect Some(script_output) = list.head(script_outputs)
    let Output { datum, .. } = script_output

    expect InlineDatum(datum) = datum
    expect BetDatum { player1, player2, oracle } = datum

    and {
      list.has(extra_signatories, player1),
      player2 == None,
      oracle != player1,
    }
  }

  spend(
    updated_datum: Option<BetDatum>,
    redeemer: Action,
    spent_output: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, .. } = self

    expect Some(spent_input) = find_input(inputs, spent_output)
    let Output { value: old_value, datum, .. } = spent_input.output

    when redeemer is {
      JOIN -> {
        let token_part_of_input =
          list.has(
            list.map(policies(old_value), fn(policy) { from_script(policy) }),
            spent_input.output.address,
          )

        let script_outputs =
          list.filter(
            outputs,
            fn(output) { output.address == spent_input.output.address },
          )

        expect list.length(script_outputs) == 1
        expect Some(script_output) = list.head(script_outputs)
        let Output { value: new_value, .. } = script_output

        expect InlineDatum(datum) = datum
        expect datum: BetDatum = datum

        expect Some(updated_datum) = updated_datum
        expect Some(player2) = updated_datum.player2

        and {
          (datum.player2 == None)?,
          token_part_of_input?,
          list.has(extra_signatories, player2)?,
          (updated_datum.oracle == datum.oracle)?,
          (updated_datum.player1 == datum.player1)?,
          (player2 != datum.player1)?,
          (lovelace_of(new_value) == 2 * lovelace_of(old_value))?,
        }
      }
      ANNOUNCE_WINNER { winner } -> {
        expect InlineDatum(datum) = datum
        expect BetDatum { player1, player2, oracle } = datum

        expect list.length(outputs) == 1
        expect Some(output) = list.head(outputs)

        and {
          or {
            winner == player1,
            Some(winner) == player2,
          },
          (player2 != None)?,
          (updated_datum == None)?,
          (output.address == from_verification_key(winner))?,
          list.has(extra_signatories, oracle)?,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

test should_init_the_bet() {
  let datum =
    BetDatum {
      player1: #"52bd00e69e371daa373c021c3f4321356902016c320e41526e239406",
      player2: None,
      oracle: #"fb031506fe3c3fb03dcc55c471506fe3fb03dcc5563e41526e239406",
    }

  let policy_id = #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445"
  let transaction =
    Transaction {
      ..placeholder,
      outputs: [
        Output {
          address: from_script(policy_id),
          value: from_lovelace(3000000)
            |> assets.add(policy_id, "Bet_2152_Sports", 1),
          datum: InlineDatum(datum),
          reference_script: None,
        },
      ],
      extra_signatories: [
        #"52bd00e69e371daa373c021c3f4321356902016c320e41526e239406",
      ],
    }

  bet.mint(NoDatum, policy_id, transaction)
}

test join_the_bet() {
  let previous_datum =
    BetDatum {
      player1: #"52bd00e69e371daa373c021c3f4321356902016c320e41526e239406",
      player2: None,
      oracle: #"fb031506fe3c3fb03dcc55c471506fe3fb03dcc5563e41526e239406",
    }

  let datum =
    BetDatum {
      player1: #"52bd00e69e371daa373c021c3f4321356902016c320e41526e239406",
      player2: Some(#"06fabfb03dcc567e3c3fb03dcc0006fe3c3fb03d06fe3c3fb03d00cc"),
      oracle: #"fb031506fe3c3fb03dcc55c471506fe3fb03dcc5563e41526e239406",
    }

  let policy_id = #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445"
  let output_reference =
    OutputReference {
      transaction_id: #"8002ae51fb03dcc55c471506fe35bdedad9c886b0d09c2b8bc7cb000",
      output_index: 0,
    }
  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(policy_id),
            value: from_lovelace(3000000)
              |> assets.add(policy_id, "Bet_2152_Sports", 1),
            datum: InlineDatum(previous_datum),
            reference_script: None,
          },
          output_reference,
        },
      ],
      outputs: [
        Output {
          address: from_script(policy_id),
          value: from_lovelace(6000000)
            |> assets.add(policy_id, "Bet_2152_Sports", 1),
          datum: InlineDatum(datum),
          reference_script: None,
        },
      ],
      extra_signatories: [
        #"06fabfb03dcc567e3c3fb03dcc0006fe3c3fb03d06fe3c3fb03d00cc",
      ],
    }

  let redeemer: Action = JOIN

  bet.spend(Some(datum), redeemer, output_reference, transaction)
}

test payout_winner() {
  let previous_datum =
    BetDatum {
      player1: #"52bd00e69e371daa373c021c3f4321356902016c320e41526e239406",
      player2: Some(#"06fabfb03dcc567e3c3fb03dcc0006fe3c3fb03d06fe3c3fb03d00cc"),
      oracle: #"fb031506fe3c3fb03dcc55c471506fe3fb03dcc5563e41526e239406",
    }

  let policy_id = #"92e2ae51fb03dcc55c471506fe35bdedad9c266b0d09c2b8bc7cb445"
  let output_reference =
    OutputReference {
      transaction_id: #"8002ae51fb03dcc55c471506fe35bdedad9c886b0d09c2b8bc7cb000",
      output_index: 0,
    }
  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(policy_id),
            value: from_lovelace(6000000)
              |> assets.add(policy_id, "Bet_2152_Sports", 1),
            datum: InlineDatum(previous_datum),
            reference_script: None,
          },
          output_reference,
        },
      ],
      outputs: [
        Output {
          address: from_verification_key(
            #"06fabfb03dcc567e3c3fb03dcc0006fe3c3fb03d06fe3c3fb03d00cc",
          ),
          value: from_lovelace(6000000)
            |> assets.add(policy_id, "Bet_2152_Sports", 1),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [
        #"fb031506fe3c3fb03dcc55c471506fe3fb03dcc5563e41526e239406",
      ],
    }
  let redeemer: Action =
    ANNOUNCE_WINNER {
      winner: #"06fabfb03dcc567e3c3fb03dcc0006fe3c3fb03d06fe3c3fb03d00cc",
    }
  bet.spend(None, redeemer, output_reference, transaction)
}

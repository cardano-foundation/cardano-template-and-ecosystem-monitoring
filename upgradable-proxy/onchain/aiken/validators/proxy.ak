use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash, VerificationKeyHash, sha3_256}
use aiken/primitive/bytearray.{concat}
use aiken/primitive/int
use aiken/primitive/string
use cardano/address.{Script, from_script}
use cardano/assets.{policies, tokens}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
}
use cocktail/vodka_extra_signatories.{key_signed}

pub type ProxyMintRedeemer {
  MINT
  INIT
}

pub type ProxyDatum {
  script_pointer: ScriptHash,
  script_owner: VerificationKeyHash,
}

pub type ProxySpendRedeemer {
  SPEND
  UPDATE
}

validator proxy(utxo_ref: OutputReference) {
  mint(
    redeemer: ProxyMintRedeemer,
    policy_id: ByteArray,
    transaction: Transaction,
  ) {
    let Transaction {
      inputs,
      outputs,
      extra_signatories,
      mint,
      withdrawals,
      reference_inputs,
      ..
    } = transaction

    let state_token_name =
      sha3_256(
        concat(
          utxo_ref.transaction_id,
          string.to_bytearray(int.to_string(utxo_ref.output_index)),
        ),
      )

    when redeemer is {
      INIT -> {
        // Initialization can only run once
        expect
          list.any(inputs, fn(input) { input.output_reference == utxo_ref })
        // Collect all outputs locked at this script and holding the policy token
        let outputs_to_script =
          list.filter(
            outputs,
            fn(output) {
              output.address == from_script(policy_id) && list.has(
                policies(output.value),
                policy_id,
              )
            },
          )

        // There should be just one output going to this script
        expect Some(output) = list.head(outputs_to_script)
        let Output { datum, .. } = output
        expect InlineDatum(datum) = datum
        expect ProxyDatum { script_owner, .. } = datum

        // token name must be state_token_name and there should be just 1 token minted
        let minted_tokens =
          mint
            |> tokens(policy_id)
            |> dict.to_pairs()

        let token_amount = list.length(minted_tokens)
        expect Some(token_name) = minted_tokens |> pairs.keys |> list.head

        and {
          (token_amount == 1)?,
          (list.length(outputs_to_script) == 1)?,
          (token_name == state_token_name)?,
          key_signed(extra_signatories, script_owner)?,
        }
      }
      MINT -> {
        // token name is not allowed to be state_token_name
        let minted_tokens =
          mint
            |> tokens(policy_id)
            |> dict.to_pairs()
            |> pairs.keys

        // reference input with pointer token should be around
        let script_pointer_refs =
          list.filter(
            reference_inputs,
            fn(ref_in) {
              let ref_tokens =
                ref_in.output.value
                  |> tokens(policy_id)
                  |> dict.to_pairs()
                  |> pairs.keys

              let has_state_token = list.has(ref_tokens, state_token_name)

              and {
                has_state_token,
                ref_in.output.address == from_script(policy_id),
              }
            },
          )

        expect Some(script_pointer_ref) = list.head(script_pointer_refs)
        expect InlineDatum(datum) = script_pointer_ref.output.datum
        expect proxy_datum: ProxyDatum = datum

        // withdrawal from script with upgradeable logic must be part of the transaction
        let included_withdrawal_scripts = pairs.keys(withdrawals)

        and {
          !list.has(minted_tokens, state_token_name)?,
          list.has(
            included_withdrawal_scripts,
            Script(proxy_datum.script_pointer),
          )?,
        }
      }
    }
  }

  spend(
    _datum: Option<Data>,
    redeemer: ProxySpendRedeemer,
    spent_output_ref: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction {
      inputs,
      outputs,
      extra_signatories,
      reference_inputs,
      withdrawals,
      ..
    } = transaction

    // Find the input being spent
    expect Some(spent_input) = find_input(inputs, spent_output_ref)
    // Getting the policy of tokens produced by this script
    expect Script(policy_id) = spent_input.output.address.payment_credential

    let Output { value, datum: input_datum, .. } = spent_input.output
    let script_tokens_in_input =
      value
        |> tokens(policy_id)
        |> dict.to_pairs()
        |> pairs.keys

    let state_token_name =
      sha3_256(
        concat(
          utxo_ref.transaction_id,
          string.to_bytearray(int.to_string(utxo_ref.output_index)),
        ),
      )

    let state_token_still_locked =
      !list.has(script_tokens_in_input, state_token_name)

    when redeemer is {
      UPDATE -> {
        // There must be an output, that has the state token with an updated state
        expect Some(script_output) =
          list.find(
            outputs,
            fn(output) {
              let ref_tokens =
                output.value
                  |> tokens(policy_id)
                  |> dict.to_pairs()
                  |> pairs.keys

              let has_state_token = list.has(ref_tokens, state_token_name)

              and {
                has_state_token,
                output.address == from_script(policy_id),
              }
            },
          )

        let Output { datum: output_datum, .. } = script_output

        expect InlineDatum(output_datum) = output_datum
        expect ProxyDatum {
          script_pointer: _script_pointer,
          script_owner: new_script_owner,
        } = output_datum

        expect InlineDatum(input_datum) = input_datum
        expect ProxyDatum {
          script_pointer: _script_pointer,
          script_owner: old_script_owner,
        } = input_datum

        and {
          !state_token_still_locked,
          key_signed(extra_signatories, old_script_owner),
          // if the script owner changed, both, old and new owner need to sign the transaction
          or {
            new_script_owner == old_script_owner,
            key_signed(extra_signatories, new_script_owner),
          },
        }
      }
      SPEND -> {
        // reference input with pointer token should be around
        let script_pointer_refs =
          list.filter(
            reference_inputs,
            fn(ref_in) {
              let ref_tokens =
                ref_in.output.value
                  |> tokens(policy_id)
                  |> dict.to_pairs()
                  |> pairs.keys

              let has_state_token = list.has(ref_tokens, state_token_name)

              and {
                has_state_token,
                ref_in.output.address == from_script(policy_id),
              }
            },
          )

        expect Some(script_pointer_ref) = list.head(script_pointer_refs)
        expect InlineDatum(datum) = script_pointer_ref.output.datum
        expect proxy_datum: ProxyDatum = datum

        // withdrawal from script with upgradeable logic must be part of the transaction
        let included_withdrawal_scripts = pairs.keys(withdrawals)

        and {
          state_token_still_locked,
          list.has(
            included_withdrawal_scripts,
            Script(proxy_datum.script_pointer),
          ),
        }
      }
    }
  }

  else(_) {
    fail
  }
}

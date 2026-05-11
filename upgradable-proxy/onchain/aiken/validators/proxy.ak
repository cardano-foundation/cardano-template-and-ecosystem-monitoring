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

// Upgradable proxy. The state UTxO holds a unique state-token (name derived
// from the seed utxo_ref so the script hash is one-of-a-kind) and its datum
// points to the *current* logic script. To run business logic, callers must
// include a withdrawal from the pointed script — that withdrawal triggers
// whichever logic version is wired in today. UPDATE rotates the pointer;
// every other interaction routes through SPEND/MINT and the live logic.

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

    // State token name = sha3_256(seed). Deterministic, unforgeable, and
    // unique per (utxo_ref) because that UTxO can only be spent once.
    let state_token_name =
      sha3_256(
        concat(
          utxo_ref.transaction_id,
          string.to_bytearray(int.to_string(utxo_ref.output_index)),
        ),
      )

    when redeemer is {
      // INIT — bootstrap the proxy: consume the seed (one-shot), mint the
      // single state token, lock it to the proxy with the initial datum.
      // Owner must sign so a third party can't grief the seed-spender.
      INIT -> {
        expect
          list.any(inputs, fn(input) { input.output_reference == utxo_ref })
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

        expect Some(output) = list.head(outputs_to_script)
        let Output { datum, .. } = output
        expect InlineDatum(datum) = datum
        expect ProxyDatum { script_owner, .. } = datum

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
      // MINT — issue domain tokens under this proxy. Two guards:
      //   1. Cannot mint another state_token (would clone the proxy).
      //   2. Must invoke a withdrawal from the pointed logic script, so
      //      whatever rules that logic enforces apply to the mint.
      MINT -> {
        let minted_tokens =
          mint
            |> tokens(policy_id)
            |> dict.to_pairs()
            |> pairs.keys

        // Read the current pointer from a reference input — we don't spend
        // the state UTxO during MINT, just observe it.
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

        let included_withdrawal_scripts = pairs.keys(withdrawals)

        and {
          (!list.has(minted_tokens, state_token_name))?,
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

    expect Some(spent_input) = find_input(inputs, spent_output_ref)
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

    // Inverted: true when this UTxO does NOT carry the state token (i.e. a
    // regular asset UTxO under this script). UPDATE requires the state UTxO,
    // SPEND requires a non-state UTxO — see each branch below.
    let state_token_still_locked =
      !list.has(script_tokens_in_input, state_token_name)

    when redeemer is {
      // UPDATE — rotate the logic pointer / owner. Must be applied to the
      // state UTxO (state_token_still_locked == False), continue the state
      // token forward, and be signed by the current owner. If owner rotates,
      // the new owner must co-sign to opt-in.
      UPDATE -> {
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
          or {
            new_script_owner == old_script_owner,
            key_signed(extra_signatories, new_script_owner),
          },
        }
      }
      // SPEND — withdraw a regular (non-state) UTxO from the proxy. Must NOT
      // be the state UTxO (state_token_still_locked == True), and must
      // invoke a withdrawal from the currently pointed logic script — same
      // delegation mechanism as MINT.
      SPEND -> {
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

use aiken/collection/dict.{is_empty}
use aiken/collection/list
use cardano/address.{Credential, Script}
use cardano/assets.{tokens}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{Input, Output, Redeemer, Transaction}

// Logic v1 of the upgradable proxy. Lives as a withdraw script, not a spend
// script: proxy.ak invokes it indirectly by requiring a withdrawal from this
// credential, which forces this validator to run. Replacing the logic is a
// matter of swapping the proxy datum's pointer to a different script hash.
// This v1 enforces: mints use a specific token name; spends require a
// hard-coded password. v2 relaxes both.

pub type MyRedeemer {
  token_name: ByteArray,
  password: ByteArray,
}

fn validate_mint(
  redeemer: MyRedeemer,
  policy_id: ByteArray,
  transaction: Transaction,
  invoke_mint_validation: Bool,
) {
  if invoke_mint_validation {
    let Transaction { mint, .. } = transaction

    expect [Pair(asset_name, amount)] =
      mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

    and {
      (amount == 1)?,
      (asset_name == redeemer.token_name)?,
    }
  } else {
    True
  }
}

fn validate_spend(
  redeemer: MyRedeemer,
  _policy_id: ByteArray,
  _transaction: Transaction,
  invoke_spend_validation: Bool,
) {
  if invoke_spend_validation {
    // Toy password gate — example only; a real logic version would check
    // signatures, oracle state, etc.
    redeemer.password == "Hello, World!"
  } else {
    True
  }
}

validator script_logic_version_1_0(proxy_policy_id: ByteArray) {
  // Withdraw entry-point. We only validate the proxy's mint/spend if the tx
  // actually touches them — otherwise this script can run on unrelated
  // withdrawals (e.g. zero-ada certificates) without forcing constraints.
  withdraw(redeemer: MyRedeemer, _account: Credential, transaction: Transaction) {
    let Transaction { mint, inputs, .. } = transaction

    let invoke_mint_validation =
      !(mint
        |> tokens(proxy_policy_id)
        |> is_empty)

    let invoke_spend_validation =
      list.any(
        inputs,
        fn(input) {
          input.output.address.payment_credential == Script(proxy_policy_id)
        },
      )

    and {
      // At least one of mint/spend must be present, otherwise this script
      // was attached for no reason and we refuse to validate vacuously.
      or {
        invoke_mint_validation,
        invoke_spend_validation,
      }?,
      validate_mint(
        redeemer,
        proxy_policy_id,
        transaction,
        invoke_mint_validation,
      )?,
      validate_spend(
        redeemer,
        proxy_policy_id,
        transaction,
        invoke_spend_validation,
      )?,
    }
  }

  // Required to register this script as a withdrawable credential.
  // Cardano needs a `publish` clause that accepts RegisterCredential or the
  // stake-credential registration cert will be rejected.
  publish(_redeemer: Redeemer, certificate: Certificate, _self: Transaction) {
    when certificate is {
      RegisterCredential { credential: _credential, deposit: _deposit } -> True
      _ -> fail
    }
  }

  else(_) {
    fail
  }
}

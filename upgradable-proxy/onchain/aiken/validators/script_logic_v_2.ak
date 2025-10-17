use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId, tokens}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{Input, Output, Redeemer, Transaction}

// Password is not needed anymore
// Tokenname shouldn't be used anymore
pub type MyRedeemer {
  invalid_token_name: ByteArray,
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

    // Changed mint logic
    and {
      amount == 1,
      asset_name != redeemer.invalid_token_name,
    }
  } else {
    True
  }
}

// It's always fine to spend from the contract (should not work for the state token)
fn validate_spend(
  _redeemer: MyRedeemer,
  _policy_id: ByteArray,
  _transaction: Transaction,
  _invoke_spend_validation: Bool,
) {
  True
}

validator script_logic_version_1_0(proxy_policy_id: PolicyId) {
  withdraw(redeemer: MyRedeemer, _account: Credential, transaction: Transaction) {
    let Transaction { mint, inputs, .. } = transaction

    let invoke_mint_validation =
      mint
        |> tokens(proxy_policy_id)
        |> dict.to_pairs()
        |> pairs.has_key(proxy_policy_id)

    let invoke_spend_validation =
      list.any(
        inputs,
        fn(input) {
          input.output.address.payment_credential == Script(proxy_policy_id)
        },
      )

    and {
      or {
        invoke_mint_validation,
        invoke_spend_validation,
      },
      validate_mint(
        redeemer,
        proxy_policy_id,
        transaction,
        invoke_mint_validation,
      ),
      validate_spend(
        redeemer,
        proxy_policy_id,
        transaction,
        invoke_spend_validation,
      ),
    }
  }

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

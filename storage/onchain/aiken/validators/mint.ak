// One-shot minting policy for the audit registry. The seed UTxO parameter
// makes the script hash unique per-snapshot — once that UTxO is spent, the
// policy can never run again, so each registry entry is provably singleton.
// The NFT's asset name = sha2_256(snapshot_id) so duplicates collide
// even if a caller tries to re-use a snapshot_id.

use aiken/collection/list
use aiken/crypto
use cardano/assets.{flatten}
use cardano/transaction.{Transaction, OutputReference, InlineDatum, Output}
use cardano/address
use storage/types.{MintRedeemer, RegistryDatum, snapshot_type_eq}
use storage/utils.{consumes_utxo, is_valid_commitment_hash, is_valid_snapshot_id}

validator mint(seed_utxo: OutputReference, validator_hash: ByteArray) {
  mint(redeemer: MintRedeemer, policy_id: ByteArray, tx: Transaction) {
    // One-shot guarantee: this seed_utxo can only be spent once on-chain.
    let consumes_seed = consumes_utxo(tx.inputs, seed_utxo)

    // Asset name is derived from snapshot_id — caller can't pick it.
    // Two registrations of the same snapshot_id would conflict on the token.
    let expected_asset_name = crypto.sha2_256(redeemer.snapshot_id)
    let mint_list = tx.mint |> flatten()

    let our_mints = list.filter(
      mint_list,
      fn(item) { item.1st == policy_id }
    )

    let valid_mint = when our_mints is {
      [(_, asset_name, qty)] -> asset_name == expected_asset_name && qty == 1
      _ -> False
    }

    // Pin the token to the immutable storage script. Without this the mint
    // would succeed but the UTxO could land at a wallet and be transferred,
    // breaking the "permanent record" invariant.
let validator_address_credential = address.Script(validator_hash)

    let outputs_to_validator = list.filter(
      tx.outputs,
      fn(output) {
        output.address.payment_credential == validator_address_credential
      }
    )

    // The datum must match the redeemer field-for-field. Validating shape
    // at mint is the only chance — once locked the UTxO can never be
    // re-checked because storage.ak forbids spending.
    let valid_output = when outputs_to_validator is {
      [output] -> {
        let has_nft = assets.quantity_of(output.value, policy_id, expected_asset_name) == 1

        let valid_datum = when output.datum is {
          InlineDatum(data) -> {
            expect datum: RegistryDatum = data
            datum.snapshot_id == redeemer.snapshot_id &&
            snapshot_type_eq(datum.snapshot_type, redeemer.snapshot_type) &&
            datum.commitment_hash == redeemer.commitment_hash &&
            is_valid_commitment_hash(datum.commitment_hash) &&
            is_valid_snapshot_id(datum.snapshot_id)
          }
          _ -> False
        }

        has_nft && valid_datum
      }
      _ -> False
    }

    consumes_seed && valid_mint && valid_output
  }

  else(_) {
    fail @"Invalid purpose for minting policy"
  }
}

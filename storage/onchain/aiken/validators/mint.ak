/// One-Shot Minting Policy for Storage NFT Markers
///
/// This policy ensures that each snapshot can only be published once
/// by requiring the consumption of a specific seed UTxO.
///
/// The NFT serves as a unique marker that proves a snapshot commitment
/// was anchored on-chain at a specific time.

use aiken/collection/list
use aiken/crypto
use cardano/assets.{flatten}
use cardano/transaction.{Transaction, OutputReference, InlineDatum, Output}
use cardano/address
use storage/types.{MintRedeemer, RegistryDatum, snapshot_type_eq}
use storage/utils.{consumes_utxo, is_valid_commitment_hash, is_valid_snapshot_id}

/// Minting policy validator
///
/// Parameters:
/// - seed_utxo: The UTxO that must be consumed (ensures one-shot)
/// - validator_hash: The hash of the storage validator where the NFT must be sent
///
/// Rules:
/// 1. Must consume the seed UTxO
/// 2. Must mint exactly 1 token
/// 3. Asset name must be sha256(snapshot_id)
/// 4. Token must be sent to the storage validator
/// 5. Output datum must match redeemer data
validator mint(seed_utxo: OutputReference, validator_hash: ByteArray) {
  mint(redeemer: MintRedeemer, policy_id: ByteArray, tx: Transaction) {
    // Rule 1: Must consume the seed UTxO (ensures one-shot)
    let consumes_seed = consumes_utxo(tx.inputs, seed_utxo)

    // Rule 2 & 3: Check minting
    let expected_asset_name = crypto.sha2_256(redeemer.snapshot_id)
    let mint_list = tx.mint |> flatten()
    
    // Find our policy's minting
    let our_mints = list.filter(
      mint_list,
      fn(item) { item.1st == policy_id }
    )
    
    // Should mint exactly 1 token with correct asset name
    let valid_mint = when our_mints is {
      [(_, asset_name, qty)] -> asset_name == expected_asset_name && qty == 1
      _ -> False
    }

    // Rule 4: Token must be sent to storage validator
let validator_address_credential = address.Script(validator_hash)
    
    let outputs_to_validator = list.filter(
      tx.outputs,
      fn(output) {
        output.address.payment_credential == validator_address_credential
      }
    )

    // Rule 5: Output datum must match redeemer
    let valid_output = when outputs_to_validator is {
      [output] -> {
        // Check output contains the NFT
        let has_nft = assets.quantity_of(output.value, policy_id, expected_asset_name) == 1
        
        // Check datum matches
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

    // All rules must pass
    consumes_seed && valid_mint && valid_output
  }

  else(_) {
    fail @"Invalid purpose for minting policy"
  }
}

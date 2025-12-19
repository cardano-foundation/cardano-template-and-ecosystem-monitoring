/// Utility functions for Storage validators

use aiken/collection/list
use aiken/collection/dict
use aiken/primitive/bytearray
use cardano/assets.{PolicyId, AssetName, Value, quantity_of, tokens}
use cardano/transaction.{Input, Output, OutputReference}

/// Check if a specific UTxO is consumed in the transaction inputs
pub fn consumes_utxo(inputs: List<Input>, utxo_ref: OutputReference) -> Bool {
  list.any(inputs, fn(input) { input.output_reference == utxo_ref })
}

/// Get the quantity of a specific asset in a value
pub fn get_asset_quantity(value: Value, policy_id: PolicyId, asset_name: AssetName) -> Int {
  quantity_of(value, policy_id, asset_name)
}

/// Check if exactly one token of a specific asset is in the value
pub fn has_exactly_one_token(value: Value, policy_id: PolicyId, asset_name: AssetName) -> Bool {
  get_asset_quantity(value, policy_id, asset_name) == 1
}

/// Count how many tokens are being minted for a policy
pub fn count_minted_tokens(mint_value: Value, policy_id: PolicyId) -> Int {
  let policy_tokens = tokens(mint_value, policy_id)
  list.foldl(
    policy_tokens |> dict.values |> list.map(fn(quantity) { quantity }),
    0,
    fn(qty, acc) { acc + qty }
  )
}

/// Find outputs that contain a specific NFT
pub fn find_outputs_with_nft(
  outputs: List<Output>,
  policy_id: PolicyId,
  asset_name: AssetName,
) -> List<Output> {
  list.filter(
    outputs,
    fn(output) { has_exactly_one_token(output.value, policy_id, asset_name) }
  )
}

/// Check commitment hash length (should be 32 bytes for SHA-256)
pub fn is_valid_commitment_hash(hash: ByteArray) -> Bool {
  bytearray.length(hash) == 32
}

/// Check snapshot_id is not empty
pub fn is_valid_snapshot_id(id: ByteArray) -> Bool {
  bytearray.length(id) > 0
}

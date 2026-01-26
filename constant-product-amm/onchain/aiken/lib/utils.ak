use aiken/collection/list
use cardano/address.{Address}
use cardano/transaction.{Output}

pub fn get_output_by_address(
  outputs: List<Output>,
  address: Address,
) -> Option<Output> {
  list.find(outputs, fn(output) { output.address == address })
}

// IoT Sentinel - Storage Validator
// Stores proof-of-existence hashes for transformer monitoring data

use aiken/collection/list
use cardano/transaction.{OutputReference, Transaction}
use types.{IoTRecord, Lock, Spend, StorageAction, Update}

validator storage {
  spend(
    datum: Option<IoTRecord>,
    redeemer: StorageAction,
    _own_ref: OutputReference,
    tx: Transaction,
  ) -> Bool {
    expect Some(record) = datum
    let signatories = tx.extra_signatories

    when redeemer is {
      Lock -> {
        // Anyone can lock new data, just validate structure
        let valid_device = record.device_id != ""
        let valid_status = record.status_code >= 0 && record.status_code <= 8
        let valid_time = record.timestamp > 0
        let valid_hash = record.data_hash != ""
        
        valid_device && valid_status && valid_time && valid_hash
      }
      
      Update -> {
        // Only owner can update
        let owner_signed = list.has(signatories, record.owner)
        let valid_status = record.status_code >= 0 && record.status_code <= 8
        owner_signed && valid_status
      }
      
      Spend -> {
        // Only owner can spend
        list.has(signatories, record.owner)
      }
    }
  }

  else(_) {
    fail
  }
}

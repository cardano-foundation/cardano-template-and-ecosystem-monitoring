// IoT Sentinel - Type Definitions
// Data structures for 3-phase transformer monitoring

use aiken/crypto.{VerificationKeyHash}

// Status codes for transformer condition
pub type StatusCode {
  SystemNormal
  CriticalOverload
  WarningHighLoad
  AlertUnderVoltage
  AlertOverVoltage
  WarningLoadImbalance
  CriticalHighTemperature
  CriticalPhaseLoss
  InfoZeroLoad
}

pub fn status_to_int(status: StatusCode) -> Int {
  when status is {
    SystemNormal -> 0
    CriticalOverload -> 1
    WarningHighLoad -> 2
    AlertUnderVoltage -> 3
    AlertOverVoltage -> 4
    WarningLoadImbalance -> 5
    CriticalHighTemperature -> 6
    CriticalPhaseLoss -> 7
    InfoZeroLoad -> 8
  }
}

// Main datum structure stored on-chain
pub type IoTRecord {
  owner: VerificationKeyHash,
  device_id: ByteArray,
  timestamp: Int,
  data_hash: ByteArray,
  status_code: Int,
}

// Redeemer actions
pub type StorageAction {
  Lock
  Update
  Spend
}

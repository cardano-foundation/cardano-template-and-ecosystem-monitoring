// Append-only audit registry. UTxOs created here can never be spent —
// validity gates only run at mint time (see mint.ak). Spend always fails so
// every published snapshot becomes a permanent on-chain record. The "data"
// is whatever the minting policy validated into the datum at creation.

use storage/types.{RegistryDatum}

validator storage {
  // Hard-coded fail is the entire design: immutability comes from there
  // being no path that lets the UTxO leave the script.
  spend(_datum: Option<RegistryDatum>, _redeemer: Data, _output_ref: Data, _tx: Data) {
    fail @"Storage UTxOs are immutable and cannot be spent"
  }

  else(_) {
    fail @"Invalid purpose for storage validator"
  }
}

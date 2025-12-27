# Scalus Hello Cardano Smart Contract

This directory contains a minimal, working Cardano smart contract written in Scala 3 using the Scalus 0.14.1 toolchain. It includes:

- A simple auction validator with `spend` and `mint` entry points
- A tiny CLI main that compiles the validator to Plutus V3 UPLC and prints CBOR hex
- A lightweight unit test using uTest to verify data types compile and encode

The project is configured with Scala CLI for a fast, reproducible setup.

## Prerequisites

- JDK 17+ (LTS recommended)
- Scala CLI 1.5+ (`scala-cli --version`)
- Internet access for dependency resolution (Maven Central)

## Project Structure

```
scalus/
	.scalafmt.conf                # Formatting config
	project.scala                 # Scala CLI configuration (Scalus 0.14.1, test deps)
	Readme.md                     # This file
	AuctionMain.scala             # CLI entry: compiles validator and prints CBOR
	AuctionValidator.scala        # On-chain validator (spend + mint)
	AuctionValidator.test.scala   # uTest unit test for datum construction
```

## How To Run

Run these commands from this folder (scalus):

```bash
# Compile and run the small CLI that prints the CBOR hex of the validator
scala-cli run .

# Run tests (uTest)
scala-cli test .

# Optional: re-run quickly after edits
scala-cli test . --watch
```

What to expect:

- `scala-cli run .` prints the Plutus V3 CBOR hex for the compiled validator. You can redirect it to a file if needed.
- `scala-cli test .` runs `AuctionValidatorTests` and should report 1/1 test passed.

## Architecture

### Data Types

- `AuctionDatum(seller: PubKeyHash, highest_bidder: PubKeyHash, highest_bid: BigInt, expiration: BigInt, asset_policy: ByteString, asset_name: ByteString)`

  - Derives `FromData, ToData` for on-chain Data encoding/decoding.

- `enum Action derives FromData, ToData { BID, WITHDRAW, END }`
  - The redeemer indicating which branch is executed in the validator.

### Validator Entry Points

The validator is defined in `AuctionValidator.scala` as an `@Compile` object with two entry points:

- `inline def spend(datum: Option[Data], redeemer: Data, tx: TxInfo, sourceTxOutRef: TxOutRef): Unit`

  - Minimal logic illustrating how to read the inline datum and redeemer and perform checks.
  - In this sample:
    - `BID`: requires the bidder to sign and that the auction is still active.
    - `END`: requires the seller to sign and that the auction is expired.
    - `WITHDRAW`: not implemented (fails).

- `inline def mint(redeemer: Data, policyId: PolicyId, tx: TxInfo): Unit`
  - Demonstrates how to access outputs to the policy script address and read inline datums via `OutputDatum`.
  - Uses `Credential.ScriptCredential(policyId)` (no `.hash` required in Scalus 0.14.x) to find outputs to the policy script.

Both entry points are compiled by Scalus into Plutus V3 UPLC.

### Key Scalus API Notes (0.14.x)

- Use `scalus.builtin.Data` and `.to[...]` for Data conversions (ensure you import `Data`, `FromData`, `ToData`, and `ToData.*`).
- `OutputDatum` is in `scalus.ledger.api.v2`. Inline datum can be matched using `OutputDatum(d)` or `OutputDatum.InlineDatum(d)` depending on the exact form; the sample shows the compatible pattern for this project.
- `Value`/`TxOut` are split across versions (`v2`/`v3`)—import the ones you actually use:
  - `TxOut`, `OutputDatum` from `scalus.ledger.api.v2`
  - `TxInfo`, `TxOutRef`, `PubKeyHash` from `scalus.ledger.api.v3`
- `Credential.ScriptCredential(policyId)` compares directly with the credential on outputs (no `.hash`).

## Extending the Example

- Add more validations (e.g., ensure bid increases, asset checks, payout path).
- Produce a `.plutus` file from CBOR hex (e.g., write to disk from `AuctionMain.scala`).
- Integrate with an off-chain builder (Bloxbean Cardano Client Lib) for end-to-end flows.

## Troubleshooting

- If Scala CLI suggests dependency updates, you can accept them or stick with the pinned versions in `project.scala`.
- Errors like ambiguous `to` extension usually mean missing or conflicting imports—use explicit `import scalus.builtin.Data` and `import scalus.builtin.ToData.*` and avoid redundant wildcard imports.
- If `scala-cli` can’t resolve dependencies, verify network access and retry the command.

## License

See the repository’s root `LICENSE` for details.

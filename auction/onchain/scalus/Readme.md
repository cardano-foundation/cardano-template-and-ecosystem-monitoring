# Auction Smart Contract — Scalus

A Cardano auction smart contract written in Scala 3 using the [Scalus](https://scalus.org) 0.14.1 toolchain.

## Prerequisites

- JDK 17+ (LTS recommended)
- SBT 1.9+ (`sbt --version`)

## Project Structure

```
scalus/
  build.sbt                                              # SBT project definition
  src/main/scala/scalus/examples/auction/
    AuctionValidator.scala                               # On-chain validator (spend + mint)
    AikenCompat.scala                                    # Aiken-style helper utilities
    AuctionMain.scala                                    # CLI: compiles and prints CBOR hex
    GeneratePlutus.scala                                 # Generates plutus.json
  src/main/resources/
    plutus.json.template                                 # Blueprint template
  src/test/scala/scalus/examples/auction/
    AuctionValidatorTests.scala                          # uTest unit tests
```

## Commands

Run these from the `scalus/` directory:

```bash
# Compile
sbt compile

# Run tests
sbt test

# Generate plutus.json
sbt run
```
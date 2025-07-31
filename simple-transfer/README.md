# Simple transfer

This contract allows a user to deposit native assets define who can withdraw the assets. The receiver can then withdraw the assets. 

## ⛓ On-chain

### Aiken

#### 🔌 Prerequirements

- [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### 🪄 Test and build

```zsh
cd onchain/aiken
aiken check
aiken build
```

## 📄 Off-chain

### Java Cardano Client Lib 
This offchain code is written by using the [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib).
It assumes that the addresses are topped up. If you need some tAda, you can get some from the [Cardano Testnets Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

To run the code:
```
./gradlew clean run
```
# 💸 Payment Splitter

A simple payment splitter that distributes funds among a list of payees.
The validator checks two simple rules:

1. The list of (unique) payment credentials must match the provided list of "known payees." This list can be provided as a parameter to the validator.
2. The sum of the outputs (by payment credentials) must be equally split. (Excluding change outputs)

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

### MeshJS

#### 🔌 Prerequirements

- Deno (https://deno.land/)

#### 💳 Prepare a list of wallets

```zsh
cd offchain/meshjs
deno run --allow-env --allow-read --allow-write payment-splitter.ts prepare 5
```

#### 💎 Top up the wallets

Copy the address from the output of the previous command and send some test Ada (tAda) on the preprod network to this address.
If you don't have tAda at all, you can get some from the [Cardano Testnets Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

#### 🤳🏼 Send 10 tAda to the payment splitter

Anyone can lock funds in the payment splitter by sending an amount to the contract address.

```zsh
# Lock 10 tAda
deno run --allow-env --allow-read --allow-net payment-splitter.ts lock 10000000
```

Example output:

```zsh
Successfully locked 10000000 lovelace to the script address addr_test1wqn8pmxvahephy3vxesjw3x8tf0ktq53k62d6hdgw0dw2ksv6p87s.

  See: https://preprod.cexplorer.io/tx/01cb68261dda5d591341b0d2561e18677899a4844b50f7e6fa732d0da010101c
```

#### 🤑 Trigger a payout

This command will generate a transaction that calculates the total available Lovelace value within the contract UTXOs and distributes the funds among the payees.

```zsh
deno run --allow-env --allow-read --allow-net payment-splitter.ts unlock
```

Example output:

```zsh
Successfully unlocked the lovelace from the script address addr_test1wqn8pmxvahephy3vxesjw3x8tf0ktq53k62d6hdgw0dw2ksv6p87s and split it equally (2000000 Lovelace) to all payees.

    See: https://preprod.cexplorer.io/tx/422205f06a44668efd81747e93eb88229db5af526c0447d8a480b6acd44c91f0
```
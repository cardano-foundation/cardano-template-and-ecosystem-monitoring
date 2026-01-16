# 🎰 Lottery – Reference Implementation

This repository demonstrates a two-player Lottery use case based on the Rosetta smart contract specifications.

The use case implements a **fair, trust-minimized betting protocol** where two players stake an equal amount of ADA and the winner redeems the entire pot. Fairness is achieved without relying on external randomness or oracles, using a **commit–reveal–punish** protocol enforced entirely on-chain.

This implementation is intended as a **clear reference** for modeling adversarial interactions, timeouts, and fairness guarantees in deterministic smart contracts on Cardano.

---

## Overview

In this lottery:

* Two players place an equal bet
* Each player commits to a secret (via its hash)
* Secrets are revealed sequentially
* The winner is computed as a deterministic, fair function of both secrets
* Dishonest behavior (e.g. refusing to reveal) is **punished**
* An honest player is never worse off than interacting with another honest player

No trusted third party or randomness oracle is required.

---

## Actors

This use case involves the following actors:

* **Player1** – first participant to join and reveal
* **Player2** – second participant to join and reveal

Both players are symmetric in stake and potential payoff.

---

## On-chain Model

The lottery is represented by a **state UTxO** locked at a validator script address.

The inline datum stores:

* Player public key hashes
* Commitment hashes for both players’ secrets
* Reveal status
* Deadlines (`end_commit`, `end_reveal`, `end_reveal + Δ`)
* Bet amount

The validator enforces:

* Correct commitment–reveal flow
* Signature checks for each action
* Deadline-based punishment paths
* Deterministic winner selection once both secrets are revealed

---

## Protocol
The protocol followed by (honest) players is the following:
1. `player1` and `player2` join the lottery by paying the bet and committing to a secret (the bet is the same for each player);
2. `player1` reveals the first secret;
3. if `player1` has not revealed, `player2` can redeem both players' bets after a given deadline (`end_reveal`);
4. once `player1` has revealed, `player2` reveals the secret;
5. if `player2` has not revealed, `player1` can redeem both players' bets after a given deadline (`end_reveal` plus a fixed constant);
6. once both secrets have been revealed, the winner, who is fairly determined as a function of the two revealed secrets, can redeem the whole pot.
---

## Off-chain Interface (CLI)

The repository includes a command-line interface implemented in **TypeScript (MeshJS + Deno)** to interact with the lottery contract.

All commands follow this general pattern:

```bash
deno run -A lottery.ts <command> <arguments...>
```

---

## Command Reference

### 1️⃣ Create Lottery (Commit Phase)

Creates a new lottery instance and locks the initial state at the script address.

#### Usage

```text
deno run -A lottery.ts multisig-create <wallet1.json> <wallet2.json> <wallet3.json>
```

#### Example

```bash
deno run -A lottery.ts multisig-create wallet_0.json wallet_1.json wallet_2.json
```

#### Example Output

```text
Lottery created
Script address: addr_test1wzetddu7mugv95mdp3p7txsvjjydsz775efj60659gtcfnsecuyf7
Tx Id: 97e7ef1e551baf6f6d4cfd7cb2d633da518282b76edf42698f1d7050ec52394c
```

---

### 2️⃣ Reveal Secret – Player1

Reveals the first committed secret.

#### Usage

```text
deno run -A lottery.ts reveal1 <wallet.json>
```

#### Example

```bash
deno run -A lottery.ts reveal1 wallet_1.json
```

#### Example Output

```text
Tx submitted: d804a5f9a735fe848a033e47e289e517b1c793539c71520cda6cfd41153d5a56
```

---

### 3️⃣ Reveal Secret – Player2

Reveals the second committed secret.

#### Usage

```text
deno run -A lottery.ts reveal2 <wallet.json>
```

#### Example

```bash
deno run -A lottery.ts reveal2 wallet_2.json
```

#### Example Output

```text
Tx submitted: d8e85d16fab713d533941a2bf7c1cb839413f2dacc10dd6d3defadad102b7d44
```

---

### 4️⃣ Settle Lottery

Determines the winner and redeems the pot once both secrets have been revealed.

#### Usage

```text
deno run -A lottery.ts settle <wallet1.json> <wallet2.json>
```

#### Example

```bash
deno run -A lottery.ts settle wallet_1.json wallet_2.json
```

#### Example Output

```text
Lottery settled
Winner PKH: 72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215
Tx Id: b52db361fc78242382646c4c19b6e87b22ea158e7847e9f21db06d401d254aae
```

---

## Fairness & Security Properties

This implementation guarantees:

* ✅ No reliance on external randomness
* ✅ No trusted coordinator
* ✅ Dishonest players are penalized
* ✅ Honest players are never disadvantaged
* ✅ Deterministic and auditable winner selection

---

## Disclaimer

⚠️ **Off-chain timeout handling**

The off-chain (MeshJS + Deno) code paths corresponding to **timeout-based redemption endpoints** (i.e. reclaiming funds after missed reveal deadlines) are included for completeness but **have not been tested**.

The on-chain validator logic enforces all timeout and punishment rules correctly; however, the off-chain scripts for these specific timeout scenarios should be considered **reference-only** and may require additional testing or refinement before production use.

---

## Purpose

This repository is intended to:

* Serve as a **Rosetta-aligned reference implementation**
* Demonstrate **commit–reveal–punish protocols** on Cardano
* Showcase handling of adversarial behavior and timeouts
* Be suitable for **CF / Catalyst challenge submissions**
* Be easy to read, audit, and extend

This code is not production-hardened and intentionally omits advanced concerns such as indexing, batching, and multi-UTxO handling.

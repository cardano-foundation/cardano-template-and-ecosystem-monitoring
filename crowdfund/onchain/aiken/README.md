# Crowdfunding Aiken Validator

This is a simple crowdfunding smart contract written in Aiken. It allows a **beneficiary** to raise funds for a specific **goal** up until a **deadline**. Donors can contribute to the campaign, and if the goal is not met by the deadline, they can reclaim their funds.

---

## 📜 How It Works

The validator is parameterized by three values:

-   `beneficiary`: The `VerificationKeyHash` of the person or entity who will receive the funds if the campaign is successful.
-   `goal`: An `Int` representing the target amount in Lovelace.
-   `deadline`: An `Int` representing the POSIX timestamp after which the campaign closes.

The on-chain state is managed via a `datum`, which tracks the wallet hashes of all donors and their corresponding donated amounts.

---

## 🎬 Actions (Redeemers)

A user can interact with the contract by choosing one of three actions:

### `DONATE`

Anyone can send funds to the contract address. This action validates that:

1.  The amount of Lovelace at the script address increases.
2.  The on-chain datum is correctly updated to include the new donation amount in the total.

### `WITHDRAW`

This action allows the **beneficiary** to collect all the funds from the contract. It's only possible if:

1.  The `deadline` has passed.
2.  The total contributed amount is greater than or equal to the `goal`.
3.  The transaction is signed by the `beneficiary`.

### `RECLAIM`

If the campaign fails to meet its `goal` by the `deadline`, donors can reclaim their funds. This action ensures that:

1.  The `deadline` has passed.
2.  The total contributed amount is less than the `goal`.
3.  The transaction is signed by the donor(s) who are reclaiming their funds.
4.  A donor can only reclaim the exact amount they contributed. The on-chain datum is updated to reflect the withdrawal.
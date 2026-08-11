package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.cardanofoundation.templates.validator.CrowdfundValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * An all-or-nothing crowdfund.
 *
 * <p>Donations accumulate in a single script UTxO whose datum is a ledger of who gave what. After
 * the deadline exactly one of two things happens: the goal was met and the beneficiary takes the
 * pot, or it was not and every donor recovers precisely their own stake.
 *
 * <p>This run drives the failed-campaign path, because that is where the interesting guarantees
 * live: a donor may take back their own contribution and nobody else's, and may not take it
 * twice.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    private static final Network NETWORK = Networks.testnet();

    private static final Account BENEFICIARY = Account.createFromMnemonic(NETWORK, MNEMONIC);
    private static final Account ALICE = new Account(NETWORK);
    private static final Account BOB = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final BigInteger ALICE_GAVE = BigInteger.valueOf(5_000_000);
    private static final BigInteger BOB_GAVE = BigInteger.valueOf(4_000_000);
    private static final BigInteger RAISED = ALICE_GAVE.add(BOB_GAVE);

    /** Far above what this campaign raises, so it fails and the refund path is the live one. */
    private static final BigInteger GOAL = BigInteger.valueOf(100_000_000);

    /**
     * Zero, so the deadline has always passed.
     *
     * <p>This devnet reports a block's {@code slot} and its {@code time} out of step with each
     * other, so a deadline derived from block time is not reliably comparable against a
     * slot-derived transaction bound. Rather than produce a result that proves nothing either
     * way, the run takes the deadline out of the picture and concentrates on the refund
     * accounting. The time gate itself is covered by the unit tests.
     */
    private static final BigInteger DEADLINE = BigInteger.ZERO;

    private static final PlutusScript CAMPAIGN = JulcScriptLoader.load(CrowdfundValidator.class,
            BytesPlutusData.of(keyHash(BENEFICIARY)),
            BigIntPlutusData.of(GOAL),
            BigIntPlutusData.of(DEADLINE));

    private static final String CAMPAIGN_ADDRESS =
            AddressProvider.getEntAddress(CAMPAIGN, NETWORK).toBech32();

    public static void main(String[] args) throws Exception {
        System.out.println("Campaign address: " + CAMPAIGN_ADDRESS);
        System.out.println("Goal:             " + GOAL + " (deliberately out of reach)");
        System.out.println("Alice:            " + ALICE.baseAddress());
        System.out.println("Bob:              " + BOB.baseAddress());

        fund(ALICE, 30_000_000);
        fund(BOB, 30_000_000);

        // 1. Alice starts the campaign, credited with everything in it.
        Utxo campaign = open();
        System.out.println("Campaign opened in " + campaign.getTxHash());

        // 2. The ledger has to account for every lovelace. Claiming more than you put in would
        //    let you reclaim other people's money once the campaign failed.
        require(isRejected(() -> donate(campaign, BOB, BOB_GAVE,
                        ledger(ALICE, ALICE_GAVE, BOB, BOB_GAVE.multiply(BigInteger.TWO)))),
                "a donation that overstates its contribution must be rejected");
        System.out.println("Overstated donation rejected as expected");

        // 3. Bob donates honestly.
        Utxo funded = utxoOf(succeed(
                donate(campaign, BOB, BOB_GAVE, ledger(ALICE, ALICE_GAVE, BOB, BOB_GAVE)),
                "Bob's donation"));
        System.out.println("Bob donated in " + funded.getTxHash());

        // 4. All-or-nothing: short of the goal the beneficiary gets nothing.
        require(isRejected(() -> withdraw(funded)),
                "withdrawing from a campaign short of its goal must be rejected");
        System.out.println("Withdrawal from an unfunded campaign rejected as expected");

        // 5. Anti-replay: a reclaiming donor must be struck from the ledger, or they could come
        //    back and be paid for the same contribution twice.
        require(isRejected(() -> reclaim(funded, BOB, ledger(ALICE, ALICE_GAVE, BOB, BOB_GAVE),
                        ALICE_GAVE)),
                "a reclaim that leaves the donor in the ledger must be rejected");
        System.out.println("Reclaim without removal from the ledger rejected as expected");

        // 6. Bob reclaims, rebuilding the campaign for Alice alone.
        Utxo remaining = utxoOf(succeed(
                reclaim(funded, BOB, ledger(ALICE, ALICE_GAVE), ALICE_GAVE), "Bob's reclaim"));
        System.out.println("Bob reclaimed in " + remaining.getTxHash());

        // 7. Alice takes the rest, closing the campaign.
        TxResult drained = succeed(drain(remaining, ALICE), "Alice's reclaim");
        System.out.println("Alice reclaimed the remainder in " + drained.getTxHash());

        require(spendsCampaign(drained.getTxHash()),
                "the confirmed transaction must spend the campaign UTxO");

        System.out.println("Verified: each donor recovered their own stake, and only once");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    private static void fund(Account account, long lovelace) throws Exception {
        Tx fund = new Tx()
                .payToAddress(account.baseAddress(), Amount.lovelace(BigInteger.valueOf(lovelace)))
                .from(BENEFICIARY.baseAddress());
        succeed(TX_BUILDER.compose(fund)
                .withSigner(SignerProviders.signerFrom(BENEFICIARY))
                .completeAndWait(), "funding");
    }

    /**
     * Opens the campaign. A plain payment — the validator only runs on the way out.
     *
     * <p>Alice is credited with the whole balance, including the minimum ada the UTxO needs to
     * exist, because the ledger must sum to exactly what is held.
     */
    private static Utxo open() throws Exception {
        Tx openTx = new Tx()
                .payToContract(CAMPAIGN_ADDRESS, Amount.lovelace(ALICE_GAVE),
                        ledger(ALICE, ALICE_GAVE))
                .from(ALICE.baseAddress());

        return utxoOf(succeed(TX_BUILDER.compose(openTx)
                .withSigner(SignerProviders.signerFrom(ALICE))
                .completeAndWait(), "opening the campaign"));
    }

    /** Adds to the pot. {@code newLedger} is what the rejection case bends. */
    private static TxResult donate(Utxo campaign, Account donor, BigInteger amount,
            PlutusData newLedger) throws Exception {
        BigInteger balance = lovelaceOf(campaign).add(amount);

        ScriptTx donateTx = new ScriptTx()
                // Donate is constructor 0 of Action.
                .collectFrom(campaign, ConstrPlutusData.of(0))
                .attachSpendingValidator(CAMPAIGN)
                .payToContract(CAMPAIGN_ADDRESS, List.of(Amount.lovelace(balance)), newLedger)
                .withChangeAddress(donor.baseAddress());

        return submit(donateTx, donor);
    }

    /** The beneficiary's exit, which this campaign never earns. */
    private static TxResult withdraw(Utxo campaign) throws Exception {
        ScriptTx withdrawTx = new ScriptTx()
                // Withdraw is constructor 1 of Action.
                .collectFrom(campaign, ConstrPlutusData.of(1))
                .attachSpendingValidator(CAMPAIGN)
                .payToAddress(BENEFICIARY.baseAddress(),
                        Amount.lovelace(lovelaceOf(campaign).subtract(FEE_BUFFER)))
                .withChangeAddress(BENEFICIARY.baseAddress());

        return submit(withdrawTx, BENEFICIARY);
    }

    /** One donor takes their stake and rebuilds the campaign for whoever is still owed. */
    private static TxResult reclaim(Utxo campaign, Account donor, PlutusData newLedger,
            BigInteger left) throws Exception {
        ScriptTx reclaimTx = new ScriptTx()
                // Reclaim is constructor 2 of Action.
                .collectFrom(campaign, ConstrPlutusData.of(2))
                .attachSpendingValidator(CAMPAIGN)
                .payToContract(CAMPAIGN_ADDRESS, List.of(Amount.lovelace(left)), newLedger)
                .withChangeAddress(donor.baseAddress());

        return submit(reclaimTx, donor);
    }

    /** The last donor empties the campaign; no rebuilt UTxO is required. */
    private static TxResult drain(Utxo campaign, Account donor) throws Exception {
        ScriptTx drainTx = new ScriptTx()
                .collectFrom(campaign, ConstrPlutusData.of(2))
                .attachSpendingValidator(CAMPAIGN)
                // An explicit output is required, not just a change address: with nothing to pay,
                // cardano-client-lib never fills in the body and cannot resolve the redeemer
                // index — it fails to build, which is not the same as a validator refusing.
                .payToAddress(donor.baseAddress(),
                        Amount.lovelace(lovelaceOf(campaign).subtract(FEE_BUFFER)))
                .withChangeAddress(donor.baseAddress());

        return submit(drainTx, donor);
    }

    private static final BigInteger FEE_BUFFER = BigInteger.valueOf(1_000_000);

    private static TxResult submit(ScriptTx tx, Account signer) throws Exception {
        return TX_BUILDER.compose(tx)
                .feePayer(signer.baseAddress())
                .withSigner(SignerProviders.signerFrom(signer))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        signer.baseAddress()))
                .validFrom(currentSlot())
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code CrowdfundDatum { wallets }} — a map of donor key hash to contribution. */
    private static PlutusData ledger(Object... donorsAndAmounts) {
        MapPlutusData wallets = MapPlutusData.builder().build();
        for (int i = 0; i < donorsAndAmounts.length; i += 2) {
            Account donor = (Account) donorsAndAmounts[i];
            BigInteger amount = (BigInteger) donorsAndAmounts[i + 1];
            wallets.put(BytesPlutusData.of(keyHash(donor)), BigIntPlutusData.of(amount));
        }
        return ConstrPlutusData.of(0, wallets);
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the campaign address. Checking that a UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     */
    private static boolean spendsCampaign(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> CAMPAIGN_ADDRESS.equals(input.getAddress()));
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    /**
     * Reports whether the chain refused a transaction.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a failed
     * result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Attempt attempt) {
        try {
            return !attempt.run().isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + shortMessage(rejected));
            return true;
        }
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    private static String shortMessage(Exception e) {
        String message = String.valueOf(e.getMessage());
        return message.length() > 120 ? message.substring(0, 120) + "…" : message;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private static TxResult succeed(TxResult result, String what) {
        require(result.isSuccessful(), what + " failed: " + result);
        return result;
    }

    private static BigInteger lovelaceOf(Utxo utxo) {
        return utxo.getAmount().stream()
                .filter(amount -> "lovelace".equals(amount.getUnit()))
                .map(Amount::getQuantity)
                .findFirst()
                .orElse(BigInteger.ZERO);
    }

    private static long currentSlot() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getSlot();
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at the
     * campaign address would pick up campaigns left by an earlier run.
     */
    private static Utxo utxoOf(TxResult result) throws Exception {
        return UTXOS.getAll(CAMPAIGN_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no campaign UTxO created by " + result.getTxHash()));
    }

    private static byte[] keyHash(Account account) {
        return account.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    /** The exit code is the result, so every check throws rather than printing a warning. */
    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }

    private static String envOrDefault(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}

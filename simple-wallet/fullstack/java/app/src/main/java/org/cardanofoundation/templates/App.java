package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.cardanofoundation.templates.validator.FundsValidator;
import org.cardanofoundation.templates.validator.PaymentIntentValidator;
import org.cardanofoundation.templates.validator.WalletValidator;

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
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * A smart-contract wallet that separates <em>what</em> to pay from <em>whether</em> to pay it.
 *
 * <p>An intent is published on chain first: recipient, amount, and a reference. It is a proposal
 * anyone can inspect, and it moves nothing. Execution requires the owner's signature as well, and
 * pays out exactly the intent — no more, no less — while burning the marker so the same intent
 * can never run twice.
 *
 * <p>That split is the point. Publishing a payment for review is safe, because review and
 * authorisation are different acts.
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
    private static final Account OWNER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    /** A fresh account, so the payee is genuinely not the fee payer. */
    private static final Account RECIPIENT = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final String MARKER_NAME = "INTENT_MARKER";

    /** What the wallet is funded with, and what the intent pays out. */
    private static final BigInteger VAULT_ADA = BigInteger.valueOf(20_000_000);
    private static final BigInteger PAYMENT = BigInteger.valueOf(5_000_000);

    // The parameter chain: intent script → wallet policy → funds vault.
    private static final PlutusScript INTENT =
            JulcScriptLoader.load(PaymentIntentValidator.class, BytesPlutusData.of(ownerKeyHash()));
    private static final String INTENT_ADDRESS =
            AddressProvider.getEntAddress(INTENT, NETWORK).toBech32();

    private static PlutusScript walletPolicy;
    private static PlutusScript funds;
    private static String fundsAddress;

    public static void main(String[] args) throws Exception {
        walletPolicy = JulcScriptLoader.load(WalletValidator.class,
                BytesPlutusData.of(ownerKeyHash()),
                BytesPlutusData.of(INTENT.getScriptHash()));

        funds = JulcScriptLoader.load(FundsValidator.class,
                BytesPlutusData.of(ownerKeyHash()),
                BytesPlutusData.of(HexUtil.decodeHexString(walletPolicy.getPolicyId())));

        fundsAddress = AddressProvider.getEntAddress(funds, NETWORK).toBech32();

        System.out.println("Funds vault:    " + fundsAddress);
        System.out.println("Intent script:  " + INTENT_ADDRESS);
        System.out.println("Wallet policy:  " + walletPolicy.getPolicyId());
        System.out.println("Recipient:      " + RECIPIENT.baseAddress());

        // 1. Fund the vault.
        Utxo vault = fundVault();
        System.out.println("Vault funded in " + vault.getTxHash());

        // 2. Publish an intent: pay the recipient exactly PAYMENT.
        Utxo intent = attachIntent();
        System.out.println("Intent published in " + intent.getTxHash());

        // 3. The amount is exact, not a floor — overpaying is a transfer the owner never agreed
        //    to, so it is refused just as underpaying is.
        require(isRejected(() -> execute(vault, intent, PAYMENT.add(BigInteger.valueOf(1_000_000)), true)),
                "paying more than the intent must be rejected");
        System.out.println("Overpayment rejected as expected");

        require(isRejected(() -> execute(vault, intent, PAYMENT.subtract(BigInteger.ONE), true)),
                "paying less than the intent must be rejected");
        System.out.println("Underpayment rejected as expected");

        // 4. Without the burn the marker survives and the intent could be replayed.
        require(isRejected(() -> execute(vault, intent, PAYMENT, false)),
                "an execution that does not burn the marker must be rejected");
        System.out.println("Execution without burning the marker rejected as expected");

        // 5. The real thing.
        TxResult executed = execute(vault, intent, PAYMENT, true);
        require(executed.isSuccessful(), "executing the intent failed: " + executed);
        System.out.println("Intent executed in " + executed.getTxHash());

        require(spendsVault(executed.getTxHash()),
                "the confirmed transaction must spend the vault");
        require(paidExactly(executed.getTxHash(), PAYMENT),
                "the recipient must receive exactly the intent amount");

        System.out.println("Verified: the wallet paid precisely what the intent authorised");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    /** Locks ada at the vault. Plain payment — the funds validator only runs on the way out. */
    private static Utxo fundVault() throws Exception {
        Tx fund = new Tx()
                .payToContract(fundsAddress, Amount.lovelace(VAULT_ADA), PlutusData.unit())
                .from(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(fund)
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();

        require(result.isSuccessful(), "funding the vault failed: " + result);
        return utxoFrom(fundsAddress, result.getTxHash());
    }

    /** Mints the marker and parks it at the intent script with the payment intent attached. */
    private static Utxo attachIntent() throws Exception {
        Asset marker = Asset.builder().name(MARKER_NAME).value(BigInteger.ONE).build();

        ScriptTx attach = new ScriptTx()
                // Mint is constructor 0 of WalletRedeemer.
                .mintAsset(walletPolicy, List.of(marker), ConstrPlutusData.of(0),
                        INTENT_ADDRESS, paymentIntent());

        TxResult result = TX_BUILDER.compose(attach)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        OWNER.baseAddress()))
                .completeAndWait();

        require(result.isSuccessful(), "publishing the intent failed: " + result);
        return utxoFrom(INTENT_ADDRESS, result.getTxHash());
    }

    /**
     * Spends the vault and the intent together, pays the recipient, and burns the marker.
     *
     * <p>{@code amount} and {@code burn} are what the rejection cases bend — everything else is
     * identical to a valid execution, so a refusal can only be about the thing under test.
     */
    private static TxResult execute(Utxo vault, Utxo intent, BigInteger amount, boolean burn)
            throws Exception {
        Asset marker = Asset.builder().name(MARKER_NAME)
                .value(BigInteger.valueOf(-1)).build();

        ScriptTx executeTx = new ScriptTx()
                // ExecuteTx is constructor 0 of Action.
                .collectFrom(vault, ConstrPlutusData.of(0))
                .attachSpendingValidator(funds)
                // The intent is a real input, so its own owner-only rule runs too.
                .collectFrom(intent, PlutusData.unit())
                .attachSpendingValidator(INTENT)
                .payToAddress(RECIPIENT.baseAddress(), Amount.lovelace(amount))
                .withChangeAddress(OWNER.baseAddress());

        if (burn) {
            // Burn is constructor 1 of WalletRedeemer.
            executeTx = executeTx.mintAsset(walletPolicy, List.of(marker), ConstrPlutusData.of(1));
        }

        return TX_BUILDER.compose(executeTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        OWNER.baseAddress()))
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code PaymentIntent { recipient, lovelaceAmount, data }}. */
    private static PlutusData paymentIntent() {
        return ConstrPlutusData.of(0,
                addressData(recipientKeyHash()),
                BigIntPlutusData.of(PAYMENT),
                BytesPlutusData.of("invoice-42".getBytes(StandardCharsets.UTF_8)));
    }

    /** A Plutus {@code Address}: a payment credential plus an optional staking credential. */
    private static PlutusData addressData(byte[] keyHash) {
        return ConstrPlutusData.of(0,
                ConstrPlutusData.of(0, BytesPlutusData.of(keyHash)),  // PubKeyCredential
                ConstrPlutusData.of(1));                              // no staking credential
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the funds validator ran: the confirmed transaction must list an
     * input at the vault address. Checking that a UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     */
    private static boolean spendsVault(String txHash) throws Exception {
        return await(txHash, utxos -> utxos.getInputs().stream()
                .anyMatch(input -> fundsAddress.equals(input.getAddress())));
    }

    /** The recipient's outputs must add up to exactly the intent amount. */
    private static boolean paidExactly(String txHash, BigInteger expected) throws Exception {
        return await(txHash, utxos -> {
            BigInteger paid = utxos.getOutputs().stream()
                    .filter(output -> RECIPIENT.baseAddress().equals(output.getAddress()))
                    .flatMap(output -> output.getAmount().stream())
                    .filter(amount -> "lovelace".equals(amount.getUnit()))
                    // The backend model reports quantities as strings.
                    .map(amount -> new BigInteger(amount.getQuantity()))
                    .reduce(BigInteger.ZERO, BigInteger::add);
            return paid.equals(expected);
        });
    }

    /** Polls, because a node confirms a transaction slightly before the indexer serves it. */
    private static boolean await(String txHash, TxCheck check) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return check.test(response.getValue());
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    @FunctionalInterface
    private interface TxCheck {
        boolean test(com.bloxbean.cardano.client.backend.model.TxContentUtxo utxos);
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

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at a
     * script address would pick up leftovers from an earlier run.
     */
    private static Utxo utxoFrom(String address, String txHash) throws Exception {
        return UTXOS.getAll(address).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO created by " + txHash));
    }

    private static byte[] ownerKeyHash() {
        return OWNER.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    private static byte[] recipientKeyHash() {
        return RECIPIENT.getBaseAddress().getPaymentCredentialHash()
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

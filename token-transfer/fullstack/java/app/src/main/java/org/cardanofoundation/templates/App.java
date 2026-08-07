package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;

import org.cardanofoundation.templates.validator.DemoTokenPolicy;
import org.cardanofoundation.templates.validator.TokenTransferValidator;

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
 * A delivery address for one specific token.
 *
 * <p>The script is parameterised on {@code (receiver, policy, assetName)}, so each address
 * corresponds to exactly one asset destined for exactly one person. Anyone can send that token
 * there; only the receiver can take it out — and, crucially, taking it out cannot be bundled
 * with moving anything else.
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

    /** The sender issues the tokens and pays every fee. */
    private static final Account SENDER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    /** A separate account, so "the receiver signed" is a real condition and not automatic. */
    private static final Account RECEIVER = new Account(NETWORK);

    /**
     * A clean, ada-only account used to pay for the collection.
     *
     * <p>Deliberately not the shared devkit wallet: on a long-lived devnet that wallet
     * accumulates tokens from other examples, and any change output carrying one would trip the
     * validator's anti-batching rule.
     */
    private static final Account PAYER = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final BigInteger QUANTITY = BigInteger.valueOf(10);
    private static final BigInteger MIN_ADA = BigInteger.valueOf(2_000_000);

    private static PlutusScript policy;
    private static PlutusScript otherPolicy;
    private static PlutusScript transfer;
    private static String transferAddress;
    private static String targetName;
    private static String otherName;

    public static void main(String[] args) throws Exception {
        // Fresh asset names per run, so repeated runs against a long-lived devnet do not reuse
        // an address that already holds tokens from an earlier attempt.
        long stamp = System.currentTimeMillis();
        targetName = "DELIVERY" + stamp;
        otherName = "OTHER" + stamp;

        policy = JulcScriptLoader.load(DemoTokenPolicy.class,
                BytesPlutusData.of(keyHash(SENDER)), BigIntPlutusData.of(0));

        // A second, genuinely unrelated policy. The escape hatch only applies to assets outside
        // the target policy — a sibling asset under the SAME policy stays guarded.
        otherPolicy = JulcScriptLoader.load(DemoTokenPolicy.class,
                BytesPlutusData.of(keyHash(SENDER)), BigIntPlutusData.of(1));

        transfer = JulcScriptLoader.load(TokenTransferValidator.class,
                BytesPlutusData.of(keyHash(RECEIVER)),
                BytesPlutusData.of(HexUtil.decodeHexString(policy.getPolicyId())),
                BytesPlutusData.of(targetName.getBytes()));

        transferAddress = AddressProvider.getEntAddress(transfer, NETWORK).toBech32();

        System.out.println("Delivery address: " + transferAddress);
        System.out.println("Token policy:     " + policy.getPolicyId());
        System.out.println("Receiver:         " + RECEIVER.baseAddress());

        // 0. The receiver must be able to sign, which needs a little ada of their own.
        fundReceiver();

        // 1. Mint the delivery token and an unrelated one, both to the delivery address. The
        //    second lands there as if sent by mistake.
        Utxo delivery = send(policy, targetName);
        Utxo stray = send(otherPolicy, otherName);
        System.out.println("Delivery sent in " + delivery.getTxHash());
        System.out.println("Unrelated token sent in " + stray.getTxHash());

        // 2. Only the receiver may collect.
        require(isRejected(() -> collect(delivery, false, null)),
                "collecting without the receiver's signature must be rejected");
        System.out.println("Collection without the receiver rejected as expected");

        // 3. The anti-batching rule: signing authorises collecting THIS delivery, not whatever
        //    else a transaction builder decided to move alongside it.
        require(isRejected(() -> collect(delivery, true, stray)),
                "sweeping an unrelated token in the same transaction must be rejected");
        System.out.println("Batching an unrelated token rejected as expected");

        // 4. The receiver collects.
        TxResult collected = collect(delivery, true, null);
        require(collected.isSuccessful(), "collecting the delivery failed: " + collected);
        System.out.println("Delivery collected in " + collected.getTxHash());

        require(spendsDeliveryAddress(collected.getTxHash()),
                "the confirmed transaction must spend the delivery UTxO");

        // 5. The escape hatch: the mistakenly-sent token was never guarded, so the sender —
        //    who is not the receiver — can retrieve it. Without this it would be locked forever.
        TxResult retrieved = retrieve(stray);
        require(retrieved.isSuccessful(), "retrieving the stray token failed: " + retrieved);
        System.out.println("Mistaken transfer retrieved in " + retrieved.getTxHash());

        System.out.println("Verified: only the receiver collects, and only their own delivery");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    private static void fundReceiver() throws Exception {
        Tx fund = new Tx()
                .payToAddress(RECEIVER.baseAddress(), Amount.lovelace(BigInteger.valueOf(20_000_000)))
                .payToAddress(PAYER.baseAddress(), Amount.lovelace(BigInteger.valueOf(20_000_000)))
                .from(SENDER.baseAddress());

        TxResult result = TX_BUILDER.compose(fund)
                .withSigner(SignerProviders.signerFrom(SENDER))
                .completeAndWait();
        require(result.isSuccessful(), "funding the receiver failed: " + result);
    }

    /** Mints a token straight to the delivery address, as any sender would. */
    private static Utxo send(PlutusScript mintingPolicy, String assetName) throws Exception {
        Asset asset = Asset.builder().name(assetName).value(QUANTITY).build();

        ScriptTx sendTx = new ScriptTx()
                .mintAsset(mintingPolicy, List.of(asset), PlutusData.unit(),
                        transferAddress, PlutusData.unit());

        TxResult result = TX_BUILDER.compose(sendTx)
                .feePayer(SENDER.baseAddress())
                .withSigner(SignerProviders.signerFrom(SENDER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        SENDER.baseAddress()))
                .completeAndWait();

        require(result.isSuccessful(), "sending " + assetName + " failed: " + result);
        return utxoFrom(transferAddress, result.getTxHash());
    }

    /**
     * The receiver takes their delivery.
     *
     * <p>{@code alsoSweep} is what the anti-batching case bends: adding a second script input
     * carrying a different token, which must make the whole transaction invalid.
     */
    private static TxResult collect(Utxo delivery, boolean receiverSigns, Utxo alsoSweep)
            throws Exception {
        ScriptTx collectTx = new ScriptTx()
                .collectFrom(delivery, PlutusData.unit())
                .attachSpendingValidator(transfer)
                .payToAddress(RECEIVER.baseAddress(),
                        List.of(Amount.lovelace(MIN_ADA),
                                Amount.asset(policy.getPolicyId(), targetName, QUANTITY)));

        if (alsoSweep != null) {
            collectTx = collectTx
                    .collectFrom(alsoSweep, PlutusData.unit())
                    .payToAddress(RECEIVER.baseAddress(),
                            List.of(Amount.lovelace(MIN_ADA),
                                    Amount.asset(otherPolicy.getPolicyId(), otherName, QUANTITY)));
        }
        // Fees and change go through a dedicated ada-only account, never the shared wallet.
        // The anti-batching rule below rejects *any* output leaving the script that carries a
        // foreign token — and cardano-client-lib's change output is such an output. Paying from
        // a wallet that has accumulated unrelated tokens therefore fails the collection for a
        // reason that has nothing to do with batching.
        collectTx = collectTx.withChangeAddress(PAYER.baseAddress());

        var builder = TX_BUILDER.compose(collectTx)
                .feePayer(PAYER.baseAddress())
                .withSigner(SignerProviders.signerFrom(PAYER));

        if (receiverSigns) {
            builder = builder
                    .withSigner(SignerProviders.signerFrom(RECEIVER))
                    .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                            RECEIVER.baseAddress()));
        }
        return builder.completeAndWait();
    }

    /** Anyone can take back a token that was never the target of this address. */
    private static TxResult retrieve(Utxo stray) throws Exception {
        ScriptTx retrieveTx = new ScriptTx()
                .collectFrom(stray, PlutusData.unit())
                .attachSpendingValidator(transfer)
                .payToAddress(SENDER.baseAddress(),
                        List.of(Amount.lovelace(MIN_ADA),
                                Amount.asset(otherPolicy.getPolicyId(), otherName, QUANTITY)))
                .withChangeAddress(SENDER.baseAddress());

        return TX_BUILDER.compose(retrieveTx)
                .feePayer(SENDER.baseAddress())
                .withSigner(SignerProviders.signerFrom(SENDER))
                .completeAndWait();
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the delivery address. Checking that a UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     */
    private static boolean spendsDeliveryAddress(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> transferAddress.equals(input.getAddress()));
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

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at
     * the delivery address would pick up leftovers from an earlier run.
     */
    private static Utxo utxoFrom(String address, String txHash) throws Exception {
        return UTXOS.getAll(address).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO created by " + txHash));
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

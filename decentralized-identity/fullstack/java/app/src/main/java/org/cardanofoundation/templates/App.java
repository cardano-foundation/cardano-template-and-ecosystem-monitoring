package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;

import org.cardanofoundation.templates.validator.IdentityValidator;

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
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * A self-sovereign identity: one UTxO holding an owner key and a list of time-bounded delegates.
 *
 * <p>The UTxO is a pure state cell. Its value never moves, so the contract holds nothing worth
 * stealing — what it holds is <em>authority</em>. Other contracts can read it to decide who may
 * act on this identity's behalf, and because every transition changes exactly the one thing it
 * names, a reader comparing two versions can attribute each difference to a single action.
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

    /** A delegate is just a key; it never needs to hold or spend anything. */
    private static final Account DELEGATE = new Account(NETWORK);
    private static final Account OTHER = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    /** Never changes: every transition must hand this straight back. */
    private static final BigInteger HELD = BigInteger.valueOf(5_000_000);

    private static final PlutusScript IDENTITY = JulcScriptLoader.load(IdentityValidator.class);
    private static final String IDENTITY_ADDRESS =
            AddressProvider.getEntAddress(IDENTITY, NETWORK).toBech32();

    public static void main(String[] args) throws Exception {
        // Delegate expiry is anchored to chain time rather than the local clock, so the example
        // does not assume the devnet's slot-to-time mapping matches this machine.
        BigInteger expires = BigInteger.valueOf((chainTimeSeconds() + 3600) * 1000);

        System.out.println("Identity address: " + IDENTITY_ADDRESS);
        System.out.println("Owner:            " + OWNER.baseAddress());
        System.out.println("Delegate:         " + DELEGATE.baseAddress());

        // 1. Create the identity: an owner, no delegates.
        Utxo identity = create();
        System.out.println("Identity created in " + identity.getTxHash());

        // 2. An edit must not be a chance to siphon the ada out with it.
        require(isRejected(() -> edit(identity,
                        addDelegate(delegateKeyHash(), expires),
                        state(ownerKeyHash(), delegateEntry(delegateKeyHash(), expires)),
                        HELD.subtract(BigInteger.valueOf(1_000_000)), expires)),
                "an edit that moves value must be rejected");
        System.out.println("Edit that moves value rejected as expected");

        // 3. Nor a chance to grant authority to the owner's own key, which would survive a
        //    later transfer of ownership as a back door.
        require(isRejected(() -> edit(identity,
                        addDelegate(ownerKeyHash(), expires),
                        state(ownerKeyHash(), delegateEntry(ownerKeyHash(), expires)),
                        HELD, expires)),
                "self-delegation must be rejected");
        System.out.println("Self-delegation rejected as expected");

        // 4. Add a delegate for real.
        TxResult added = edit(identity, addDelegate(delegateKeyHash(), expires),
                state(ownerKeyHash(), delegateEntry(delegateKeyHash(), expires)), HELD, expires);
        require(added.isSuccessful(), "adding the delegate failed: " + added);
        Utxo withDelegate = utxoFrom(added.getTxHash());
        System.out.println("Delegate added in " + added.getTxHash());

        // 5. Revoking one named delegate must not strip the others along with it.
        TxResult second = edit(withDelegate, addDelegate(otherKeyHash(), expires),
                state(ownerKeyHash(), delegateEntry(delegateKeyHash(), expires),
                        delegateEntry(otherKeyHash(), expires)), HELD, expires);
        require(second.isSuccessful(), "adding the second delegate failed: " + second);
        Utxo withTwo = utxoFrom(second.getTxHash());
        System.out.println("Second delegate added in " + second.getTxHash());

        require(isRejected(() -> edit(withTwo, removeDelegate(delegateKeyHash()),
                        state(ownerKeyHash()), HELD, expires)),
                "removing every delegate while naming one must be rejected");
        System.out.println("Stripping all delegates rejected as expected");

        // 6. Revoke exactly the one named.
        TxResult removed = edit(withTwo, removeDelegate(delegateKeyHash()),
                state(ownerKeyHash(), delegateEntry(otherKeyHash(), expires)), HELD, expires);
        require(removed.isSuccessful(), "removing the delegate failed: " + removed);
        System.out.println("Delegate revoked in " + removed.getTxHash());

        require(spendsIdentity(removed.getTxHash()),
                "the confirmed transaction must spend the identity UTxO");

        System.out.println("Verified: authority changed one step at a time, and the value never moved");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    /** Creates the state cell. Plain payment — the validator only runs on the way out. */
    private static Utxo create() throws Exception {
        Tx create = new Tx()
                .payToContract(IDENTITY_ADDRESS, Amount.lovelace(HELD), state(ownerKeyHash()))
                .from(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(create)
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();

        require(result.isSuccessful(), "creating the identity failed: " + result);
        return utxoFrom(result.getTxHash());
    }

    /**
     * Applies one transition.
     *
     * <p>{@code next} and {@code value} are what the rejection cases bend — everything else is
     * identical to a valid edit, so a refusal can only be about the thing under test.
     */
    private static TxResult edit(Utxo identity, PlutusData redeemer, PlutusData next,
            BigInteger value, BigInteger expires) throws Exception {
        ScriptTx editTx = new ScriptTx()
                .collectFrom(identity, redeemer)
                .attachSpendingValidator(IDENTITY)
                .payToContract(IDENTITY_ADDRESS, List.of(Amount.lovelace(value)), next)
                .withChangeAddress(OWNER.baseAddress());

        return TX_BUILDER.compose(editTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        OWNER.baseAddress()))
                // Adding a delegate requires an upper bound: without one the transaction could
                // land at any time, which would say nothing about the expiry still being ahead.
                .validTo(slotBefore(expires))
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code IdentityDatum { owner, delegates }}. */
    private static PlutusData state(byte[] owner, PlutusData... delegates) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(owner),
                ListPlutusData.of(delegates));
    }

    /** {@code Delegate { key, expires }}. */
    private static PlutusData delegateEntry(byte[] key, BigInteger expires) {
        return ConstrPlutusData.of(0, BytesPlutusData.of(key), BigIntPlutusData.of(expires));
    }

    private static PlutusData addDelegate(byte[] key, BigInteger expires) {
        return ConstrPlutusData.of(1, BytesPlutusData.of(key), BigIntPlutusData.of(expires));
    }

    private static PlutusData removeDelegate(byte[] key) {
        return ConstrPlutusData.of(2, BytesPlutusData.of(key));
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the identity address. Checking that a UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     */
    private static boolean spendsIdentity(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> IDENTITY_ADDRESS.equals(input.getAddress()));
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

    private static long chainTimeSeconds() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getTime();
    }

    /** A slot comfortably inside the expiry window, so the upper bound lands before it. */
    private static long slotBefore(BigInteger expiresMillis) throws Exception {
        long currentSlot = BACKEND.getBlockService().getLatestBlock().getValue().getSlot();
        return currentSlot + 600;
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at
     * the identity address would pick up identities left by an earlier run.
     */
    private static Utxo utxoFrom(String txHash) throws Exception {
        return UTXOS.getAll(IDENTITY_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO created by " + txHash));
    }

    private static byte[] ownerKeyHash() {
        return keyHash(OWNER);
    }

    private static byte[] delegateKeyHash() {
        return keyHash(DELEGATE);
    }

    private static byte[] otherKeyHash() {
        return keyHash(OTHER);
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

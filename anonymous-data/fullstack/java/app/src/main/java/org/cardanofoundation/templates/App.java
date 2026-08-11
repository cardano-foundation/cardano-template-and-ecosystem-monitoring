package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

import org.cardanofoundation.templates.validator.AnonymousDataValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
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
 * Commit and reveal, without putting an identity on-chain.
 *
 * <p>The commit publishes only {@code blake2b_256(pubKeyHash ++ nonce)} as a token name. Nobody
 * can tell which key made it, and because the nonce is secret nobody can test a guess either.
 * The reveal later proves ownership by reconstructing that digest.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account, which plays the committer. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    /** Kept off-chain. Publishing it would make the commitment guessable. */
    private static final byte[] NONCE = "a secret nonce".getBytes(StandardCharsets.UTF_8);

    private static final Network NETWORK = Networks.testnet();
    private static final Account OWNER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final PlutusScript SCRIPT = JulcScriptLoader.load(AnonymousDataValidator.class);
    private static final String SCRIPT_ADDRESS =
            AddressProvider.getEntAddress(SCRIPT, NETWORK).getAddress();

    public static void main(String[] args) throws Exception {
        byte[] commitment = commitment(ownerKeyHash(), NONCE);

        System.out.println("Script address: " + SCRIPT_ADDRESS);
        System.out.println("Commitment (the only thing published): "
                + HexUtil.encodeHexString(commitment));

        // 1. Commit: mint the marker and park it at the script with the payload attached.
        Utxo committed = commit(commitment);

        // 2. Without the nonce the commitment cannot be opened, even by its own author.
        require(isRejected(committed, "not the nonce".getBytes(StandardCharsets.UTF_8)),
                "a reveal with the wrong nonce must be rejected");
        System.out.println("Reveal with a wrong nonce rejected as expected");

        // 3. Reveal: the owner reconstructs the digest from their key hash and the nonce.
        String revealTx = reveal(committed, NONCE);
        System.out.println("Reveal confirmed in " + revealTx);
        require(spendsScriptAddress(revealTx), "the reveal must consume the script UTxO");

        System.out.println("Verified: the commitment was opened only by the key that made it");
    }

    /**
     * Mints one marker named after the commitment and sends it to the script with an inline
     * datum. The validator requires both — a marker with nowhere to live would strand the
     * payload.
     */
    private static Utxo commit(byte[] commitment) throws Exception {
        Asset marker = Asset.builder()
                .name("0x" + HexUtil.encodeHexString(commitment))
                .value(BigInteger.ONE)
                .build();

        // The redeemer names the commitment being minted; the validator checks the mint field
        // actually contains it, so the redeemer alone cannot authorise a different marker.
        PlutusData redeemer = BytesPlutusData.of(commitment);

        ScriptTx commitTx = new ScriptTx()
                .mintAsset(SCRIPT, List.of(marker), redeemer, SCRIPT_ADDRESS, PlutusData.unit());

        TxResult result = TX_BUILDER.compose(commitTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();
        require(result.isSuccessful(), "the commit failed: " + result);
        System.out.println("Committed in " + result.getTxHash());

        // Match on this transaction's hash. A devnet is long-lived, so simply taking the
        // first UTxO at the script address can pick up leftovers from an earlier run.
        return UTXOS.getAll(SCRIPT_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no script UTxO created by " + result.getTxHash()));
    }

    /** Spends the marker, proving the signer can reconstruct the committed digest. */
    private static String reveal(Utxo committed, byte[] nonce) throws Exception {
        TxResult result = openCommitment(committed, nonce);
        require(result.isSuccessful(), "the reveal failed: " + result);
        return result.getTxHash();
    }

    private static TxResult openCommitment(Utxo committed, byte[] nonce) throws Exception {
        ScriptTx revealTx = new ScriptTx()
                .collectFrom(committed, BytesPlutusData.of(nonce))
                .attachSpendingValidator(SCRIPT)
                // The marker moves to the owner. An explicit output is required, not just a
                // change address: the marker is a native token and cannot simply be dropped,
                // and cardano-client-lib only fills in the transaction body — and so can only
                // resolve this input's redeemer index — once the spend has somewhere to go.
                .payToAddress(OWNER.baseAddress(), committed.getAmount())
                .withChangeAddress(OWNER.baseAddress());

        return TX_BUILDER.compose(revealTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new Address(OWNER.baseAddress()))
                .completeAndWait();
    }

    /**
     * Attempts a reveal and reports whether the chain refused it.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a
     * failed result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Utxo committed, byte[] nonce) {
        try {
            return !openCommitment(committed, nonce).isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
    }

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the script address. Checking that the UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     *
     * <p>Polls, because a node confirms a transaction slightly before the indexer serves it.
     */
    private static boolean spendsScriptAddress(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            Optional<Boolean> spent = readInputs(txHash);
            if (spent.isPresent()) {
                return spent.get();
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    /** Empty while the transaction is not yet indexed. */
    private static Optional<Boolean> readInputs(String txHash) {
        try {
            var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
            if (!response.isSuccessful()) {
                return Optional.empty();
            }
            return Optional.of(response.getValue().getInputs().stream()
                    .anyMatch(input -> SCRIPT_ADDRESS.equals(input.getAddress())));
        } catch (Exception notIndexedYet) {
            return Optional.empty();
        }
    }

    /**
     * {@code blake2b_256(keyHash ++ nonce)}.
     *
     * <p>Hashed with cardano-client-lib rather than julc's {@code CryptoLib}: those methods are
     * compile-time intrinsics for the on-chain compiler and throw when called on the JVM.
     */
    private static byte[] commitment(byte[] keyHash, byte[] nonce) {
        byte[] preimage = new byte[keyHash.length + nonce.length];
        System.arraycopy(keyHash, 0, preimage, 0, keyHash.length);
        System.arraycopy(nonce, 0, preimage, keyHash.length, nonce.length);
        return Blake2bUtil.blake2bHash256(preimage);
    }

    private static byte[] ownerKeyHash() {
        return OWNER.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

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

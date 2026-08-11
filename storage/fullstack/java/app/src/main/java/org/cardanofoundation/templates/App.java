package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Optional;

import org.cardanofoundation.templates.validator.StorageMintValidator;
import org.cardanofoundation.templates.validator.StorageValidator;

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
 * A verifiable audit registry: publish the fingerprint of a dataset, permanently.
 *
 * <p>Each snapshot becomes an NFT locked at a script that refuses every spend. Nobody — not
 * even the publisher — can revise or withdraw an entry afterwards, which is what makes the
 * record worth citing. The dataset itself stays off chain; only its SHA-256 commitment is
 * published, so anyone holding the data can prove it matches, and nobody else learns anything.
 *
 * <p>This example publishes one snapshot and then shows the three ways the design refuses to
 * bend: the entry cannot be spent, its datum cannot disagree with what was minted, and it
 * cannot be sent anywhere it could be traded.
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
    private static final Account PUBLISHER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    /** The dataset being attested. Only its digest is ever published. */
    private static final String SNAPSHOT_DATA = "account,balance\ntreasury,1000000\nreserve,250000";

    private static final int DAILY = 0;

    /** Never parameterised, so the registry has one address for every snapshot ever published. */
    private static final PlutusScript STORAGE = JulcScriptLoader.load(StorageValidator.class);
    private static final String STORAGE_ADDRESS =
            AddressProvider.getEntAddress(STORAGE, NETWORK).toBech32();

    public static void main(String[] args) throws Exception {
        byte[] snapshotId = uniqueSnapshotId();
        byte[] commitment = sha256(SNAPSHOT_DATA.getBytes(StandardCharsets.UTF_8));

        System.out.println("Registry address: " + STORAGE_ADDRESS);
        System.out.println("Snapshot id:      " + new String(snapshotId, StandardCharsets.UTF_8));
        System.out.println("Commitment:       " + HexUtil.encodeHexString(commitment));

        // One seed backs everything below. The refused attempts run first and are never
        // submitted, so the seed is still unspent when the real publication uses it — which
        // means each refusal differs from the success by exactly one thing.
        Utxo seed = pickSeed();

        // 1. The datum is checked against the redeemer at mint time. That is the only moment
        //    anything about this entry can ever be checked, so it has to bite here.
        byte[] otherCommitment = sha256("a different dataset".getBytes(StandardCharsets.UTF_8));
        require(isRejected(() -> publishWithDatum(seed, snapshotId, DAILY, commitment,
                        otherCommitment, STORAGE_ADDRESS)),
                "a datum that disagrees with the redeemer must be rejected");
        System.out.println("Publication with a mismatched datum rejected as expected");

        // 2. An entry in a wallet would be transferable, so the policy refuses to mint one.
        require(isRejected(() -> publishWithDatum(seed, snapshotId, DAILY, commitment,
                        commitment, PUBLISHER.baseAddress())),
                "sending the snapshot NFT to a wallet must be rejected");
        System.out.println("Publication to a wallet address rejected as expected");

        // 3. The same seed, the same snapshot, nothing bent — this one goes through.
        String publishTx = publish(seed, snapshotId, DAILY, commitment, STORAGE_ADDRESS);
        System.out.println("Published in " + publishTx);
        require(entryLandedAtRegistry(publishTx, policyIdFor(seed), assetName(snapshotId)),
                "the snapshot NFT must be locked at the registry address");

        // 4. The record is permanent: there is no path that lets the UTxO leave the script.
        Utxo entry = registryEntryFrom(publishTx);
        require(isRejected(() -> spendEntry(entry)),
                "spending a published snapshot must be rejected");
        System.out.println("Attempt to spend the published snapshot rejected as expected");

        System.out.println("Verified: the snapshot is on chain and can never be altered");
    }

    // ── Publishing ────────────────────────────────────────────────────────────────────

    private static String publish(Utxo seed, byte[] snapshotId, int snapshotType,
            byte[] commitment, String destination) throws Exception {
        TxResult result = publishWithDatum(seed, snapshotId, snapshotType, commitment,
                commitment, destination);
        require(result.isSuccessful(), "publishing failed: " + result);
        return result.getTxHash();
    }

    /**
     * Mints the snapshot NFT and locks it at {@code destination}.
     *
     * <p>{@code datumCommitment} is separate from {@code commitment} only so the example can
     * build the one shape the policy must refuse: a datum that does not match what was minted.
     */
    private static TxResult publishWithDatum(Utxo seed, byte[] snapshotId, int snapshotType,
            byte[] commitment, byte[] datumCommitment, String destination) throws Exception {
        PlutusScript policy = policyFor(seed);

        Asset entry = Asset.builder()
                .name("0x" + HexUtil.encodeHexString(assetName(snapshotId)))
                .value(BigInteger.ONE)
                .build();

        // Spending the seed is what makes the policy one-shot, so it has to be an input.
        Tx seedTx = new Tx()
                .collectFrom(List.of(seed))
                .from(PUBLISHER.baseAddress());

        ScriptTx publishTx = new ScriptTx()
                .mintAsset(policy, List.of(entry),
                        mintRedeemer(snapshotId, snapshotType, commitment),
                        destination,
                        registryDatum(snapshotId, snapshotType, datumCommitment));

        return TX_BUILDER.compose(seedTx, publishTx)
                .feePayer(PUBLISHER.baseAddress())
                .withSigner(SignerProviders.signerFrom(PUBLISHER))
                .completeAndWait();
    }

    /** The policy's hash depends on the seed, so every snapshot gets its own policy id. */
    private static PlutusScript policyFor(Utxo seed) throws Exception {
        return JulcScriptLoader.load(StorageMintValidator.class,
                outputReference(seed),
                BytesPlutusData.of(STORAGE.getScriptHash()));
    }

    private static String policyIdFor(Utxo seed) throws Exception {
        return policyFor(seed).getPolicyId();
    }

    /** Attempts to spend a published entry — which the registry script never permits. */
    private static TxResult spendEntry(Utxo entry) throws Exception {
        ScriptTx spendTx = new ScriptTx()
                .collectFrom(entry, PlutusData.unit())
                .attachSpendingValidator(STORAGE)
                .payToAddress(PUBLISHER.baseAddress(), entry.getAmount())
                .withChangeAddress(PUBLISHER.baseAddress());

        return TX_BUILDER.compose(spendTx)
                .feePayer(PUBLISHER.baseAddress())
                .withSigner(SignerProviders.signerFrom(PUBLISHER))
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code RegistryDatum { snapshotId, snapshotType, commitmentHash, publishedAt }}. */
    private static PlutusData registryDatum(byte[] snapshotId, int snapshotType,
            byte[] commitment) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(snapshotId),
                ConstrPlutusData.of(snapshotType),
                BytesPlutusData.of(commitment),
                BigIntPlutusData.of(System.currentTimeMillis() / 1000));
    }

    /** {@code MintRedeemer { snapshotId, snapshotType, commitmentHash }}. */
    private static PlutusData mintRedeemer(byte[] snapshotId, int snapshotType,
            byte[] commitment) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(snapshotId),
                ConstrPlutusData.of(snapshotType),
                BytesPlutusData.of(commitment));
    }

    /** A Plutus {@code TxOutRef}: the transaction hash and the output index within it. */
    private static PlutusData outputReference(Utxo utxo) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(HexUtil.decodeHexString(utxo.getTxHash())),
                BigIntPlutusData.of(utxo.getOutputIndex()));
    }

    /** The policy derives the token name itself, so the caller cannot choose it. */
    private static byte[] assetName(byte[] snapshotId) {
        return sha256(snapshotId);
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the policy ran: the confirmed transaction must have an output at
     * the registry address holding exactly one token of the expected policy and name.
     *
     * <p>Polls, because a node confirms a transaction slightly before the indexer serves it.
     */
    private static boolean entryLandedAtRegistry(String txHash, String policyId, byte[] name)
            throws Exception {
        String unit = policyId + HexUtil.encodeHexString(name);

        for (int attempt = 0; attempt < 10; attempt++) {
            Optional<Boolean> landed = readOutputs(txHash, unit);
            if (landed.isPresent()) {
                return landed.get();
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    /** Empty while the transaction is not yet indexed. */
    private static Optional<Boolean> readOutputs(String txHash, String unit) {
        try {
            var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
            if (!response.isSuccessful()) {
                return Optional.empty();
            }
            return Optional.of(response.getValue().getOutputs().stream()
                    .filter(output -> STORAGE_ADDRESS.equals(output.getAddress()))
                    // The backend model reports quantities as strings, so compare as strings —
                    // BigInteger.ONE.equals("1") compiles and is silently always false.
                    .anyMatch(output -> output.getAmount().stream()
                            .anyMatch(amount -> unit.equals(amount.getUnit())
                                    && "1".equals(amount.getQuantity()))));
        } catch (Exception notIndexedYet) {
            return Optional.empty();
        }
    }

    /**
     * Reports whether the chain refused a transaction.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a
     * failed result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Attempt attempt) {
        try {
            return !attempt.run().isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    // ── Wallet helpers ────────────────────────────────────────────────────────────────

    /** An ada-only UTxO big enough to seed the publication and cover fees. */
    private static Utxo pickSeed() throws Exception {
        // Any UTxO with enough ada will do. It deliberately does *not* require an ada-only
        // UTxO: on a long-lived devnet every UTxO eventually carries leftover tokens from
        // earlier examples, and native tokens on the seed are simply returned as change.
        return UTXOS.getAll(PUBLISHER.baseAddress()).stream()
                .filter(utxo -> lovelaceOf(utxo).compareTo(BigInteger.valueOf(10_000_000)) >= 0)
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no UTxO of at least 10 ada to seed the publication"));
    }

    private static BigInteger lovelaceOf(Utxo utxo) {
        return utxo.getAmount().stream()
                .filter(amount -> "lovelace".equals(amount.getUnit()))
                .map(Amount::getQuantity)
                .findFirst()
                .orElse(BigInteger.ZERO);
    }

    private static Utxo registryEntryFrom(String txHash) throws Exception {
        // Match on this transaction's hash: a devnet is long-lived, so taking the first UTxO at
        // the registry address would pick up entries published by an earlier run.
        return UTXOS.getAll(STORAGE_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no registry entry created by " + txHash));
    }

    /**
     * A snapshot id is unique per run, so repeated runs against a long-lived devnet publish
     * distinct entries instead of colliding on the derived token name.
     */
    private static byte[] uniqueSnapshotId() {
        return ("2025-12-19-" + System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] sha256(byte[] input) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(input);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
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

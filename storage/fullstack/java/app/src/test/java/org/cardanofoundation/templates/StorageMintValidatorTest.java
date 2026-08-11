package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.StorageMintValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.DatumHash;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.PolicyId;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.ledger.ScriptHash;
import com.bloxbean.cardano.julc.ledger.TokenName;
import com.bloxbean.cardano.julc.ledger.TxId;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled policy on a real Plutus VM, so these tests exercise the same UPLC the chain
 * would execute — not the Java source.
 *
 * <p>Each test moves exactly one thing away from a valid publication and expects a rejection.
 * That matters more here than in most contracts: the registry is unspendable, so a rule that
 * fails to bite at mint time is a rule that never bites at all.
 */
class StorageMintValidatorTest {

    private static final byte[] POLICY_HASH = fill((byte) 0x09, 28);
    private static final PolicyId POLICY = PolicyId.of(POLICY_HASH);

    private static final byte[] STORAGE_HASH = fill((byte) 0x07, 28);
    private static final Address STORAGE = new Address(
            new Credential.ScriptCredential(new ScriptHash(STORAGE_HASH)), Optional.empty());

    /** Somewhere the entry must never end up: an ordinary wallet. */
    private static final Address WALLET = new Address(
            new Credential.PubKeyCredential(new PubKeyHash(fill((byte) 0x02, 28))), Optional.empty());

    private static final TxOutRef SEED =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);
    private static final TxOutRef OTHER_UTXO =
            new TxOutRef(new TxId(fill((byte) 0xBB, 32)), BigInteger.ONE);

    private static final byte[] SNAPSHOT_ID = "2025-12-19".getBytes(StandardCharsets.UTF_8);
    private static final byte[] COMMITMENT = sha256("the canonical snapshot bytes");
    private static final byte[] ASSET_NAME = sha256(SNAPSHOT_ID);

    private static final int DAILY = 0;
    private static final int MONTHLY = 1;

    private final JulcEval eval = JulcEval.forClass(
            StorageMintValidator.class,
            SEED.toPlutusData(),
            bytesData(STORAGE_HASH));

    // ── The one valid shape ───────────────────────────────────────────────────────────

    @Test
    void publishesASnapshot() {
        assertTrue(publish(valid()));
    }

    @Test
    void publishesAMonthlySnapshot() {
        assertTrue(publish(valid().snapshotType(MONTHLY)));
    }

    // ── One-shot ──────────────────────────────────────────────────────────────────────

    /** Without the seed UTxO the policy could run again and mint a second, competing entry. */
    @Test
    void rejectsWhenTheSeedUtxoIsNotSpent() {
        assertFalse(publish(valid().spending(OTHER_UTXO)));
    }

    // ── What gets minted ──────────────────────────────────────────────────────────────

    /** The name is derived from the snapshot id, so a caller cannot choose it. */
    @Test
    void rejectsAnAssetNameThatIsNotTheSnapshotDigest() {
        assertFalse(publish(valid().assetName("2025-12-19".getBytes(StandardCharsets.UTF_8))));
    }

    @Test
    void rejectsMintingMoreThanOne() {
        assertFalse(publish(valid().quantity(2)));
    }

    @Test
    void rejectsMintingNothing() {
        assertFalse(publish(valid().mintNothing()));
    }

    /** Counting the whole policy is what stops extra assets riding along with the entry. */
    @Test
    void rejectsSmugglingASecondTokenIntoTheSameMint() {
        assertFalse(publish(valid().alsoMint("passenger", 1)));
    }

    // ── Where it lands ────────────────────────────────────────────────────────────────

    /** An entry in a wallet is transferable, which is the opposite of a permanent record. */
    @Test
    void rejectsSendingTheEntryToAWallet() {
        assertFalse(publish(valid().payTo(WALLET)));
    }

    @Test
    void rejectsSplittingAcrossTwoStorageOutputs() {
        assertFalse(publish(valid().duplicateStorageOutput()));
    }

    /** A datum hash would leave the record unreadable on chain. */
    @Test
    void rejectsADatumThatIsNotInline() {
        assertFalse(publish(valid().datumByHash()));
    }

    // ── What gets written ─────────────────────────────────────────────────────────────

    @Test
    void rejectsADatumNamingADifferentSnapshot() {
        assertFalse(publish(valid().datumSnapshotId("2025-12-20".getBytes(StandardCharsets.UTF_8))));
    }

    @Test
    void rejectsADatumWithADifferentSnapshotType() {
        assertFalse(publish(valid().datumSnapshotType(MONTHLY)));
    }

    @Test
    void rejectsADatumWithADifferentCommitment() {
        assertFalse(publish(valid().datumCommitment(sha256("some other data"))));
    }

    /** A commitment that is not a SHA-256 digest cannot be checked against anything later. */
    @Test
    void rejectsACommitmentThatIsNotThirtyTwoBytes() {
        byte[] tooShort = Arrays.copyOf(COMMITMENT, 31);
        assertFalse(publish(valid().commitment(tooShort)));
    }

    @Test
    void rejectsAnEmptySnapshotId() {
        assertFalse(publish(valid().snapshotId(new byte[0])));
    }

    // ── Scenario builder ──────────────────────────────────────────────────────────────

    private boolean publish(Publication p) {
        return eval.call("mint", p.redeemer(), p.context()).asBoolean();
    }

    private static Publication valid() {
        return new Publication();
    }

    /**
     * A valid publication that individual tests bend one field at a time. Every mutator returns
     * {@code this}, so a test reads as "the valid case, except …".
     */
    private static final class Publication {
        private TxOutRef spent = SEED;
        private byte[] snapshotId = SNAPSHOT_ID;
        private int snapshotType = DAILY;
        private byte[] commitment = COMMITMENT;
        private byte[] assetName = ASSET_NAME;
        private long quantity = 1;
        private boolean mintAnything = true;
        private String extraToken;
        private long extraQuantity;
        private Address payee = STORAGE;
        private boolean secondStorageOutput;
        private boolean inlineDatum = true;

        // The datum defaults to restating the redeemer; these override it independently.
        private byte[] datumSnapshotId;
        private Integer datumSnapshotType;
        private byte[] datumCommitment;

        Publication spending(TxOutRef ref) { spent = ref; return this; }
        Publication snapshotId(byte[] id) { snapshotId = id; return this; }
        Publication snapshotType(int type) { snapshotType = type; return this; }
        Publication commitment(byte[] c) { commitment = c; return this; }
        Publication assetName(byte[] name) { assetName = name; return this; }
        Publication quantity(long q) { quantity = q; return this; }
        Publication mintNothing() { mintAnything = false; return this; }
        Publication alsoMint(String name, long q) { extraToken = name; extraQuantity = q; return this; }
        Publication payTo(Address address) { payee = address; return this; }
        Publication duplicateStorageOutput() { secondStorageOutput = true; return this; }
        Publication datumByHash() { inlineDatum = false; return this; }
        Publication datumSnapshotId(byte[] id) { datumSnapshotId = id; return this; }
        Publication datumSnapshotType(int type) { datumSnapshotType = type; return this; }
        Publication datumCommitment(byte[] c) { datumCommitment = c; return this; }

        PlutusData redeemer() {
            return constrData(0, bytesData(snapshotId), constrData(snapshotType),
                    bytesData(commitment));
        }

        PlutusData context() {
            ScriptContextTestBuilder builder = ScriptContextTestBuilder.minting(POLICY)
                    .input(new TxInInfo(spent, new TxOut(WALLET,
                            Value.lovelace(BigInteger.valueOf(10_000_000)),
                            new OutputDatum.NoOutputDatum(), Optional.empty())))
                    .mint(minted())
                    .output(entryOutput(payee));

            if (secondStorageOutput) {
                builder = builder.output(entryOutput(STORAGE));
            }
            return builder.buildPlutusData();
        }

        private Value minted() {
            Value value = mintAnything
                    ? Value.singleton(POLICY, new TokenName(assetName), BigInteger.valueOf(quantity))
                    : Value.lovelace(BigInteger.ONE);

            if (extraToken != null) {
                value = value.merge(Value.singleton(POLICY,
                        new TokenName(extraToken.getBytes(StandardCharsets.UTF_8)),
                        BigInteger.valueOf(extraQuantity)));
            }
            return value;
        }

        private TxOut entryOutput(Address address) {
            Value held = Value.lovelace(BigInteger.valueOf(2_000_000))
                    .merge(Value.singleton(POLICY, new TokenName(assetName), BigInteger.ONE));

            OutputDatum datum = inlineDatum
                    ? new OutputDatum.OutputDatumInline(datum())
                    : new OutputDatum.OutputDatumHash(new DatumHash(fill((byte) 0x11, 32)));

            return new TxOut(address, held, datum, Optional.empty());
        }

        private PlutusData datum() {
            return constrData(0,
                    bytesData(datumSnapshotId != null ? datumSnapshotId : snapshotId),
                    constrData(datumSnapshotType != null ? datumSnapshotType : snapshotType),
                    bytesData(datumCommitment != null ? datumCommitment : commitment),
                    intData(1_700_000_000L));
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    /** julc's CryptoLib is a compile-time intrinsic and throws on the JVM, so hash here. */
    private static byte[] sha256(byte[] input) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(input);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] sha256(String input) {
        return sha256(input.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

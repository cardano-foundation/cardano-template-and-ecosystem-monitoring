package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.AnonymousDataValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
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
 * Runs the compiled validator on a real Plutus VM, so these tests exercise the same UPLC the
 * chain would execute — not the Java source.
 */
class AnonymousDataValidatorTest {

    private static final byte[] SCRIPT_HASH = fill((byte) 0x09, 28);
    private static final PolicyId POLICY = PolicyId.of(SCRIPT_HASH);
    private static final Address SCRIPT =
            new Address(new Credential.ScriptCredential(new ScriptHash(SCRIPT_HASH)), Optional.empty());

    private static final byte[] OWNER = fill((byte) 0x01, 28);
    private static final byte[] STRANGER = fill((byte) 0x02, 28);
    private static final byte[] NONCE = "a secret nonce".getBytes(StandardCharsets.UTF_8);

    /** The commitment the owner would publish: blake2b_256(ownerKeyHash ++ nonce). */
    private static final byte[] COMMITMENT = commitment(OWNER, NONCE);

    private static final TxOutRef OWN_REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(AnonymousDataValidator.class);

    // ── Commit ────────────────────────────────────────────────────────────────────────

    @Test
    void commitMintsTheMarkerAndParksItWithADatum() {
        assertTrue(mint(COMMITMENT, marker(COMMITMENT, 1), commitOutput(COMMITMENT, true)));
    }

    /** A marker that goes nowhere useful would leave the payload unreachable. */
    @Test
    void commitFailsWhenTheMarkerIsNotStoredWithADatum() {
        assertFalse(mint(COMMITMENT, marker(COMMITMENT, 1), commitOutput(COMMITMENT, false)));
    }

    /** One marker per commitment, so it cannot be split or duplicated. */
    @Test
    void commitFailsWhenMoreThanOneMarkerIsMinted() {
        assertFalse(mint(COMMITMENT, marker(COMMITMENT, 2), commitOutput(COMMITMENT, true)));
    }

    @Test
    void commitFailsWhenNothingIsMinted() {
        assertFalse(mint(COMMITMENT, Value.lovelace(BigInteger.ONE), commitOutput(COMMITMENT, true)));
    }

    // ── Reveal ────────────────────────────────────────────────────────────────────────

    @Test
    void revealSucceedsForTheCommitter() {
        assertTrue(spend(NONCE, COMMITMENT, OWNER));
    }

    @Test
    void revealFailsWithTheWrongNonce() {
        assertFalse(spend("not the nonce".getBytes(StandardCharsets.UTF_8), COMMITMENT, OWNER));
    }

    /**
     * The commitment binds a specific key. Another signer holding the nonce still cannot open
     * it, because their key hash produces a different digest.
     */
    @Test
    void revealFailsForADifferentSigner() {
        assertFalse(spend(NONCE, COMMITMENT, STRANGER));
    }

    /** Reading the commitment from the token means a spender cannot substitute their own. */
    @Test
    void revealFailsAgainstSomeoneElsesCommitment() {
        assertFalse(spend(NONCE, commitment(STRANGER, NONCE), OWNER));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private boolean mint(byte[] id, Value minted, TxOut output) {
        PlutusData ctx = ScriptContextTestBuilder.minting(POLICY)
                .mint(minted)
                .output(output)
                .buildPlutusData();
        return eval.call("mint", bytesData(id), ctx).asBoolean();
    }

    private boolean spend(byte[] nonce, byte[] committedId, byte[] signer) {
        TxOut held = new TxOut(SCRIPT, marker(committedId, 1),
                new OutputDatum.OutputDatumInline(unitData()), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.spending(OWN_REF)
                .input(new TxInInfo(OWN_REF, held))
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
        return eval.call("spend", bytesData(nonce), ctx).asBoolean();
    }

    private static TxOut commitOutput(byte[] id, boolean inlineDatum) {
        OutputDatum datum = inlineDatum
                ? new OutputDatum.OutputDatumInline(unitData())
                : new OutputDatum.NoOutputDatum();
        return new TxOut(SCRIPT, marker(id, 1), datum, Optional.empty());
    }

    /** A value holding {@code quantity} of the commitment marker under this policy. */
    private static Value marker(byte[] id, long quantity) {
        return Value.singleton(POLICY, new TokenName(id), BigInteger.valueOf(quantity));
    }

    private static byte[] commitment(byte[] keyHash, byte[] nonce) {
        byte[] preimage = new byte[keyHash.length + nonce.length];
        System.arraycopy(keyHash, 0, preimage, 0, keyHash.length);
        System.arraycopy(nonce, 0, preimage, keyHash.length, nonce.length);
        // The JDK has no blake2b; julc's CryptoLib is a compile-time intrinsic that throws on
        // the JVM, so the test side hashes with cardano-client-lib instead.
        return Blake2bUtil.blake2bHash256(preimage);
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.randomTxOutRef_typed;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;

import org.cardanofoundation.templates.validator.SimpleTransferValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled validator on a real Plutus VM, so these tests exercise the same UPLC the
 * chain would execute — not the Java source.
 */
class SimpleTransferValidatorTest {

    private static final byte[] RECEIVER = keyHash((byte) 0x01);
    private static final byte[] STRANGER = keyHash((byte) 0x02);

    /** The receiver is applied as a parameter, exactly as it is on-chain. */
    private final JulcEval eval = JulcEval.forClass(SimpleTransferValidator.class, bytesData(RECEIVER));

    @Test
    void theReceiverCanSpend() {
        assertTrue(run(signedBy(RECEIVER)));
    }

    @Test
    void nobodyElseCanSpend() {
        assertFalse(run(signedBy(STRANGER)));
    }

    @Test
    void anUnsignedTransactionIsRejected() {
        assertFalse(run(ScriptContextTestBuilder.spending(randomTxOutRef_typed()).buildPlutusData()));
    }

    /**
     * A near-miss rather than an obviously different key: the hash is compared as bytes, so a
     * same-length variant proves the check is not just a length test.
     */
    @Test
    void aKeyDifferingByOneByteIsRejected() {
        byte[] nearMiss = RECEIVER.clone();
        nearMiss[27] ^= 0x01;

        assertFalse(run(signedBy(nearMiss)));
    }

    /** Signing alongside the receiver is fine — the receiver's approval is what matters. */
    @Test
    void anAdditionalSignerDoesNotBreakIt() {
        PlutusData ctx = ScriptContextTestBuilder.spending(randomTxOutRef_typed())
                .signer(new PubKeyHash(STRANGER))
                .signer(new PubKeyHash(RECEIVER))
                .buildPlutusData();

        assertTrue(run(ctx));
    }

    private boolean run(PlutusData ctx) {
        return eval.call("spend", unitData(), ctx).asBoolean();
    }

    private static PlutusData signedBy(byte[] signer) {
        return ScriptContextTestBuilder.spending(randomTxOutRef_typed())
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
    }

    private static byte[] keyHash(byte fill) {
        byte[] hash = new byte[28];
        Arrays.fill(hash, fill);
        return hash;
    }
}

package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.listData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.PaymentSplitterValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.ledger.ScriptHash;
import com.bloxbean.cardano.julc.ledger.TxId;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled validator on a real Plutus VM.
 *
 * <p>The interesting cases all revolve around the fee. Whoever submits pays it and gets change
 * back, so a naive reading of "who received what" credits them with their own money — which is
 * why the contract subtracts what they contributed. These tests check that correction from both
 * directions: it must not let the caller keep extra, and must not punish them for paying.
 */
class PaymentSplitterValidatorTest {

    private static final byte[] ALICE = fill((byte) 0x01, 28);
    private static final byte[] BOB = fill((byte) 0x02, 28);
    private static final byte[] CAROL = fill((byte) 0x03, 28);
    private static final byte[] OUTSIDER = fill((byte) 0x04, 28);

    private static final Address SPLITTER = new Address(
            new Credential.ScriptCredential(new ScriptHash(fill((byte) 0x07, 28))),
            Optional.empty());

    private static final BigInteger POT = BigInteger.valueOf(9_000_000);
    private static final BigInteger SHARE = BigInteger.valueOf(3_000_000);
    private static final BigInteger FEE = BigInteger.valueOf(300_000);
    private static final BigInteger CALLER_INPUT = BigInteger.valueOf(5_000_000);

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);
    private static final TxOutRef CALLER_REF =
            new TxOutRef(new TxId(fill((byte) 0xBB, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(PaymentSplitterValidator.class,
            listData(bytesData(ALICE), bytesData(BOB), bytesData(CAROL)));

    @Test
    void splitsEqually() {
        assertTrue(run(null, pay(ALICE, SHARE), pay(BOB, SHARE), pay(CAROL, SHARE)));
    }

    @Test
    void rejectsAnUnequalSplit() {
        assertFalse(run(null, pay(ALICE, SHARE.add(BigInteger.ONE)), pay(BOB, SHARE),
                pay(CAROL, SHARE)));
    }

    @Test
    void rejectsLeavingAPayeeOut() {
        assertFalse(run(null, pay(ALICE, BigInteger.valueOf(4_500_000)),
                pay(BOB, BigInteger.valueOf(4_500_000))));
    }

    /** The closed set: a slice must not be routed outside the group. */
    @Test
    void rejectsPayingAnOutsider() {
        assertFalse(run(null, pay(ALICE, SHARE), pay(BOB, SHARE), pay(OUTSIDER, SHARE)));
    }

    /** Not even the script itself may keep a remainder. */
    @Test
    void rejectsLeavingChangeAtTheScript() {
        TxOut leftover = new TxOut(SPLITTER, Value.lovelace(BigInteger.valueOf(1_000_000)),
                new OutputDatum.NoOutputDatum(), Optional.empty());
        assertFalse(run(null, pay(ALICE, BigInteger.valueOf(2_666_666)),
                pay(BOB, BigInteger.valueOf(2_666_666)),
                pay(CAROL, BigInteger.valueOf(2_666_668)), leftover));
    }

    /** Alice submits: she brings ada, pays the fee, and receives her share plus her change. */
    @Test
    void callerPayingTheFeeStillSplitsEqually() {
        BigInteger change = CALLER_INPUT.subtract(FEE);
        assertTrue(run(ALICE, pay(ALICE, SHARE.add(change)), pay(BOB, SHARE), pay(CAROL, SHARE)));
    }

    /** The correction must not become a loophole for the caller to keep a little extra. */
    @Test
    void callerCannotSkimUnderCoverOfTheirChange() {
        BigInteger change = CALLER_INPUT.subtract(FEE);
        assertFalse(run(ALICE, pay(ALICE, SHARE.add(change).add(BigInteger.valueOf(500_000))),
                pay(BOB, SHARE), pay(CAROL, SHARE)));
    }

    /** Nor may the caller be shortchanged for having covered the fee. */
    @Test
    void callerIsNotPenalisedForTheFee() {
        BigInteger change = CALLER_INPUT.subtract(FEE);
        assertFalse(run(ALICE,
                pay(ALICE, SHARE.add(change).subtract(BigInteger.valueOf(500_000))),
                pay(BOB, SHARE), pay(CAROL, SHARE)));
    }

    /** Any payee may call it, not just the first in the list. */
    @Test
    void anyPayeeMayTriggerTheSplit() {
        BigInteger change = CALLER_INPUT.subtract(FEE);
        assertTrue(run(CAROL, pay(ALICE, SHARE), pay(BOB, SHARE), pay(CAROL, SHARE.add(change))));
    }

    private boolean run(byte[] caller, TxOut... outputs) {
        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, new TxOut(SPLITTER, Value.lovelace(POT),
                        new OutputDatum.NoOutputDatum(), Optional.empty())))
                .fee(FEE);

        if (caller != null) {
            builder = builder.input(new TxInInfo(CALLER_REF,
                    new TxOut(wallet(caller), Value.lovelace(CALLER_INPUT),
                            new OutputDatum.NoOutputDatum(), Optional.empty())));
        }
        for (TxOut output : outputs) {
            builder = builder.output(output);
        }
        return eval.call("spend", unitData(), unitData(), builder.buildPlutusData()).asBoolean();
    }

    private static TxOut pay(byte[] payee, BigInteger lovelace) {
        return new TxOut(wallet(payee), Value.lovelace(lovelace),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static Address wallet(byte[] keyHash) {
        return new Address(new Credential.PubKeyCredential(new PubKeyHash(keyHash)),
                Optional.empty());
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

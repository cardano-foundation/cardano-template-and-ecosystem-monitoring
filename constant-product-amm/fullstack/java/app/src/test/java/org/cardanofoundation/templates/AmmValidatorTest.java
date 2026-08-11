package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.boolData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.AmmValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.PolicyId;
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
 * Runs the compiled multi-validator on a real Plutus VM.
 *
 * <p>An AMM is arithmetic guarding money, so the tests pull in two directions: the maths must be
 * right, and — more importantly — a correct-looking datum must not be accepted while the actual
 * tokens go somewhere else. That second concern is what the reserve-binding tests cover.
 */
class AmmValidatorTest {

    private static final byte[] SCRIPT_HASH = fill((byte) 0x07, 28);
    private static final Address POOL = new Address(
            new Credential.ScriptCredential(new ScriptHash(SCRIPT_HASH)), Optional.empty());

    private static final byte[] P0 = fill((byte) 0x0A, 28);
    private static final byte[] P1 = fill((byte) 0x0B, 28);
    private static final byte[] N0 = "TOKEN0".getBytes();
    private static final byte[] N1 = "TOKEN1".getBytes();

    /** 997/1000 — the familiar 0.3% fee. */
    private static final BigInteger FEE_NUM = BigInteger.valueOf(997);
    private static final BigInteger FEE_DEN = BigInteger.valueOf(1000);

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(AmmValidator.class,
            bytesData(P0), bytesData(N0), bytesData(P1), bytesData(N1),
            intData(FEE_NUM), intData(FEE_DEN));

    // ── Depositing ────────────────────────────────────────────────────────────────────

    /** The first deposit mints sqrt(x0·x1): sqrt(1000 * 4000) = 2000. */
    @Test
    void firstDepositMintsGeometricMean() {
        assertTrue(spend(datum(0, 0, 0), datum(1000, 4000, 2000),
                deposit(1000, 4000), 1000, 4000));
    }

    @Test
    void firstDepositRejectsAnInflatedLpClaim() {
        assertFalse(spend(datum(0, 0, 0), datum(1000, 4000, 2001),
                deposit(1000, 4000), 1000, 4000));
    }

    @Test
    void firstDepositRejectsAnUndersizedLpClaim() {
        assertFalse(spend(datum(0, 0, 0), datum(1000, 4000, 1999),
                deposit(1000, 4000), 1000, 4000));
    }

    /** Depositing off-ratio would move the price in the depositor's favour. */
    @Test
    void laterDepositMustMatchTheRatio() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(1100, 4100, 2100),
                deposit(100, 100), 1100, 4100));
    }

    @Test
    void laterDepositOnRatioMintsProportionally() {
        assertTrue(spend(datum(1000, 4000, 2000), datum(1100, 4400, 2200),
                deposit(100, 400), 1100, 4400));
    }

    @Test
    void depositRejectsNonPositiveAmounts() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(1000, 4000, 2000),
                deposit(0, 0), 1000, 4000));
    }

    // ── Redeeming ─────────────────────────────────────────────────────────────────────

    @Test
    void redeemReturnsAProportionalSlice() {
        assertTrue(spend(datum(1000, 4000, 2000), datum(500, 2000, 1000),
                redeem(1000), 500, 2000));
    }

    @Test
    void redeemCannotTakeMoreThanTheShare() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(400, 2000, 1000),
                redeem(1000), 400, 2000));
    }

    @Test
    void redeemCannotExceedSupply() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(0, 0, 0),
                redeem(2001), 0, 0));
    }

    // ── Swapping ──────────────────────────────────────────────────────────────────────

    /** 100 in against 1000/4000 at 0.3%: out = 4000*99700 / (1000*1000 + 99700) = 362. */
    @Test
    void swapFollowsTheCurve() {
        assertTrue(spend(datum(1000, 4000, 2000), datum(1100, 3638, 2000),
                swap(true, 100, 0), 1100, 3638));
    }

    /** Taking one more than the curve allows breaks the invariant. */
    @Test
    void swapCannotTakeMoreThanTheCurveAllows() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(1100, 3637, 2000),
                swap(true, 100, 0), 1100, 3637));
    }

    @Test
    void swapRespectsSlippageBound() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(1100, 3638, 2000),
                swap(true, 100, 400), 1100, 3638));
    }

    @Test
    void swapCannotMintLpOnTheSide() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(1100, 3638, 2500),
                swap(true, 100, 0), 1100, 3638));
    }

    // ── Binding the datum to the tokens ───────────────────────────────────────────────

    /**
     * The rule the whole contract rests on: arithmetic that balances on paper must not be
     * accepted while the real reserves are sent elsewhere.
     */
    @Test
    void datumMustMatchTheTokensActuallyHeld() {
        assertFalse(spend(datum(1000, 4000, 2000), datum(1100, 3638, 2000),
                swap(true, 100, 0), 1100, 0));
        assertFalse(spend(datum(1000, 4000, 2000), datum(1100, 3638, 2000),
                swap(true, 100, 0), 0, 3638));
    }

    // ── Minting LP ────────────────────────────────────────────────────────────────────

    /** The mint endpoint only reconciles the LP delta with the datum transition. */
    @Test
    void mintReconcilesTheLpDelta() {
        assertTrue(mintLp(datum(0, 0, 0), datum(1000, 4000, 2000), 2000));
    }

    @Test
    void mintRejectsAnLpDeltaThatDisagreesWithTheDatum() {
        assertFalse(mintLp(datum(0, 0, 0), datum(1000, 4000, 2000), 1999));
    }

    /** Burning LP is the same rule with the sign reversed. */
    @Test
    void burnReconcilesTheLpDelta() {
        assertTrue(mintLp(datum(1000, 4000, 2000), datum(500, 2000, 1000), -1000));
    }

    private boolean mintLp(PlutusData before, PlutusData after, long lpDelta) {
        TxOut poolIn = new TxOut(POOL, reserves(1000, 4000),
                new OutputDatum.OutputDatumInline(before), Optional.empty());
        TxOut poolOut = new TxOut(POOL, reserves(1000, 4000),
                new OutputDatum.OutputDatumInline(after), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.minting(PolicyId.of(SCRIPT_HASH))
                .input(new TxInInfo(REF, poolIn))
                .output(poolOut)
                .mint(Value.singleton(PolicyId.of(SCRIPT_HASH), new TokenName("LP".getBytes()),
                        BigInteger.valueOf(lpDelta)))
                .buildPlutusData();

        return eval.call("mint", unitData(), ctx).asBoolean();
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean spend(PlutusData before, PlutusData after, PlutusData redeemer,
            long heldT0, long heldT1) {
        TxOut input = new TxOut(POOL, reserves(1000, 4000),
                new OutputDatum.OutputDatumInline(before), Optional.empty());
        TxOut output = new TxOut(POOL, reserves(heldT0, heldT1),
                new OutputDatum.OutputDatumInline(after), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, input))
                .output(output)
                .buildPlutusData();

        return eval.call("spend", before, redeemer, ctx).asBoolean();
    }

    private static PlutusData datum(long r0, long r1, long lp) {
        return constrData(0, intData(r0), intData(r1), intData(lp));
    }

    private static PlutusData deposit(long x0, long x1) {
        return constrData(0, intData(x0), intData(x1));
    }

    private static PlutusData redeem(long lp) {
        return constrData(1, intData(lp));
    }

    private static PlutusData swap(boolean t0In, long amountIn, long minOut) {
        return constrData(2, boolData(t0In), intData(amountIn), intData(minOut));
    }

    private static Value reserves(long r0, long r1) {
        Value value = Value.lovelace(BigInteger.valueOf(2_000_000));
        if (r0 > 0) {
            value = value.merge(Value.singleton(PolicyId.of(P0), new TokenName(N0),
                    BigInteger.valueOf(r0)));
        }
        if (r1 > 0) {
            value = value.merge(Value.singleton(PolicyId.of(P1), new TokenName(N1),
                    BigInteger.valueOf(r1)));
        }
        return value;
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

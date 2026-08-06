package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.mapData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

import org.cardanofoundation.templates.validator.CrowdfundValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBound;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
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
 * <p>An all-or-nothing crowdfund has one thing it must never get wrong: a donor may recover
 * exactly their own contribution, and nobody else's. Most of these tests probe that boundary from
 * both directions — over-claiming on the way in, and double-claiming on the way out.
 */
class CrowdfundValidatorTest {

    private static final byte[] BENEFICIARY = fill((byte) 0x01, 28);
    private static final byte[] ALICE = fill((byte) 0x02, 28);
    private static final byte[] BOB = fill((byte) 0x03, 28);
    private static final byte[] STRANGER = fill((byte) 0x04, 28);

    private static final Address CAMPAIGN = new Address(
            new Credential.ScriptCredential(new ScriptHash(fill((byte) 0x07, 28))),
            Optional.empty());

    private static final BigInteger GOAL = BigInteger.valueOf(10_000_000);
    private static final BigInteger DEADLINE = BigInteger.valueOf(1_000_000);

    private static final BigInteger ALICE_GAVE = BigInteger.valueOf(4_000_000);
    private static final BigInteger BOB_GAVE = BigInteger.valueOf(3_000_000);
    private static final BigInteger RAISED = ALICE_GAVE.add(BOB_GAVE);

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(CrowdfundValidator.class,
            bytesData(BENEFICIARY), intData(GOAL), intData(DEADLINE));

    // ── Donating ──────────────────────────────────────────────────────────────────────

    /**
     * A campaign is seeded by its first donor, who is credited with everything in it — including
     * the minimum ada the UTxO needs to exist, since the ledger must account for every lovelace.
     */
    @Test
    void firstDonorSeedsTheCampaign() {
        assertTrue(donate(ledger(), BigInteger.ZERO, ledgerWith(ALICE, ALICE_GAVE), ALICE_GAVE));
    }

    @Test
    void bobAddsToAnExistingCampaign() {
        assertTrue(donate(ledgerWith(ALICE, ALICE_GAVE), ALICE_GAVE,
                ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), RAISED));
    }

    /** The pot has to actually grow; a "donation" that shrinks it is a withdrawal. */
    @Test
    void donationMustIncreaseTheBalance() {
        assertFalse(donate(ledgerWith(ALICE, ALICE_GAVE), ALICE_GAVE,
                ledgerWith(ALICE, ALICE_GAVE), ALICE_GAVE));
    }

    /**
     * The ledger must sum to the exact balance. Writing yourself in for more than you gave would
     * let you reclaim other people's money if the campaign failed.
     */
    @Test
    void donorCannotOverstateTheirContribution() {
        assertFalse(donate(ledger(), BigInteger.ZERO,
                ledgerWith(ALICE, ALICE_GAVE.multiply(BigInteger.TWO)), ALICE_GAVE));
    }

    /** Understating is refused too — the money would become unattributable. */
    @Test
    void ledgerCannotUndercountTheBalance() {
        assertFalse(donate(ledger(), BigInteger.ZERO,
                ledgerWith(ALICE, ALICE_GAVE.subtract(BigInteger.ONE)), ALICE_GAVE));
    }

    // ── Withdrawing ───────────────────────────────────────────────────────────────────

    @Test
    void beneficiaryWithdrawsAFundedCampaign() {
        assertTrue(withdraw(GOAL, BENEFICIARY, after(DEADLINE)));
    }

    /** All-or-nothing: short of the goal, the beneficiary gets nothing. */
    @Test
    void beneficiaryCannotWithdrawAShortCampaign() {
        assertFalse(withdraw(GOAL.subtract(BigInteger.ONE), BENEFICIARY, after(DEADLINE)));
    }

    @Test
    void beneficiaryCannotWithdrawEarly() {
        assertFalse(withdraw(GOAL, BENEFICIARY, before(DEADLINE)));
    }

    @Test
    void strangerCannotWithdraw() {
        assertFalse(withdraw(GOAL, STRANGER, after(DEADLINE)));
    }

    @Test
    void withdrawRejectsAnUnboundedValidityRange() {
        assertFalse(withdraw(GOAL, BENEFICIARY, unbounded()));
    }

    // ── Reclaiming ────────────────────────────────────────────────────────────────────

    /** Both donors reclaim together and drain the UTxO. */
    @Test
    void allDonorsReclaimTogether() {
        assertTrue(reclaimAll(ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), RAISED,
                List.of(ALICE, BOB), after(DEADLINE)));
    }

    /** Past the goal, the money belongs to the beneficiary and cannot be pulled back. */
    @Test
    void cannotReclaimFromAnOverfundedCampaign() {
        BigInteger over = GOAL.add(BigInteger.ONE);
        assertFalse(reclaimAll(ledgerWith(ALICE, over), over, List.of(ALICE), after(DEADLINE)));
    }

    /**
     * Exactly on the goal, <em>both</em> exits are open: withdrawal needs {@code balance >= goal}
     * and a full reclaim needs {@code balance <= goal}, so whoever submits first decides.
     *
     * <p>This is faithful to the Aiken original rather than a slip in the port — it is asserted
     * here so the ambiguity is recorded rather than discovered later.
     */
    @Test
    void exactlyOnTheGoalBothExitsAreOpen() {
        assertTrue(withdraw(GOAL, BENEFICIARY, after(DEADLINE)));
        assertTrue(reclaimAll(ledgerWith(ALICE, GOAL), GOAL, List.of(ALICE), after(DEADLINE)));
    }

    @Test
    void cannotReclaimBeforeTheDeadline() {
        assertFalse(reclaimAll(ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), RAISED,
                List.of(ALICE, BOB), before(DEADLINE)));
    }

    /** Alice leaves, Bob stays: the UTxO must be rebuilt for whoever is still owed. */
    @Test
    void oneDonorReclaimsAndRebuildsTheCampaign() {
        assertTrue(reclaimPartial(ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), RAISED,
                List.of(ALICE), ledgerWith(BOB, BOB_GAVE), BOB_GAVE, after(DEADLINE)));
    }

    /**
     * Anti-replay. Leaving the reclaiming donor in the ledger would let them come back and be
     * paid for the same contribution twice.
     */
    @Test
    void reclaimingDonorMustBeStruckFromTheLedger() {
        assertFalse(reclaimPartial(ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), RAISED,
                List.of(ALICE), ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), BOB_GAVE,
                after(DEADLINE)));
    }

    /** A donor may take their own stake, not more. */
    @Test
    void donorCannotTakeMoreThanTheyGave() {
        assertFalse(reclaimPartial(ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), RAISED,
                List.of(ALICE), ledgerWith(BOB, BOB_GAVE),
                BOB_GAVE.subtract(BigInteger.valueOf(1_000_000)), after(DEADLINE)));
    }

    /** Someone who never donated is owed nothing, so they cannot drain the campaign. */
    @Test
    void nonDonorCannotReclaim() {
        assertFalse(reclaimAll(ledgerWith(ALICE, ALICE_GAVE, BOB, BOB_GAVE), RAISED,
                List.of(STRANGER), after(DEADLINE)));
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean donate(PlutusData before, BigInteger heldBefore, PlutusData after,
            BigInteger heldAfter) {
        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, campaign(before, heldBefore)))
                .output(campaign(after, heldAfter))
                .validRange(unbounded());
        // Donate is constructor 0 of Action.
        return eval.call("spend", before, constrData(0), builder.buildPlutusData()).asBoolean();
    }

    private boolean withdraw(BigInteger held, byte[] signer, Interval range) {
        PlutusData datum = ledgerWith(ALICE, held);
        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, campaign(datum, held)))
                .signer(new PubKeyHash(signer))
                .validRange(range)
                .buildPlutusData();
        // Withdraw is constructor 1 of Action.
        return eval.call("spend", datum, constrData(1), ctx).asBoolean();
    }

    private boolean reclaimAll(PlutusData datum, BigInteger held, List<byte[]> signers,
            Interval range) {
        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, campaign(datum, held)))
                .validRange(range);

        for (byte[] signer : signers) {
            builder = builder.signer(new PubKeyHash(signer));
        }
        // Reclaim is constructor 2 of Action.
        return eval.call("spend", datum, constrData(2), builder.buildPlutusData()).asBoolean();
    }

    private boolean reclaimPartial(PlutusData datum, BigInteger held, List<byte[]> signers,
            PlutusData remaining, BigInteger left, Interval range) {
        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, campaign(datum, held)))
                .output(campaign(remaining, left))
                .validRange(range);

        for (byte[] signer : signers) {
            builder = builder.signer(new PubKeyHash(signer));
        }
        return eval.call("spend", datum, constrData(2), builder.buildPlutusData()).asBoolean();
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────

    private static TxOut campaign(PlutusData datum, BigInteger lovelace) {
        return new TxOut(CAMPAIGN, Value.lovelace(lovelace),
                new OutputDatum.OutputDatumInline(datum), Optional.empty());
    }

    /** {@code CrowdfundDatum { wallets }} — a map of donor to amount. */
    private static PlutusData ledger() {
        return constrData(0, mapData());
    }

    private static PlutusData ledgerWith(byte[] donor, BigInteger amount) {
        return constrData(0, mapData(bytesData(donor), intData(amount)));
    }

    private static PlutusData ledgerWith(byte[] a, BigInteger aAmount,
            byte[] b, BigInteger bAmount) {
        return constrData(0, mapData(bytesData(a), intData(aAmount),
                bytesData(b), intData(bAmount)));
    }

    private static Interval after(BigInteger from) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(from.add(BigInteger.ONE)), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static Interval before(BigInteger from) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(
                        from.subtract(BigInteger.ONE)), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static Interval unbounded() {
        return new Interval(
                new IntervalBound(new IntervalBoundType.NegInf(), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

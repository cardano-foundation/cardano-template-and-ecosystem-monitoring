package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.EscrowValidator;
import org.junit.jupiter.api.Test;

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
class EscrowValidatorTest {

    private static final byte[] INITIATOR_KEY = fill((byte) 0x01, 28);
    private static final byte[] RECIPIENT_KEY = fill((byte) 0x02, 28);
    private static final byte[] STRANGER_KEY = fill((byte) 0x03, 28);
    private static final byte[] SCRIPT_KEY = fill((byte) 0x09, 28);

    private static final Address INITIATOR = pubKeyAddress(INITIATOR_KEY);
    private static final Address RECIPIENT = pubKeyAddress(RECIPIENT_KEY);
    private static final Address SCRIPT = scriptAddress(SCRIPT_KEY);

    private static final Value INITIATOR_SIDE = ada(10);
    private static final Value RECIPIENT_SIDE = ada(15);

    private static final TxOutRef OWN_REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(EscrowValidator.class);

    // ── RecipientDeposit: Initiation → ActiveEscrow ───────────────────────────────────

    @Test
    void depositAdvancesToActiveEscrow() {
        assertTrue(run(initiation(), depositRedeemer(),
                builder().input(scriptInput(initiation(), INITIATOR_SIDE))
                        .output(scriptOutput(activeEscrow(), ada(25)))));
    }

    /** The recipient must actually put up their side, not merely be named in the redeemer. */
    @Test
    void depositFailsWhenTheRecipientUnderpays() {
        assertFalse(run(initiation(), depositRedeemer(),
                builder().input(scriptInput(initiation(), INITIATOR_SIDE))
                        .output(scriptOutput(activeEscrow(), ada(20)))));
    }

    /** The initiator's locked side must survive the transition untouched. */
    @Test
    void depositFailsWhenTheInitiatorTermsAreRewritten() {
        // Initiator swapped out for the recipient, so the recipient would collect both sides.
        PlutusData tampered = activeEscrow(RECIPIENT, INITIATOR_SIDE, RECIPIENT, RECIPIENT_SIDE);

        assertFalse(run(initiation(), depositRedeemer(),
                builder().input(scriptInput(initiation(), INITIATOR_SIDE))
                        .output(scriptOutput(tampered, ada(25)))));
    }

    // ── CompleteTrade ─────────────────────────────────────────────────────────────────

    @Test
    void completeSwapsTheBundlesWhenBothPartiesSign() {
        assertTrue(run(activeEscrow(), completeRedeemer(),
                builder().input(scriptInput(activeEscrow(), ada(25)))
                        .output(payTo(INITIATOR, RECIPIENT_SIDE))
                        .output(payTo(RECIPIENT, INITIATOR_SIDE))
                        .signer(new PubKeyHash(INITIATOR_KEY))
                        .signer(new PubKeyHash(RECIPIENT_KEY))));
    }

    /** Neither party can force settlement alone. */
    @Test
    void completeFailsWithOnlyTheInitiatorSignature() {
        assertFalse(run(activeEscrow(), completeRedeemer(),
                builder().input(scriptInput(activeEscrow(), ada(25)))
                        .output(payTo(INITIATOR, RECIPIENT_SIDE))
                        .output(payTo(RECIPIENT, INITIATOR_SIDE))
                        .signer(new PubKeyHash(INITIATOR_KEY))));
    }

    /** Signing is not enough — the bundles must actually cross over. */
    @Test
    void completeFailsWhenTheInitiatorIsShortChanged() {
        assertFalse(run(activeEscrow(), completeRedeemer(),
                builder().input(scriptInput(activeEscrow(), ada(25)))
                        .output(payTo(INITIATOR, ada(1)))
                        .output(payTo(RECIPIENT, INITIATOR_SIDE))
                        .signer(new PubKeyHash(INITIATOR_KEY))
                        .signer(new PubKeyHash(RECIPIENT_KEY))));
    }

    @Test
    void completeFailsBeforeTheRecipientHasJoined() {
        assertFalse(run(initiation(), completeRedeemer(),
                builder().input(scriptInput(initiation(), INITIATOR_SIDE))
                        .output(payTo(INITIATOR, INITIATOR_SIDE))
                        .signer(new PubKeyHash(INITIATOR_KEY))));
    }

    // ── CancelTrade ───────────────────────────────────────────────────────────────────

    @Test
    void initiatorCanCancelBeforeTheRecipientJoins() {
        assertTrue(run(initiation(), cancelRedeemer(),
                builder().input(scriptInput(initiation(), INITIATOR_SIDE))
                        .output(payTo(INITIATOR, INITIATOR_SIDE))
                        .signer(new PubKeyHash(INITIATOR_KEY))));
    }

    @Test
    void aStrangerCannotCancel() {
        assertFalse(run(initiation(), cancelRedeemer(),
                builder().input(scriptInput(initiation(), INITIATOR_SIDE))
                        .output(payTo(INITIATOR, INITIATOR_SIDE))
                        .signer(new PubKeyHash(STRANGER_KEY))));
    }

    /** Either party may unwind an active escrow, but both deposits must go home. */
    @Test
    void cancelRefundsBothSides() {
        assertTrue(run(activeEscrow(), cancelRedeemer(),
                builder().input(scriptInput(activeEscrow(), ada(25)))
                        .output(payTo(INITIATOR, INITIATOR_SIDE))
                        .output(payTo(RECIPIENT, RECIPIENT_SIDE))
                        .signer(new PubKeyHash(RECIPIENT_KEY))));
    }

    /**
     * The whole point of the two-sided refund rule: one party must not be able to cancel and
     * pocket the other's deposit.
     */
    @Test
    void cancelFailsWhenOnePartyKeepsTheOthersDeposit() {
        assertFalse(run(activeEscrow(), cancelRedeemer(),
                builder().input(scriptInput(activeEscrow(), ada(25)))
                        .output(payTo(INITIATOR, ada(25)))
                        .signer(new PubKeyHash(INITIATOR_KEY))));
    }

    // ── Double satisfaction ───────────────────────────────────────────────────────────

    /**
     * Two escrow UTxOs in one transaction must not both be settled by one set of payouts.
     * The validator runs per input, so without an input count check each run would see the
     * same outputs and independently approve.
     */
    @Test
    void completeFailsWithASecondScriptInput() {
        TxOutRef otherRef = new TxOutRef(new TxId(fill((byte) 0xBB, 32)), BigInteger.ONE);

        assertFalse(run(activeEscrow(), completeRedeemer(),
                builder().input(scriptInput(activeEscrow(), ada(25)))
                        .input(new TxInInfo(otherRef, scriptOutput(activeEscrow(), ada(25))))
                        .output(payTo(INITIATOR, RECIPIENT_SIDE))
                        .output(payTo(RECIPIENT, INITIATOR_SIDE))
                        .signer(new PubKeyHash(INITIATOR_KEY))
                        .signer(new PubKeyHash(RECIPIENT_KEY))));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private boolean run(PlutusData datum, PlutusData redeemer, ScriptContextTestBuilder ctx) {
        return eval.call("spend", datum, redeemer, ctx.buildPlutusData()).asBoolean();
    }

    private static ScriptContextTestBuilder builder() {
        return ScriptContextTestBuilder.spending(OWN_REF);
    }

    // Datums and redeemers are built as raw PlutusData rather than as the validator's own
    // records: the testkit converts julc ledger types and primitives, not user records.
    // Constructor indices follow the `permits` order, which is what julc lowers to.

    private static PlutusData initiation() {
        return constrData(0, INITIATOR.toPlutusData(), INITIATOR_SIDE.toPlutusData());
    }

    private static PlutusData activeEscrow() {
        return activeEscrow(INITIATOR, INITIATOR_SIDE, RECIPIENT, RECIPIENT_SIDE);
    }

    private static PlutusData activeEscrow(Address initiator, Value initiatorAssets,
                                           Address recipient, Value recipientAssets) {
        return constrData(1, initiator.toPlutusData(), initiatorAssets.toPlutusData(),
                recipient.toPlutusData(), recipientAssets.toPlutusData());
    }

    private static PlutusData depositRedeemer() {
        return constrData(0, RECIPIENT.toPlutusData(), RECIPIENT_SIDE.toPlutusData());
    }

    private static PlutusData cancelRedeemer() {
        return constrData(1);
    }

    private static PlutusData completeRedeemer() {
        return constrData(2);
    }

    private static TxInInfo scriptInput(PlutusData datum, Value value) {
        return new TxInInfo(OWN_REF, scriptOutput(datum, value));
    }

    private static TxOut scriptOutput(PlutusData datum, Value value) {
        return new TxOut(SCRIPT, value,
                new OutputDatum.OutputDatumInline(datum), Optional.empty());
    }

    private static TxOut payTo(Address address, Value value) {
        return new TxOut(address, value, new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static Value ada(long amount) {
        return Value.singleton(PolicyId.ADA, TokenName.EMPTY,
                BigInteger.valueOf(amount).multiply(BigInteger.valueOf(1_000_000)));
    }

    private static Address pubKeyAddress(byte[] keyHash) {
        return new Address(new Credential.PubKeyCredential(new PubKeyHash(keyHash)), Optional.empty());
    }

    private static Address scriptAddress(byte[] scriptHash) {
        return new Address(new Credential.ScriptCredential(new ScriptHash(scriptHash)), Optional.empty());
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

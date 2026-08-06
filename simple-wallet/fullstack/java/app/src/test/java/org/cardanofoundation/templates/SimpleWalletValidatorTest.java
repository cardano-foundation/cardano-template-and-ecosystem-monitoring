package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.FundsValidator;
import org.cardanofoundation.templates.validator.PaymentIntentValidator;
import org.cardanofoundation.templates.validator.WalletValidator;
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
 * Runs all three compiled scripts on a real Plutus VM.
 *
 * <p>The design's claim is that an intent and a signature are each necessary and neither is
 * sufficient. These tests attack that from both sides: an execution that pays the wrong party or
 * the wrong amount, and one that never burns the marker so it could be replayed.
 */
class SimpleWalletValidatorTest {

    private static final byte[] OWNER = fill((byte) 0x01, 28);
    private static final byte[] STRANGER = fill((byte) 0x02, 28);

    private static final byte[] WALLET_POLICY = fill((byte) 0x09, 28);
    private static final byte[] MARKER = "INTENT_MARKER".getBytes(StandardCharsets.UTF_8);

    private static final byte[] INTENT_HASH = fill((byte) 0x07, 28);
    private static final Address INTENT = new Address(
            new Credential.ScriptCredential(new ScriptHash(INTENT_HASH)), Optional.empty());

    private static final byte[] FUNDS_HASH = fill((byte) 0x0A, 28);
    private static final Address FUNDS = new Address(
            new Credential.ScriptCredential(new ScriptHash(FUNDS_HASH)), Optional.empty());

    private static final byte[] RECIPIENT_KEY = fill((byte) 0x33, 28);
    private static final Address RECIPIENT = wallet(RECIPIENT_KEY);
    private static final Address SOMEONE_ELSE = wallet(fill((byte) 0x44, 28));

    private static final BigInteger AMOUNT = BigInteger.valueOf(5_000_000);

    private static final TxOutRef FUNDS_REF =
            new TxOutRef(new TxId(fill((byte) 0xBB, 32)), BigInteger.ZERO);
    private static final TxOutRef INTENT_REF =
            new TxOutRef(new TxId(fill((byte) 0xCC, 32)), BigInteger.ZERO);

    private final JulcEval intent = JulcEval.forClass(
            PaymentIntentValidator.class, bytesData(OWNER));

    private final JulcEval walletPolicy = JulcEval.forClass(
            WalletValidator.class, bytesData(OWNER), bytesData(INTENT_HASH));

    private final JulcEval funds = JulcEval.forClass(
            FundsValidator.class, bytesData(OWNER), bytesData(WALLET_POLICY));

    // ── Attaching an intent ───────────────────────────────────────────────────────────

    @Test
    void ownerCanAttachAnIntent() {
        assertTrue(mintMarker(OWNER, 1, INTENT, true));
    }

    @Test
    void strangerCannotAttachAnIntent() {
        assertFalse(mintMarker(STRANGER, 1, INTENT, true));
    }

    /** A marker away from the intent script would leave a token with no readable payload. */
    @Test
    void markerMustLandAtTheIntentScript() {
        assertFalse(mintMarker(OWNER, 1, wallet(OWNER), true));
    }

    @Test
    void markerMustCarryAnInlineIntent() {
        assertFalse(mintMarker(OWNER, 1, INTENT, false));
    }

    @Test
    void onlyOneMarkerPerIntent() {
        assertFalse(mintMarker(OWNER, 2, INTENT, true));
    }

    // ── Cancelling an intent ──────────────────────────────────────────────────────────

    @Test
    void ownerCanCancelAnIntent() {
        assertTrue(spendIntent(OWNER));
    }

    @Test
    void strangerCannotCancelAnIntent() {
        assertFalse(spendIntent(STRANGER));
    }

    @Test
    void ownerCanBurnAMarker() {
        assertTrue(burnMarker(OWNER, -1));
    }

    @Test
    void strangerCannotBurnAMarker() {
        assertFalse(burnMarker(STRANGER, -1));
    }

    // ── Executing an intent ───────────────────────────────────────────────────────────

    @Test
    void executesAPendingIntent() {
        assertTrue(execute(valid()));
    }

    /** Co-authorisation: the intent says what, the owner's signature says whether. */
    @Test
    void executionNeedsTheOwnersSignature() {
        assertFalse(execute(valid().signedBy(STRANGER)));
    }

    @Test
    void executionNeedsAnIntent() {
        assertFalse(execute(valid().withoutIntentInput()));
    }

    /** Two intents in one transaction leaves it ambiguous which one is being paid. */
    @Test
    void executionRejectsTwoIntents() {
        assertFalse(execute(valid().withSecondIntent()));
    }

    @Test
    void executionMustPayTheNamedRecipient() {
        assertFalse(execute(valid().payingTo(SOMEONE_ELSE)));
    }

    @Test
    void executionMustPayTheExactAmount() {
        assertFalse(execute(valid().paying(AMOUNT.subtract(BigInteger.ONE))));
    }

    /** Overpaying is still wrong: it is a transfer the owner never agreed to. */
    @Test
    void executionRejectsOverpayment() {
        assertFalse(execute(valid().paying(AMOUNT.add(BigInteger.valueOf(1_000_000)))));
    }

    /** Without the burn the marker survives and the same intent could be executed again. */
    @Test
    void executionMustBurnTheMarker() {
        assertFalse(execute(valid().withoutBurn()));
    }

    /** A payment may legitimately arrive split across outputs. */
    @Test
    void executionAcceptsASplitPayment() {
        assertTrue(execute(valid().paidInTwoParts()));
    }

    // ── Withdrawing ───────────────────────────────────────────────────────────────────

    @Test
    void ownerCanWithdraw() {
        assertTrue(withdraw(OWNER));
    }

    @Test
    void strangerCannotWithdraw() {
        assertFalse(withdraw(STRANGER));
    }

    // ── Builders ──────────────────────────────────────────────────────────────────────

    private boolean mintMarker(byte[] signer, long quantity, Address payee, boolean inlineDatum) {
        OutputDatum datum = inlineDatum
                ? new OutputDatum.OutputDatumInline(intentDatum(RECIPIENT_KEY, AMOUNT))
                : new OutputDatum.NoOutputDatum();

        PlutusData ctx = ScriptContextTestBuilder.minting(PolicyId.of(WALLET_POLICY))
                .mint(marker(quantity))
                .output(new TxOut(payee,
                        marker(1).merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                        datum, Optional.empty()))
                .signer(new PubKeyHash(signer))
                .buildPlutusData();

        return walletPolicy.call("mint", constrData(0), ctx).asBoolean();
    }

    private boolean burnMarker(byte[] signer, long quantity) {
        PlutusData ctx = ScriptContextTestBuilder.minting(PolicyId.of(WALLET_POLICY))
                .mint(marker(quantity))
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
        return walletPolicy.call("mint", constrData(1), ctx).asBoolean();
    }

    private boolean spendIntent(byte[] signer) {
        PlutusData ctx = ScriptContextTestBuilder.spending(INTENT_REF)
                .input(new TxInInfo(INTENT_REF, intentUtxo(RECIPIENT_KEY, AMOUNT)))
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
        return intent.call("spend", unitData(), unitData(), ctx).asBoolean();
    }

    private boolean withdraw(byte[] signer) {
        PlutusData ctx = ScriptContextTestBuilder.spending(FUNDS_REF)
                .input(new TxInInfo(FUNDS_REF, fundsUtxo()))
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
        // Withdraw is constructor 1 of Action.
        return funds.call("spend", unitData(), constrData(1), ctx).asBoolean();
    }

    private boolean execute(Execution e) {
        return funds.call("spend", unitData(), constrData(0), e.context()).asBoolean();
    }

    private static Execution valid() {
        return new Execution();
    }

    /** One valid ExecuteTx that each test bends in a single place. */
    private static final class Execution {
        private byte[] signer = OWNER;
        private boolean intentInput = true;
        private boolean secondIntent;
        private Address payee = RECIPIENT;
        private BigInteger paid = AMOUNT;
        private boolean burn = true;
        private boolean split;

        Execution signedBy(byte[] who) { signer = who; return this; }
        Execution withoutIntentInput() { intentInput = false; return this; }
        Execution withSecondIntent() { secondIntent = true; return this; }
        Execution payingTo(Address address) { payee = address; return this; }
        Execution paying(BigInteger amount) { paid = amount; return this; }
        Execution withoutBurn() { burn = false; return this; }
        Execution paidInTwoParts() { split = true; return this; }

        PlutusData context() {
            ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(FUNDS_REF)
                    .input(new TxInInfo(FUNDS_REF, fundsUtxo()))
                    .signer(new PubKeyHash(signer))
                    .mint(burn ? marker(-1) : Value.lovelace(BigInteger.ONE));

            if (intentInput) {
                builder = builder.input(
                        new TxInInfo(INTENT_REF, intentUtxo(RECIPIENT_KEY, AMOUNT)));
            }
            if (secondIntent) {
                TxOutRef other = new TxOutRef(new TxId(fill((byte) 0xDD, 32)), BigInteger.ZERO);
                builder = builder.input(
                        new TxInInfo(other, intentUtxo(RECIPIENT_KEY, AMOUNT)));
            }
            if (split) {
                BigInteger half = paid.divide(BigInteger.TWO);
                builder = builder.output(payment(payee, half))
                        .output(payment(payee, paid.subtract(half)));
            } else {
                builder = builder.output(payment(payee, paid));
            }
            return builder.buildPlutusData();
        }
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────

    private static TxOut payment(Address to, BigInteger lovelace) {
        return new TxOut(to, Value.lovelace(lovelace),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static TxOut intentUtxo(byte[] recipientKey, BigInteger amount) {
        return new TxOut(INTENT,
                marker(1).merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.OutputDatumInline(intentDatum(recipientKey, amount)),
                Optional.empty());
    }

    private static TxOut fundsUtxo() {
        return new TxOut(FUNDS, Value.lovelace(BigInteger.valueOf(20_000_000)),
                new OutputDatum.OutputDatumInline(unitData()), Optional.empty());
    }

    /** {@code PaymentIntent { recipient, lovelaceAmount, data }}. */
    private static PlutusData intentDatum(byte[] recipientKey, BigInteger amount) {
        PlutusData address = constrData(0,
                constrData(0, bytesData(recipientKey)),   // PubKeyCredential
                constrData(1));                            // no staking credential
        return constrData(0, address, intData(amount),
                bytesData("invoice-42".getBytes(StandardCharsets.UTF_8)));
    }

    private static Value marker(long quantity) {
        return Value.singleton(PolicyId.of(WALLET_POLICY), new TokenName(MARKER),
                BigInteger.valueOf(quantity));
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

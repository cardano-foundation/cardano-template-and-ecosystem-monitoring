package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.TokenTransferValidator;
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
 * Runs the compiled validator on a real Plutus VM.
 *
 * <p>The contract has two quite different modes, and the tests are grouped accordingly: a UTxO
 * holding the target asset is guarded, while one that does not is deliberately open to anyone.
 * The second is easy to mistake for a bug, so it is pinned explicitly.
 */
class TokenTransferValidatorTest {

    private static final byte[] RECEIVER = fill((byte) 0x01, 28);
    private static final byte[] STRANGER = fill((byte) 0x02, 28);

    private static final byte[] POLICY = fill((byte) 0x09, 28);
    private static final byte[] OTHER_POLICY = fill((byte) 0x0A, 28);
    private static final byte[] ASSET = "DELIVERY".getBytes(StandardCharsets.UTF_8);
    private static final byte[] OTHER_ASSET = "SOMETHING-ELSE".getBytes(StandardCharsets.UTF_8);

    private static final Address SCRIPT = new Address(
            new Credential.ScriptCredential(new ScriptHash(fill((byte) 0x07, 28))),
            Optional.empty());
    private static final Address OUTSIDE = new Address(
            new Credential.PubKeyCredential(new PubKeyHash(RECEIVER)), Optional.empty());

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(TokenTransferValidator.class,
            bytesData(RECEIVER), bytesData(POLICY), bytesData(ASSET));

    // ── Holding the target asset ──────────────────────────────────────────────────────

    @Test
    void receiverCollectsTheDelivery() {
        assertTrue(spend(held(), RECEIVER, delivered(OUTSIDE, token(POLICY, ASSET, 10))));
    }

    @Test
    void strangerCannotCollectTheDelivery() {
        assertFalse(spend(held(), STRANGER, delivered(OUTSIDE, token(POLICY, ASSET, 10))));
    }

    /** Re-locking is not a departure, so returning the asset here is fine. */
    @Test
    void receiverMayRelockTheDelivery() {
        assertTrue(spend(held(), RECEIVER, delivered(SCRIPT, token(POLICY, ASSET, 10))));
    }

    /**
     * The anti-batching rule. The receiver's signature should authorise collecting <em>this</em>
     * delivery, not act as blanket approval for whatever else shares the transaction.
     */
    @Test
    void cannotRouteAnotherPolicysTokenAway() {
        assertFalse(spend(held(), RECEIVER,
                delivered(OUTSIDE, token(POLICY, ASSET, 10)
                        .merge(token(OTHER_POLICY, OTHER_ASSET, 5)))));
    }

    /** Same rule, but for a different asset name under the very same policy. */
    @Test
    void cannotRouteAnotherAssetOfTheSamePolicyAway() {
        assertFalse(spend(held(), RECEIVER,
                delivered(OUTSIDE, token(POLICY, ASSET, 10)
                        .merge(token(POLICY, OTHER_ASSET, 5)))));
    }

    /** A foreign token sent to a separate output is still a departure. */
    @Test
    void cannotRouteAnotherTokenViaASeparateOutput() {
        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, held()))
                .output(delivered(OUTSIDE, token(POLICY, ASSET, 10)))
                .output(delivered(OUTSIDE, token(OTHER_POLICY, OTHER_ASSET, 5)))
                .signer(new PubKeyHash(RECEIVER))
                .buildPlutusData();

        assertFalse(eval.call("spend", unitData(), unitData(), ctx).asBoolean());
    }

    /** A foreign token that stays at the script has not left, so it is allowed. */
    @Test
    void aForeignTokenMayRemainAtTheScript() {
        assertTrue(spend(held(), RECEIVER,
                delivered(SCRIPT, token(POLICY, ASSET, 10)
                        .merge(token(OTHER_POLICY, OTHER_ASSET, 5)))));
    }

    /** Plain ada moving elsewhere is not a token departure. */
    @Test
    void adaMayLeaveFreely() {
        assertTrue(spend(held(), RECEIVER,
                new TxOut(OUTSIDE, Value.lovelace(BigInteger.valueOf(9_000_000)),
                        new OutputDatum.NoOutputDatum(), Optional.empty())));
    }

    // ── Not holding the target asset ──────────────────────────────────────────────────

    /**
     * The escape hatch. A UTxO here that does not hold the target asset is dust or a mistaken
     * transfer; without this branch it would be locked forever, since the receiver rule can
     * never be satisfied by a UTxO that lacks the asset.
     */
    @Test
    void anyoneMayRetrieveAMistakenTransfer() {
        TxOut stray = new TxOut(SCRIPT,
                token(OTHER_POLICY, OTHER_ASSET, 10)
                        .merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.NoOutputDatum(), Optional.empty());

        assertTrue(spend(stray, STRANGER, delivered(OUTSIDE, token(OTHER_POLICY, OTHER_ASSET, 10))));
    }

    /** Ada-only dust is likewise retrievable by anyone. */
    @Test
    void anyoneMayRetrieveAdaOnlyDust() {
        TxOut dust = new TxOut(SCRIPT, Value.lovelace(BigInteger.valueOf(2_000_000)),
                new OutputDatum.NoOutputDatum(), Optional.empty());

        assertTrue(spend(dust, STRANGER,
                new TxOut(OUTSIDE, Value.lovelace(BigInteger.valueOf(1_800_000)),
                        new OutputDatum.NoOutputDatum(), Optional.empty())));
    }

    /**
     * A different asset under the <em>target</em> policy still counts as "the policy is present",
     * so the guarded branch applies — and then fails, because the named asset is absent.
     */
    @Test
    void aSiblingAssetOfTheTargetPolicyIsStillGuarded() {
        TxOut sibling = new TxOut(SCRIPT,
                token(POLICY, OTHER_ASSET, 10)
                        .merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.NoOutputDatum(), Optional.empty());

        assertFalse(spend(sibling, STRANGER, delivered(OUTSIDE, token(POLICY, OTHER_ASSET, 10))));
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean spend(TxOut input, byte[] signer, TxOut output) {
        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, input))
                .output(output)
                .signer(new PubKeyHash(signer))
                .buildPlutusData();

        return eval.call("spend", unitData(), unitData(), ctx).asBoolean();
    }

    private static TxOut held() {
        return new TxOut(SCRIPT,
                token(POLICY, ASSET, 10).merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static TxOut delivered(Address to, Value value) {
        return new TxOut(to, value.merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static Value token(byte[] policy, byte[] name, long quantity) {
        return Value.singleton(PolicyId.of(policy), new TokenName(name),
                BigInteger.valueOf(quantity));
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

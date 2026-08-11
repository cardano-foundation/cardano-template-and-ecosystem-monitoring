package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.boolData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.EditableNftValidator;
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
 * Runs the compiled multi-validator on a real Plutus VM.
 *
 * <p>Two things hold this design together: the reference and user tokens are always created and
 * destroyed as a pair, and a sealed datum is genuinely final. The tests attack both, plus the
 * side door that a burn redeemer could otherwise open into minting.
 */
class EditableNftValidatorTest {

    /** The script hash doubles as the policy id, as for any multi-validator. */
    private static final byte[] SCRIPT_HASH = fill((byte) 0x07, 28);
    private static final Address SCRIPT = new Address(
            new Credential.ScriptCredential(new ScriptHash(SCRIPT_HASH)), Optional.empty());
    private static final Address WALLET = new Address(
            new Credential.PubKeyCredential(new PubKeyHash(fill((byte) 0x01, 28))),
            Optional.empty());

    private static final byte[] TOKEN_ID = "nft-001".getBytes(StandardCharsets.UTF_8);
    private static final byte[] OTHER_ID = "nft-002".getBytes(StandardCharsets.UTF_8);
    private static final byte[] DATA = "first draft".getBytes(StandardCharsets.UTF_8);
    private static final byte[] NEW_DATA = "revised".getBytes(StandardCharsets.UTF_8);

    /** CIP-67 labels, as raw bytes: 000643b0 (reference) and 000de140 (user). */
    private static final byte[] REF_LABEL = {0x00, 0x06, 0x43, (byte) 0xb0};
    private static final byte[] USER_LABEL = {0x00, 0x0d, (byte) 0xe1, 0x40};

    private static final TxOutRef SEED =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);
    private static final TxOutRef OTHER_UTXO =
            new TxOutRef(new TxId(fill((byte) 0xBB, 32)), BigInteger.ONE);
    private static final TxOutRef OWN_REF =
            new TxOutRef(new TxId(fill((byte) 0xCC, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(
            EditableNftValidator.class, SEED.toPlutusData());

    // ── Minting the pair ──────────────────────────────────────────────────────────────

    @Test
    void mintsAReferenceAndUserPair() {
        assertTrue(mint(SEED, datum(TOKEN_ID, DATA, false), SCRIPT, pair(TOKEN_ID)));
    }

    /** Without the seed the policy could run again and reissue the same token id. */
    @Test
    void mintRequiresTheSeedUtxo() {
        assertFalse(mint(OTHER_UTXO, datum(TOKEN_ID, DATA, false), SCRIPT, pair(TOKEN_ID)));
    }

    /** A reference token in a wallet would be governable by nobody. */
    @Test
    void referenceTokenMustLandAtTheScript() {
        assertFalse(mint(SEED, datum(TOKEN_ID, DATA, false), WALLET, pair(TOKEN_ID)));
    }

    /** The pair is the whole abstraction — a lone reference token has no owner. */
    @Test
    void mintRequiresBothHalvesOfThePair() {
        assertFalse(mint(SEED, datum(TOKEN_ID, DATA, false), SCRIPT, only(refName(TOKEN_ID))));
        assertFalse(mint(SEED, datum(TOKEN_ID, DATA, false), SCRIPT, only(userName(TOKEN_ID))));
    }

    /** The minted names must match the datum's token id, not some other pair. */
    @Test
    void mintedNamesMustMatchTheDatum() {
        assertFalse(mint(SEED, datum(TOKEN_ID, DATA, false), SCRIPT, pair(OTHER_ID)));
    }

    /**
     * The side door: if the burn redeemer could also mint, fresh pairs could be issued without
     * ever spending the seed, and token ids would stop being unique.
     */
    @Test
    void burnRedeemerCannotMint() {
        assertFalse(burnMint(pair(TOKEN_ID)));
    }

    @Test
    void burnRedeemerAllowsANegativeMint() {
        assertTrue(burnMint(burned(TOKEN_ID)));
    }

    // ── Editing ───────────────────────────────────────────────────────────────────────

    @Test
    void ownerEditsAnUnsealedNft() {
        assertTrue(edit(datum(TOKEN_ID, DATA, false), datum(TOKEN_ID, NEW_DATA, false),
                true, SCRIPT));
    }

    /** Ownership is proved by presenting the user token, so it must actually be there. */
    @Test
    void editingRequiresTheUserToken() {
        assertFalse(edit(datum(TOKEN_ID, DATA, false), datum(TOKEN_ID, NEW_DATA, false),
                false, SCRIPT));
    }

    /** The reference token has to come back, or the NFT would escape its own governance. */
    @Test
    void editingMustReturnTheReferenceToken() {
        assertFalse(edit(datum(TOKEN_ID, DATA, false), datum(TOKEN_ID, NEW_DATA, false),
                true, WALLET));
    }

    /** A rewritable token id would let one NFT impersonate another. */
    @Test
    void editingCannotChangeTheTokenId() {
        assertFalse(edit(datum(TOKEN_ID, DATA, false), datum(OTHER_ID, NEW_DATA, false),
                true, SCRIPT));
    }

    /** Sealing is a legitimate edit — it is the last one. */
    @Test
    void ownerMaySealAnNft() {
        assertTrue(edit(datum(TOKEN_ID, DATA, false), datum(TOKEN_ID, DATA, true),
                true, SCRIPT));
    }

    // ── The seal ──────────────────────────────────────────────────────────────────────

    @Test
    void sealedDataCannotBeEdited() {
        assertFalse(edit(datum(TOKEN_ID, DATA, true), datum(TOKEN_ID, NEW_DATA, true),
                true, SCRIPT));
    }

    /** There is no unseal. */
    @Test
    void sealedNftCannotBeUnsealed() {
        assertFalse(edit(datum(TOKEN_ID, DATA, true), datum(TOKEN_ID, DATA, false),
                true, SCRIPT));
    }

    /** Re-signing the identical datum is the only spend a sealed NFT permits. */
    @Test
    void sealedNftMayBeMovedUnchanged() {
        assertTrue(edit(datum(TOKEN_ID, DATA, true), datum(TOKEN_ID, DATA, true),
                true, SCRIPT));
    }

    // ── Burning ───────────────────────────────────────────────────────────────────────

    @Test
    void burnsBothHalves() {
        assertTrue(burn(datum(TOKEN_ID, DATA, false), burned(TOKEN_ID)));
    }

    /** Burning one half would strand the other: an ownerless datum, or a token with no data. */
    @Test
    void cannotBurnOnlyTheReferenceToken() {
        assertFalse(burn(datum(TOKEN_ID, DATA, false),
                Value.singleton(policy(), new TokenName(refName(TOKEN_ID)),
                        BigInteger.valueOf(-1))));
    }

    @Test
    void cannotBurnOnlyTheUserToken() {
        assertFalse(burn(datum(TOKEN_ID, DATA, false),
                Value.singleton(policy(), new TokenName(userName(TOKEN_ID)),
                        BigInteger.valueOf(-1))));
    }

    /** A sealed NFT is immutable, not immortal. */
    @Test
    void sealedNftCanStillBeBurned() {
        assertTrue(burn(datum(TOKEN_ID, DATA, true), burned(TOKEN_ID)));
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean mint(TxOutRef spent, PlutusData datum, Address destination, Value minted) {
        TxOut refOutput = new TxOut(destination,
                Value.singleton(policy(), new TokenName(refNameOf(datum)), BigInteger.ONE)
                        .merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.OutputDatumInline(datum), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.minting(policy())
                .input(new TxInInfo(spent, walletUtxo()))
                .mint(minted)
                .output(refOutput)
                .buildPlutusData();

        // Mint is constructor 0, with the seed input at index 0 and the ref output at index 0.
        return eval.call("mint", constrData(0, intData(0), intData(0)), ctx).asBoolean();
    }

    private boolean burnMint(Value minted) {
        PlutusData ctx = ScriptContextTestBuilder.minting(policy())
                .mint(minted)
                .buildPlutusData();
        // BurnPair is constructor 1.
        return eval.call("mint", constrData(1), ctx).asBoolean();
    }

    private boolean edit(PlutusData before, PlutusData after, boolean withUserToken,
            Address destination) {
        TxOut held = new TxOut(SCRIPT,
                Value.singleton(policy(), new TokenName(refNameOf(before)), BigInteger.ONE)
                        .merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.OutputDatumInline(before), Optional.empty());

        Value userHeld = withUserToken
                ? Value.singleton(policy(), new TokenName(userNameOf(before)), BigInteger.ONE)
                        .merge(Value.lovelace(BigInteger.valueOf(2_000_000)))
                : Value.lovelace(BigInteger.valueOf(2_000_000));

        TxOut next = new TxOut(destination,
                Value.singleton(policy(), new TokenName(refNameOf(after)), BigInteger.ONE)
                        .merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.OutputDatumInline(after), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.spending(OWN_REF)
                .input(new TxInInfo(OWN_REF, held))
                .input(new TxInInfo(OTHER_UTXO, new TxOut(WALLET, userHeld,
                        new OutputDatum.NoOutputDatum(), Optional.empty())))
                .output(next)
                .buildPlutusData();

        // Edit is constructor 0: user token at input index 1, reference output at index 0.
        return eval.call("spend", before, constrData(0, intData(1), intData(0)), ctx).asBoolean();
    }

    private boolean burn(PlutusData datum, Value minted) {
        TxOut held = new TxOut(SCRIPT,
                Value.singleton(policy(), new TokenName(refNameOf(datum)), BigInteger.ONE)
                        .merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.OutputDatumInline(datum), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.spending(OWN_REF)
                .input(new TxInInfo(OWN_REF, held))
                .mint(minted)
                .buildPlutusData();

        // BurnBoth is constructor 1.
        return eval.call("spend", datum, constrData(1, intData(0)), ctx).asBoolean();
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────

    /** {@code ReferenceNftDatum { tokenId, data, isSealed }}. */
    private static PlutusData datum(byte[] tokenId, byte[] data, boolean isSealed) {
        return constrData(0, bytesData(tokenId), bytesData(data), boolData(isSealed));
    }

    private static Value pair(byte[] tokenId) {
        return Value.singleton(policy(), new TokenName(refName(tokenId)), BigInteger.ONE)
                .merge(Value.singleton(policy(), new TokenName(userName(tokenId)),
                        BigInteger.ONE));
    }

    private static Value only(byte[] name) {
        return Value.singleton(policy(), new TokenName(name), BigInteger.ONE);
    }

    private static Value burned(byte[] tokenId) {
        return Value.singleton(policy(), new TokenName(refName(tokenId)), BigInteger.valueOf(-1))
                .merge(Value.singleton(policy(), new TokenName(userName(tokenId)),
                        BigInteger.valueOf(-1)));
    }

    private static TxOut walletUtxo() {
        return new TxOut(WALLET, Value.lovelace(BigInteger.valueOf(10_000_000)),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static PolicyId policy() {
        return PolicyId.of(SCRIPT_HASH);
    }

    private static byte[] refName(byte[] tokenId) {
        return concat(REF_LABEL, tokenId);
    }

    private static byte[] userName(byte[] tokenId) {
        return concat(USER_LABEL, tokenId);
    }

    /** The token id is the datum's first field. */
    private static byte[] refNameOf(PlutusData datum) {
        return refName(tokenIdOf(datum));
    }

    private static byte[] userNameOf(PlutusData datum) {
        return userName(tokenIdOf(datum));
    }

    private static byte[] tokenIdOf(PlutusData datum) {
        return ((PlutusData.BytesData) ((PlutusData.ConstrData) datum).fields().get(0)).value();
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

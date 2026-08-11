package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.listData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.FactoryMarkerValidator;
import org.cardanofoundation.templates.validator.FactoryValidator;
import org.cardanofoundation.templates.validator.ProductValidator;
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
 * <p>The point of this system is that no single script is trusted: the product's mint rule and
 * the factory's spend rule each enforce half of the authorisation chain, and only a transaction
 * that satisfies both can create a product. So the tests check each half separately, then check
 * that neither can be bypassed on its own.
 */
class FactoryValidatorTest {

    private static final byte[] OWNER = fill((byte) 0x01, 28);
    private static final byte[] STRANGER = fill((byte) 0x02, 28);

    private static final byte[] MARKER_POLICY = fill((byte) 0x09, 28);
    private static final byte[] MARKER_NAME = "FACTORY_MARKER".getBytes(StandardCharsets.UTF_8);

    private static final byte[] FACTORY_HASH = fill((byte) 0x07, 28);
    private static final Address FACTORY = scriptAddress(FACTORY_HASH);

    private static final byte[] PRODUCT_POLICY = fill((byte) 0x0B, 28);
    private static final Address PRODUCT = scriptAddress(PRODUCT_POLICY);
    private static final byte[] PRODUCT_ID = "WIDGET".getBytes(StandardCharsets.UTF_8);

    private static final Address WALLET = new Address(
            new Credential.PubKeyCredential(new PubKeyHash(OWNER)), Optional.empty());

    private static final TxOutRef SEED =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);
    private static final TxOutRef FACTORY_REF =
            new TxOutRef(new TxId(fill((byte) 0xBB, 32)), BigInteger.ZERO);

    private final JulcEval marker = JulcEval.forClass(FactoryMarkerValidator.class,
            bytesData(OWNER), SEED.toPlutusData());

    private final JulcEval factory = JulcEval.forClass(FactoryValidator.class,
            bytesData(OWNER), bytesData(MARKER_POLICY));

    private final JulcEval product = JulcEval.forClass(ProductValidator.class,
            bytesData(OWNER), bytesData(MARKER_POLICY), bytesData(PRODUCT_ID));

    // ── Marker: the factory's identity ────────────────────────────────────────────────

    @Test
    void mintsTheMarker() {
        assertTrue(mintMarker(SEED, OWNER, markerValue(1)));
    }

    /** Without the seed the policy could run again and forge a second factory. */
    @Test
    void markerRequiresTheSeedUtxo() {
        TxOutRef other = new TxOutRef(new TxId(fill((byte) 0xCC, 32)), BigInteger.ONE);
        assertFalse(mintMarker(other, OWNER, markerValue(1)));
    }

    @Test
    void markerRequiresTheOwner() {
        assertFalse(mintMarker(SEED, STRANGER, markerValue(1)));
    }

    @Test
    void markerCannotBeMintedTwice() {
        assertFalse(mintMarker(SEED, OWNER, markerValue(2)));
    }

    // ── Factory: recording an authorised product ──────────────────────────────────────

    @Test
    void createsAProduct() {
        assertTrue(createProduct(valid()));
    }

    @Test
    void createRequiresTheOwner() {
        assertFalse(createProduct(valid().signedBy(STRANGER)));
    }

    /** A look-alike UTxO at the factory address must not be able to drive a creation. */
    @Test
    void createRequiresTheSpentUtxoToHoldTheMarker() {
        assertFalse(createProduct(valid().withoutMarkerOnInput()));
    }

    /** Losing the marker would end the factory, so the transition must carry it over. */
    @Test
    void createRequiresTheMarkerToContinue() {
        assertFalse(createProduct(valid().withoutContinuingOutput()));
    }

    /** Two marker outputs would fork the factory into two equally authentic histories. */
    @Test
    void createRejectsForkingTheMarker() {
        assertFalse(createProduct(valid().duplicateContinuingOutput()));
    }

    /** The whole point of the transition: the factory must remember what it authorised. */
    @Test
    void createRequiresTheProductToBeRecorded() {
        assertFalse(createProduct(valid().recordingNothing()));
    }

    @Test
    void createRequiresTheProductToBeMinted() {
        assertFalse(createProduct(valid().mintingNothing()));
    }

    // ── Product: minting under the factory's authority ────────────────────────────────

    @Test
    void mintsAProduct() {
        assertTrue(mintProduct(validMint()));
    }

    /** The authorisation chain: no factory spent means no authority to mint. */
    @Test
    void productRequiresTheFactoryToBeSpent() {
        assertFalse(mintProduct(validMint().withoutFactoryInput()));
    }

    /** Two factories in one transaction leaves it ambiguous which one authorised this. */
    @Test
    void productRejectsTwoFactoriesInOneTransaction() {
        assertFalse(mintProduct(validMint().withSecondFactoryInput()));
    }

    @Test
    void productRequiresTheOwner() {
        assertFalse(mintProduct(validMint().signedBy(STRANGER)));
    }

    /** A product in a wallet would be invisible to the contracts meant to consume it. */
    @Test
    void productMustLandAtAScript() {
        assertFalse(mintProduct(validMint().payingTo(WALLET)));
    }

    @Test
    void productMustCarryAnInlineDatum() {
        assertFalse(mintProduct(validMint().withoutInlineDatum()));
    }

    // ── Product: spending afterwards ──────────────────────────────────────────────────

    @Test
    void ownerCanSpendAProduct() {
        assertTrue(spendProduct(OWNER));
    }

    @Test
    void strangerCannotSpendAProduct() {
        assertFalse(spendProduct(STRANGER));
    }

    // ── Scenario builders ─────────────────────────────────────────────────────────────

    private boolean mintMarker(TxOutRef spent, byte[] signer, Value minted) {
        PlutusData ctx = ScriptContextTestBuilder.minting(PolicyId.of(MARKER_POLICY))
                .input(new TxInInfo(spent, adaOnly(WALLET)))
                .mint(minted)
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
        return marker.call("mint", unitData(), ctx).asBoolean();
    }

    private boolean createProduct(Creation c) {
        return factory.call("spend", c.datum(), c.redeemer(), c.context()).asBoolean();
    }

    private boolean mintProduct(Creation c) {
        return product.call("mint", unitData(), c.mintContext()).asBoolean();
    }

    private boolean spendProduct(byte[] signer) {
        TxOutRef ref = new TxOutRef(new TxId(fill((byte) 0xDD, 32)), BigInteger.ZERO);
        PlutusData ctx = ScriptContextTestBuilder.spending(ref)
                .input(new TxInInfo(ref, new TxOut(PRODUCT, productValue(),
                        new OutputDatum.OutputDatumInline(productDatum()), Optional.empty())))
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
        return product.call("spend", productDatum(), unitData(), ctx).asBoolean();
    }

    private static Creation valid() {
        return new Creation();
    }

    private static Creation validMint() {
        return new Creation();
    }

    /**
     * One valid CreateProduct transaction that each test bends in a single place. Both the
     * factory spend and the product mint read the same transaction, so one builder serves both.
     */
    private static final class Creation {
        private byte[] signer = OWNER;
        private boolean markerOnInput = true;
        private boolean continuingOutput = true;
        private boolean duplicateContinuing;
        private boolean recordProduct = true;
        private boolean mintProduct = true;
        private boolean factoryInput = true;
        private boolean secondFactoryInput;
        private Address productPayee = PRODUCT;
        private boolean inlineDatum = true;

        Creation signedBy(byte[] who) { signer = who; return this; }
        Creation withoutMarkerOnInput() { markerOnInput = false; return this; }
        Creation withoutContinuingOutput() { continuingOutput = false; return this; }
        Creation duplicateContinuingOutput() { duplicateContinuing = true; return this; }
        Creation recordingNothing() { recordProduct = false; return this; }
        Creation mintingNothing() { mintProduct = false; return this; }
        Creation withoutFactoryInput() { factoryInput = false; return this; }
        Creation withSecondFactoryInput() { secondFactoryInput = true; return this; }
        Creation payingTo(Address address) { productPayee = address; return this; }
        Creation withoutInlineDatum() { inlineDatum = false; return this; }

        /** The factory's current datum: nothing authorised yet. */
        PlutusData datum() {
            return constrData(0, listData());
        }

        PlutusData redeemer() {
            return constrData(0, bytesData(PRODUCT_POLICY), bytesData(PRODUCT_ID));
        }

        /** The factory spend sees this transaction as a spend of the factory UTxO. */
        PlutusData context() {
            return body(ScriptContextTestBuilder.spending(FACTORY_REF)).buildPlutusData();
        }

        /**
         * The product mint sees the very same transaction, but as a mint under the product
         * policy — the purpose decides what {@code ownHash} resolves to, so the two scripts need
         * contexts built from different entry points over one shared body.
         */
        PlutusData mintContext() {
            return body(ScriptContextTestBuilder.minting(PolicyId.of(PRODUCT_POLICY)))
                    .buildPlutusData();
        }

        private ScriptContextTestBuilder body(ScriptContextTestBuilder builder) {
            Value onInput = markerOnInput
                    ? markerValue(1).merge(Value.lovelace(BigInteger.valueOf(2_000_000)))
                    : Value.lovelace(BigInteger.valueOf(2_000_000));

            builder = builder
                    .signer(new PubKeyHash(signer))
                    .mint(mintProduct ? productValue() : Value.lovelace(BigInteger.ONE));

            if (factoryInput) {
                builder = builder.input(new TxInInfo(FACTORY_REF,
                        new TxOut(FACTORY, onInput,
                                new OutputDatum.OutputDatumInline(datum()), Optional.empty())));
            }
            if (secondFactoryInput) {
                TxOutRef other = new TxOutRef(new TxId(fill((byte) 0xEE, 32)), BigInteger.ZERO);
                builder = builder.input(new TxInInfo(other,
                        new TxOut(FACTORY, markerValue(1),
                                new OutputDatum.OutputDatumInline(datum()), Optional.empty())));
            }
            if (continuingOutput) {
                builder = builder.output(continuing());
            }
            if (duplicateContinuing) {
                builder = builder.output(continuing());
            }
            return builder.output(productOutput());
        }

        /** The factory carrying on, with the new product recorded. */
        private TxOut continuing() {
            PlutusData updated = recordProduct
                    ? constrData(0, listData(bytesData(PRODUCT_POLICY)))
                    : constrData(0, listData());

            return new TxOut(FACTORY,
                    markerValue(1).merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                    new OutputDatum.OutputDatumInline(updated), Optional.empty());
        }

        private TxOut productOutput() {
            OutputDatum datum = inlineDatum
                    ? new OutputDatum.OutputDatumInline(productDatum())
                    : new OutputDatum.NoOutputDatum();

            return new TxOut(productPayee,
                    productValue().merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                    datum, Optional.empty());
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private static PlutusData productDatum() {
        return constrData(0, bytesData("first batch".getBytes(StandardCharsets.UTF_8)));
    }

    private static Value markerValue(long quantity) {
        return Value.singleton(PolicyId.of(MARKER_POLICY), new TokenName(MARKER_NAME),
                BigInteger.valueOf(quantity));
    }

    private static Value productValue() {
        return Value.singleton(PolicyId.of(PRODUCT_POLICY), new TokenName(PRODUCT_ID),
                BigInteger.ONE);
    }

    private static TxOut adaOnly(Address address) {
        return new TxOut(address, Value.lovelace(BigInteger.valueOf(10_000_000)),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static Address scriptAddress(byte[] hash) {
        return new Address(new Credential.ScriptCredential(new ScriptHash(hash)), Optional.empty());
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

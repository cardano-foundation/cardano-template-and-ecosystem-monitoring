package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MultiValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;

/**
 * A product minted under a factory's authority.
 *
 * <p>The authorisation chain rests on a single requirement: minting a product demands that the
 * factory UTxO be spent in the same transaction. That forces {@link FactoryValidator} to run too,
 * which in turn forces the factory to record this product in its datum. Neither script needs to
 * trust the other — the transaction cannot satisfy one without satisfying both.
 *
 * <p>Spending a product afterwards is plain owner control; the interesting rules are all at mint.
 */
@MultiValidator
public class ProductValidator {

    @Param static byte[] owner;

    /** Identifies the factory whose authority this product claims. */
    @Param static byte[] markerPolicy;

    /** Baked in, so each product line is a distinct script rather than a runtime argument. */
    @Param static byte[] productId;

    public record ProductDatum(byte[] tag) {}

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        // Exactly one input carrying the marker. Two would mean two factories in one
        // transaction, and it would stop being clear which one authorised this product.
        long factoriesSpent = ContextsLib.txInfoInputs(tx)
                .filter(input -> FactoryLib.hasMarker(
                        OutputLib.txOutValue(input.resolved()), markerPolicy))
                .size();

        return ContextsLib.signedBy(tx, owner)
                && factoriesSpent == 1L
                && FactoryLib.onlyMinted(ContextsLib.txInfoMint(tx), policyId, productId)
                && landsAtAScript(ContextsLib.txInfoOutputs(tx), policyId);
    }

    /**
     * The product must come to rest at a script address with an inline datum, so later contracts
     * can find it and read what it is. A product sitting in a wallet would be invisible to them.
     */
    static boolean landsAtAScript(JulcList<TxOut> outputs, byte[] policyId) {
        JulcList<TxOut> holding = OutputLib.outputsWithToken(outputs, policyId, productId);
        if (holding.size() != 1L) {
            return false;
        }
        TxOut output = holding.head();

        if (!AddressLib.isScriptAddress(OutputLib.txOutAddress(output))) {
            return false;
        }
        if (!FactoryLib.hasInlineDatum(output)) {
            return false;
        }
        // Reading it is the check: a datum of the wrong shape aborts here.
        ProductDatum datum = (ProductDatum) (Object) OutputLib.getInlineDatum(output);
        return FactoryLib.nonEmpty(datum.tag());
    }

    /** Once minted, a product is administered by the same owner that ran the factory. */
    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData datum, PlutusData redeemer, ScriptContext ctx) {
        return ContextsLib.signedBy(ContextsLib.getTxInfo(ctx), owner);
    }
}

package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;

/**
 * The factory: a long-lived UTxO that remembers every product it has authorised.
 *
 * <p>There is exactly one transition, {@code CreateProduct}, and it must do four things at once:
 * the owner signs, the marker moves to a single new output at the same address, the product is
 * minted, and the product's policy id is recorded in the new datum.
 *
 * <p>Insisting the marker <em>carries over</em> is what makes the factory stateful. A transaction
 * that dropped the marker would end the factory; one that produced two marker outputs would fork
 * it into two histories that each look authentic. Requiring exactly one continuing output rules
 * out both.
 */
@SpendingValidator
public class FactoryValidator {

    @Param static byte[] owner;

    /** Identifies the marker token, and so identifies the factory itself. */
    @Param static byte[] markerPolicy;

    public record FactoryDatum(JulcList<byte[]> products) {}

    public record CreateProduct(byte[] productPolicyId, byte[] productId) {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(FactoryDatum datum, CreateProduct redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut ownOutput = ContextsLib.findOwnInput(ctx).get().resolved();

        // The UTxO being spent must be the real factory. Without this, a look-alike output at
        // the same address could be used to drive a spend that mints an unauthorised product.
        if (!FactoryLib.holdsOnlyTheMarker(OutputLib.txOutValue(ownOutput), markerPolicy)) {
            return false;
        }

        // Marker continuity: exactly one output at this address still carrying the marker.
        JulcList<TxOut> continuing = ContextsLib.txInfoOutputs(tx)
                .filter(output -> FactoryLib.sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(ownOutput)))
                .filter(output -> FactoryLib.hasMarker(
                        OutputLib.txOutValue(output), markerPolicy));

        if (continuing.size() != 1L) {
            return false;
        }
        FactoryDatum updated = (FactoryDatum) (Object) OutputLib.getInlineDatum(continuing.head());

        return ContextsLib.signedBy(tx, owner)
                && records(updated, redeemer.productPolicyId())
                && FactoryLib.onlyMinted(ContextsLib.txInfoMint(tx),
                        redeemer.productPolicyId(), redeemer.productId());
    }

    /**
     * The new datum must list the product being created. Ordering and duplicates are not policed
     * — the product script is parameterised on this factory, so a repeated entry still names the
     * same script.
     */
    static boolean records(FactoryDatum datum, byte[] productPolicyId) {
        return datum.products().any(policy -> ByteStringLib.equals(policy, productPolicyId));
    }
}

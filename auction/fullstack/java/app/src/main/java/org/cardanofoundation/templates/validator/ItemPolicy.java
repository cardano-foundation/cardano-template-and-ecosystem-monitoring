package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MintingValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;

/**
 * Mints the item being auctioned.
 *
 * <p>Not part of the contract under test — {@link AuctionValidator} auctions any asset, and
 * identifies it by policy id from the datum. This exists so the example can create something to
 * sell without depending on anything already being on chain.
 */
@MintingValidator
public class ItemPolicy {

    @Param static byte[] issuer;

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        return ContextsLib.signedBy(ContextsLib.getTxInfo(ctx), issuer);
    }
}

package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MintingValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;

/**
 * Mints the tokens this example moves around.
 *
 * <p>Not part of the contract under test — {@link TokenTransferValidator} works with any asset.
 * It exists so the example can create both a target token and an unrelated one without depending
 * on anything already being on the chain.
 */
@MintingValidator
public class DemoTokenPolicy {

    @Param static byte[] issuer;

    /** Distinct indices give distinct policy ids, so the example can mint genuinely unrelated
     * assets — which is what the escape-hatch case needs. */
    @Param static java.math.BigInteger index;

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        return ContextsLib.signedBy(ContextsLib.getTxInfo(ctx), issuer);
    }
}

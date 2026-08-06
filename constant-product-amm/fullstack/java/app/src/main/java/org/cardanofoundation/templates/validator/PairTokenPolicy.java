package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MintingValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;

/**
 * Mints the two tokens this pool trades.
 *
 * <p>Not part of the contract under test — {@link AmmValidator} trades whatever pair its
 * parameters name. It exists so the example can create a pair without depending on anything
 * already being on chain.
 */
@MintingValidator
public class PairTokenPolicy {

    @Param static byte[] issuer;

    @Param static BigInteger index;

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        return ContextsLib.signedBy(ContextsLib.getTxInfo(ctx), issuer);
    }
}

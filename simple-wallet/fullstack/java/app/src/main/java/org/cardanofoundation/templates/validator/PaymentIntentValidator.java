package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;

/**
 * Holds one pending payment intent: who to pay, how much, and an opaque payload.
 *
 * <p>The intent is a <em>proposal</em>, not an authorisation. Anyone reading the chain can see
 * what the wallet intends to do, but nothing moves until the owner co-signs an execution — see
 * {@link FundsValidator}.
 *
 * <p>Spending is owner-only, which is what lets the owner cancel an intent before it runs.
 */
@SpendingValidator
public class PaymentIntentValidator {

    @Param static byte[] owner;

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData datum, PlutusData redeemer, ScriptContext ctx) {
        return ContextsLib.signedBy(ContextsLib.getTxInfo(ctx), owner);
    }
}

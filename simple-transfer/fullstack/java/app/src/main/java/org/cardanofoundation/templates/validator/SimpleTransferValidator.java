package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;

/**
 * "Send funds that only one person can spend."
 *
 * <p>The smallest useful validator there is: no datum, no deadline, no redeemer — the receiver
 * simply has to sign. Everything else in this repository builds on this shape.
 *
 * <p>The receiver is a validator <em>parameter</em>, so it is baked into the script hash and
 * each receiver gets a distinct address. Funds are addressed by construction rather than by a
 * datum that a spending transaction could try to reinterpret.
 */
@SpendingValidator
public class SimpleTransferValidator {

    // Static so the entrypoint can stay static: javac rejects reading an instance field from a
    // static method, and an instance entrypoint is invisible to julc-testkit.

    /** Verification key hash allowed to spend. */
    @Param
    static byte[] receiver;

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData redeemer, ScriptContext ctx) {
        return ContextsLib.signedBy(ContextsLib.getTxInfo(ctx), receiver);
    }
}

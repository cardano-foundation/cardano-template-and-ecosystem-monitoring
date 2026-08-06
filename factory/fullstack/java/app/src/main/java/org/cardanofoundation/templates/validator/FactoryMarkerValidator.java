package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MintingValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Mints the factory's identity token, once and only once.
 *
 * <p>The marker is what makes the rest of the system verifiable. A product can prove it was
 * authorised because its mint required the factory UTxO — identified by this token — to be spent
 * in the same transaction. That argument only holds if the token is genuinely unique.
 *
 * <p>Uniqueness comes from the seed UTxO parameter rather than from any rule about counting: a
 * UTxO can be spent exactly once, so once the owner spends it, no later transaction can ever
 * satisfy this policy again. And because the seed is a parameter, the policy id itself differs
 * per factory, so two factories can never share a marker.
 */
@MintingValidator
public class FactoryMarkerValidator {

    @Param static byte[] owner;

    /** Spending this is what makes the policy one-shot. */
    @Param static TxOutRef seedUtxo;

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        return ContextsLib.signedBy(tx, owner)
                && consumesSeed(ContextsLib.txInfoInputs(tx))
                && ValuesLib.assetOf(ContextsLib.txInfoMint(tx), policyId, FactoryLib.markerName())
                        .equals(BigInteger.ONE);
    }

    static boolean consumesSeed(JulcList<TxInInfo> inputs) {
        return inputs.any(input -> sameRef(input.outRef(), seedUtxo));
    }

    static boolean sameRef(TxOutRef a, TxOutRef b) {
        return ByteStringLib.equals(a.txId().hash(), b.txId().hash()) && a.index().equals(b.index());
    }
}

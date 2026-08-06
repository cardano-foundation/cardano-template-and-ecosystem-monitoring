package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MintingValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Mints and burns the marker that makes a payment intent real.
 *
 * <p>A datum sitting at the intent script proves nothing on its own — anyone can create an output
 * with any datum. The marker is what binds an intent to <em>this</em> wallet, because only this
 * policy can produce one, and it only does so for an output that actually lands at the intent
 * script carrying a well-formed intent.
 *
 * <p>Burning is deliberately loose about shape: {@link FundsValidator} burns the marker as part
 * of executing an intent, and it would be circular for this policy to re-check the rules that
 * execution has already enforced.
 */
@MintingValidator
public class WalletValidator {

    @Param static byte[] owner;

    /** Where an intent must live for its marker to be valid. */
    @Param static byte[] intentScriptHash;

    public sealed interface WalletRedeemer permits Mint, Burn {}

    public record Mint() implements WalletRedeemer {}

    public record Burn() implements WalletRedeemer {}

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(WalletRedeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        if (!ContextsLib.signedBy(tx, owner)) {
            return false;
        }
        BigInteger minted = ValuesLib.assetOf(ContextsLib.txInfoMint(tx), policyId,
                WalletLib.markerName());

        return switch (redeemer) {
            case Mint ignored -> minted.equals(BigInteger.ONE)
                    && attachedToAnIntent(ContextsLib.txInfoOutputs(tx), policyId);
            case Burn ignored -> minted.equals(BigInteger.valueOf(-1));
        };
    }

    /**
     * The new marker must come to rest at the intent script with an inline datum. Without this
     * the marker could exist while its payload did not, leaving an intent that nothing can read.
     */
    static boolean attachedToAnIntent(JulcList<TxOut> outputs, byte[] policyId) {
        JulcList<TxOut> intents = outputs
                .filter(output -> atIntentScript(output))
                .filter(output -> WalletLib.hasMarker(OutputLib.txOutValue(output), policyId));

        if (intents.size() != 1L) {
            return false;
        }
        TxOut intent = intents.head();
        if (!hasInlineDatum(intent)) {
            return false;
        }
        // Reading it is the check: a datum of the wrong shape aborts here.
        WalletLib.PaymentIntent payload =
                (WalletLib.PaymentIntent) (Object) OutputLib.getInlineDatum(intent);
        return payload.lovelaceAmount().compareTo(BigInteger.ZERO) > 0;
    }

    static boolean atIntentScript(TxOut output) {
        return AddressLib.isScriptAddress(OutputLib.txOutAddress(output))
                && ByteStringLib.equals(
                        AddressLib.credentialHash(OutputLib.txOutAddress(output)),
                        intentScriptHash);
    }

    static boolean hasInlineDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.OutputDatumInline ignored -> true;
            case OutputDatum.OutputDatumHash ignored -> false;
            case OutputDatum.NoOutputDatum ignored -> false;
        };
    }
}

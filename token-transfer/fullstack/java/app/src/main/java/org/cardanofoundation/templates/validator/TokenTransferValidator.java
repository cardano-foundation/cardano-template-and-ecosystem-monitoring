package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.AssetEntry;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * A delivery address for one specific token.
 *
 * <p>The script is parameterised on {@code (receiver, policy, assetName)}, so each address
 * corresponds to exactly one asset destined for exactly one person. Anyone can send that token
 * here; only the receiver can take it out.
 *
 * <p>Two rules do the work, and they answer different questions.
 */
@SpendingValidator
public class TokenTransferValidator {

    @Param static byte[] receiver;

    @Param static byte[] policy;

    @Param static byte[] assetName;

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData datum, PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();
        Value held = OutputLib.txOutValue(own);

        // Escape hatch. A UTxO here that does NOT hold the target asset is dust or a mistaken
        // transfer, and anyone may retrieve it. Without this branch such a UTxO would be locked
        // forever, because the receiver rule below could never be satisfied by it.
        if (!ValuesLib.containsPolicy(held, policy)) {
            return true;
        }

        return ValuesLib.assetOf(held, policy, assetName).compareTo(BigInteger.ZERO) > 0
                && ContextsLib.signedBy(tx, receiver)
                && !routesOtherTokens(
                        ContextsLib.txInfoOutputs(tx), OutputLib.txOutAddress(own));
    }

    /**
     * True if any token other than this address's own asset leaves the script in this
     * transaction.
     *
     * <p>This is the anti-batching rule, and it is about what the receiver's signature <em>means
     * </em>. Signing should authorise collecting <em>this</em> delivery — not act as a blanket
     * approval for whatever else a transaction builder decided to move in the same breath. Any
     * other asset heading elsewhere makes the signature cover more than the receiver agreed to.
     *
     * <p>Outputs returning to this same address are ignored: re-locking is not a departure.
     */
    static boolean routesOtherTokens(JulcList<TxOut> outputs, Address scriptAddress) {
        return outputs.any(output ->
                !sameAddress(OutputLib.txOutAddress(output), scriptAddress)
                        && nonAda(OutputLib.txOutValue(output)).any(entry -> !isOurAsset(entry)));
    }

    static boolean isOurAsset(AssetEntry entry) {
        return ByteStringLib.equals(entry.policyId(), policy)
                && ByteStringLib.equals(entry.tokenName(), assetName);
    }

    /** Ada rides along under the empty policy id; the rule only ever means the tokens. */
    static JulcList<AssetEntry> nonAda(Value value) {
        return ValuesLib.flattenTyped(value)
                .filter(entry -> ByteStringLib.length(entry.policyId()) > 0L);
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}

package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.stdlib.Builtins;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MultiValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.CryptoLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Commit and reveal, without putting an identity on-chain.
 *
 * <p><b>Commit</b> mints a token whose <em>asset name</em> is
 * {@code blake2b_256(pubKeyHash ++ nonce)}. The chain sees only that digest, so nobody can tell
 * which key produced it — and because the nonce is secret, nobody can test a guess either.
 *
 * <p><b>Reveal</b> spends the token and shows a signer who can reconstruct the same digest. Only
 * at that moment does the commitment become linkable to a key.
 *
 * <p>The datum is opaque payload that travels with the marker; only its presence is checked.
 */
@MultiValidator
public class AnonymousDataValidator {

    /**
     * Commit. Deliberately unsigned — the anonymity comes from the digest hiding which key made
     * the commitment, so requiring a signature here would defeat the point.
     */
    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        // Taken as PlutusData and unwrapped by hand. Declaring the parameter as byte[] looks
        // tidier but fails on chain: the redeemer already arrives as Data, and julc's wrapper
        // wraps it a second time, so the script aborts with "expected bytestring, actual data".
        byte[] id = Builtins.unBData(redeemer);
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        // Exactly one, so a commitment marker is unique and cannot be split or duplicated.
        boolean mintedOne = ValuesLib.assetOf(ContextsLib.txInfoMint(tx), policyId, id)
                .equals(BigInteger.ONE);

        return mintedOne && storedWithDatum(ContextsLib.txInfoOutputs(tx), policyId, id);
    }

    /** The minted marker must come to rest on an output that carries the payload inline. */
    static boolean storedWithDatum(JulcList<TxOut> outputs, byte[] policyId, byte[] id) {
        JulcList<TxOut> holding = OutputLib.outputsWithToken(outputs, policyId, id);
        return !holding.isEmpty() && hasInlineDatum(holding.head());
    }

    static boolean hasInlineDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.OutputDatumInline ignored -> true;
            case OutputDatum.OutputDatumHash ignored -> false;
            case OutputDatum.NoOutputDatum ignored -> false;
        };
    }

    /**
     * Reveal. Anyone who signs and supplies a nonce that reproduces the committed digest may
     * spend it.
     */
    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData redeemer, ScriptContext ctx) {
        byte[] nonce = Builtins.unBData(redeemer);
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxInInfo ownInput = ContextsLib.findOwnInput(ctx).get();

        // The committed digest is read from the token sitting in the UTxO being spent, never
        // from the redeemer. Taking it from the redeemer would let a spender name whichever
        // commitment they happen to be able to open.
        byte[] committedId = ValuesLib.findTokenName(
                OutputLib.txOutValue(ownInput.resolved()),
                ContextsLib.ownHash(ctx),
                BigInteger.ONE);

        return ContextsLib.txInfoSignatories(tx).any(signer -> ByteStringLib.equals(
                CryptoLib.blake2b_256(ByteStringLib.append(signer.hash(), nonce)),
                committedId));
    }
}

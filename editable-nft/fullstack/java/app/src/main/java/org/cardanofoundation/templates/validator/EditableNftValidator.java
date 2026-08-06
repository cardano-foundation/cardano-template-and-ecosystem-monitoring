package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MultiValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * A CIP-68 editable NFT.
 *
 * <p>Every NFT here is really a <b>pair</b> of tokens sharing one token id: a <em>reference</em>
 * token that holds the metadata and lives at this script, and a <em>user</em> token that lives in
 * the owner's wallet and is simply proof of ownership.
 *
 * <p>That split is what makes the metadata editable without making it forgeable. The data sits
 * somewhere a contract can govern, while ownership stays a plain token the owner can hold, sell
 * or move like any other. Editing requires <em>presenting</em> the user token, not spending it —
 * so proving ownership costs the owner nothing.
 *
 * <p>Editing stops permanently once the datum is sealed. There is no unseal.
 */
@MultiValidator
public class EditableNftValidator {

    /** Spending this is what makes the policy one-shot, so a token id can never be reissued. */
    @Param static TxOutRef seed;

    public record ReferenceNftDatum(byte[] tokenId, byte[] data, boolean isSealed) {}

    public sealed interface MintRedeemer permits Mint, BurnPair {}

    /**
     * Indices into the transaction's inputs and outputs.
     *
     * <p>Naming the positions instead of searching for them is how the Scalus original keeps the
     * script small. A wrong index simply fails the check below, so it fails closed rather than
     * opening a hole.
     */
    public record Mint(BigInteger seedIndex, BigInteger refNftOutIndex) implements MintRedeemer {}

    public record BurnPair() implements MintRedeemer {}

    public sealed interface SpendRedeemer permits Edit, BurnBoth {}

    public record Edit(BigInteger userNftInputIndex, BigInteger refNftOutputIndex)
            implements SpendRedeemer {}

    public record BurnBoth(BigInteger userNftInputIndex) implements SpendRedeemer {}

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(MintRedeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        return switch (redeemer) {
            case Mint action -> mints(tx, policyId, action);
            // Burning must never be a way to mint. Without this the Burn redeemer would be a side
            // door around the one-shot seed check: fresh pairs could be issued without ever
            // spending the seed, and token ids would stop being unique.
            case BurnPair ignored -> !ValuesLib.flattenTyped(ContextsLib.txInfoMint(tx))
                    .any(entry -> ByteStringLib.equals(entry.policyId(), policyId)
                            && entry.amount().compareTo(BigInteger.ZERO) > 0);
        };
    }

    static boolean mints(TxInfo tx, byte[] policyId, Mint action) {
        // Bind the seed by identity, not merely "some input exists". Otherwise the one-shot
        // guarantee is gone and the policy could mint unlimited pairs.
        TxInInfo seedInput = ContextsLib.txInfoInputs(tx).get(action.seedIndex().longValue());
        if (!sameRef(seedInput.outRef(), seed)) {
            return false;
        }
        TxOut refOutput = ContextsLib.txInfoOutputs(tx).get(action.refNftOutIndex().longValue());
        if (!hasInlineDatum(refOutput)) {
            return false;
        }
        ReferenceNftDatum datum =
                (ReferenceNftDatum) (Object) OutputLib.getInlineDatum(refOutput);

        byte[] refName = referenceName(datum.tokenId());
        byte[] userName = userName(datum.tokenId());

        // The reference token must come to rest at this very script — that is what makes the
        // metadata governable at all. A pair whose reference token sat in a wallet would be
        // editable by nobody and ownable by anyone.
        Address destination = OutputLib.txOutAddress(refOutput);

        return AddressLib.isScriptAddress(destination)
                && ByteStringLib.equals(AddressLib.credentialHash(destination), policyId)
                && ValuesLib.assetOf(OutputLib.txOutValue(refOutput), policyId, refName)
                        .equals(BigInteger.ONE)
                // Exactly one of each: the pair is the whole abstraction, so a lone reference
                // token or a duplicated user token would break ownership.
                && ValuesLib.assetOf(ContextsLib.txInfoMint(tx), policyId, refName)
                        .equals(BigInteger.ONE)
                && ValuesLib.assetOf(ContextsLib.txInfoMint(tx), policyId, userName)
                        .equals(BigInteger.ONE);
    }

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(ReferenceNftDatum datum, SpendRedeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();
        Address scriptAddress = OutputLib.txOutAddress(own);

        if (!AddressLib.isScriptAddress(scriptAddress)) {
            return false;
        }
        byte[] policyId = AddressLib.credentialHash(scriptAddress);

        return switch (redeemer) {
            case Edit action -> edits(tx, datum, scriptAddress, policyId, action);
            case BurnBoth ignored -> burnsBoth(tx, datum, policyId);
        };
    }

    /** Editing: show the user token, hand the reference token back, respect the seal. */
    static boolean edits(TxInfo tx, ReferenceNftDatum datum, Address scriptAddress,
            byte[] policyId, Edit action) {
        // Present, not spend. Requiring the user token as an input proves ownership without
        // requiring the owner to give it up.
        TxInInfo userInput =
                ContextsLib.txInfoInputs(tx).get(action.userNftInputIndex().longValue());

        if (!ValuesLib.assetOf(OutputLib.txOutValue(userInput.resolved()), policyId,
                        userName(datum.tokenId()))
                .equals(BigInteger.ONE)) {
            return false;
        }
        TxOut next = ContextsLib.txInfoOutputs(tx).get(action.refNftOutputIndex().longValue());

        if (!sameAddress(OutputLib.txOutAddress(next), scriptAddress)
                || !ValuesLib.assetOf(OutputLib.txOutValue(next), policyId,
                                referenceName(datum.tokenId()))
                        .equals(BigInteger.ONE)
                || !hasInlineDatum(next)) {
            return false;
        }
        ReferenceNftDatum updated = (ReferenceNftDatum) (Object) OutputLib.getInlineDatum(next);

        if (datum.isSealed()) {
            // Sealed means sealed: nothing may change, including the seal itself. Comparing the
            // fields is equivalent to the original's whole-datum comparison.
            return ByteStringLib.equals(updated.tokenId(), datum.tokenId())
                    && ByteStringLib.equals(updated.data(), datum.data())
                    && updated.isSealed() == datum.isSealed();
        }
        // Otherwise the data is free to change, but the identity is not: a token id that could
        // be rewritten would let one NFT impersonate another.
        return ByteStringLib.equals(updated.tokenId(), datum.tokenId());
    }

    /** Burning: the pair goes together or not at all. */
    static boolean burnsBoth(TxInfo tx, ReferenceNftDatum datum, byte[] policyId) {
        BigInteger minusOne = BigInteger.valueOf(-1);

        return ValuesLib.assetOf(ContextsLib.txInfoMint(tx), policyId,
                        referenceName(datum.tokenId())).equals(minusOne)
                && ValuesLib.assetOf(ContextsLib.txInfoMint(tx), policyId,
                        userName(datum.tokenId())).equals(minusOne);
    }

    /**
     * CIP-67 asset name labels, as raw bytes.
     *
     * <p>{@code 000643b0} tags the reference token and {@code 000de140} the user token. They are
     * built numerically because they are byte values, not text — spelling them as a string would
     * silently produce the ASCII of the digits instead.
     */
    static byte[] referenceName(byte[] tokenId) {
        return ByteStringLib.append(
                ByteStringLib.integerToByteString(true, 4L, 410544L), tokenId);
    }

    static byte[] userName(byte[] tokenId) {
        return ByteStringLib.append(
                ByteStringLib.integerToByteString(true, 4L, 909632L), tokenId);
    }

    static boolean hasInlineDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.OutputDatumInline ignored -> true;
            case OutputDatum.OutputDatumHash ignored -> false;
            case OutputDatum.NoOutputDatum ignored -> false;
        };
    }

    static boolean sameRef(TxOutRef a, TxOutRef b) {
        return ByteStringLib.equals(a.txId().hash(), b.txId().hash()) && a.index().equals(b.index());
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}

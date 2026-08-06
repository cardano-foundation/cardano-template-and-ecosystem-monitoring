package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.AssetEntry;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MintingValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.CryptoLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Publishes one audit snapshot as a permanent on-chain record.
 *
 * <p>This is where every rule is enforced, because it is the only chance to enforce anything:
 * {@link StorageValidator} refuses all spends, so a registry entry can never be revisited or
 * corrected. Whatever this policy waves through is final.
 *
 * <p>Four things have to hold at once:
 *
 * <ul>
 *   <li><b>The seed UTxO is spent.</b> It is a script parameter, so this policy has a different
 *       hash for every snapshot, and a UTxO can only be spent once — which makes the entry
 *       provably singleton rather than merely unique-by-convention.
 *   <li><b>Exactly one token is minted</b>, named {@code sha2_256(snapshotId)}. The caller does
 *       not get to pick the name, so republishing the same snapshot id collides on the token
 *       instead of quietly creating a second record.
 *   <li><b>It lands at the storage script</b>, not in a wallet. A mint that left the token
 *       transferable would defeat the permanence the whole design is built on.
 *   <li><b>The datum restates the redeemer</b>, and is well-formed. Nothing downstream will ever
 *       re-check it.
 * </ul>
 */
@MintingValidator
public class StorageMintValidator {

    /** Spending this makes the policy one-shot; it also gives the script its unique hash. */
    @Param static TxOutRef seedUtxo;

    /** Where the NFT must come to rest — the hash of {@link StorageValidator}. */
    @Param static byte[] storageScriptHash;

    public sealed interface SnapshotType permits Daily, Monthly {}

    public record Daily() implements SnapshotType {}

    public record Monthly() implements SnapshotType {}

    public record RegistryDatum(
            byte[] snapshotId,
            SnapshotType snapshotType,
            byte[] commitmentHash,
            BigInteger publishedAt) {}

    public record MintRedeemer(
            byte[] snapshotId, SnapshotType snapshotType, byte[] commitmentHash) {}

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(MintRedeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);
        byte[] assetName = CryptoLib.sha2_256(redeemer.snapshotId());

        return consumesSeed(ContextsLib.txInfoInputs(tx))
                && mintsExactlyTheEntry(ContextsLib.txInfoMint(tx), policyId, assetName)
                && storedPermanently(ContextsLib.txInfoOutputs(tx), policyId, assetName, redeemer);
    }

    static boolean consumesSeed(JulcList<TxInInfo> inputs) {
        return inputs.any(input -> sameRef(input.outRef(), seedUtxo));
    }

    static boolean sameRef(TxOutRef a, TxOutRef b) {
        return ByteStringLib.equals(a.txId().hash(), b.txId().hash()) && a.index().equals(b.index());
    }

    /**
     * One token under this policy, and it is the expected one. Counting the whole policy — not
     * just looking up the expected name — is what stops a caller from smuggling extra assets
     * into the same mint.
     */
    static boolean mintsExactlyTheEntry(Value mint, byte[] policyId, byte[] assetName) {
        JulcList<AssetEntry> ours =
                ValuesLib.flattenTyped(mint)
                        .filter(entry -> ByteStringLib.equals(entry.policyId(), policyId));

        if (ours.size() != 1L) {
            return false;
        }
        AssetEntry entry = ours.head();
        return ByteStringLib.equals(entry.tokenName(), assetName)
                && entry.amount().equals(BigInteger.ONE);
    }

    static boolean storedPermanently(
            JulcList<TxOut> outputs, byte[] policyId, byte[] assetName, MintRedeemer redeemer) {
        JulcList<TxOut> atStorage =
                outputs.filter(output -> isStorageScript(OutputLib.txOutAddress(output)));

        if (atStorage.size() != 1L) {
            return false;
        }
        TxOut output = atStorage.head();

        boolean holdsEntry =
                ValuesLib.assetOf(OutputLib.txOutValue(output), policyId, assetName)
                        .equals(BigInteger.ONE);

        // A datum hash would leave the record unreadable on chain, so inline is required.
        if (!hasInlineDatum(output)) {
            return false;
        }
        RegistryDatum datum = (RegistryDatum) (Object) OutputLib.getInlineDatum(output);

        return holdsEntry && describes(datum, redeemer);
    }

    static boolean isStorageScript(Address address) {
        return AddressLib.isScriptAddress(address)
                && ByteStringLib.equals(AddressLib.credentialHash(address), storageScriptHash);
    }

    static boolean hasInlineDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.OutputDatumInline ignored -> true;
            case OutputDatum.OutputDatumHash ignored -> false;
            case OutputDatum.NoOutputDatum ignored -> false;
        };
    }

    /** The stored record must say exactly what was asked for, and be well-formed. */
    static boolean describes(RegistryDatum datum, MintRedeemer redeemer) {
        return ByteStringLib.equals(datum.snapshotId(), redeemer.snapshotId())
                && typeToInt(datum.snapshotType()).equals(typeToInt(redeemer.snapshotType()))
                && ByteStringLib.equals(datum.commitmentHash(), redeemer.commitmentHash())
                && ByteStringLib.length(datum.commitmentHash()) == 32L
                && ByteStringLib.length(datum.snapshotId()) > 0L;
    }

    /** Sealed interfaces have no equality on chain, so compare the constructor index. */
    static BigInteger typeToInt(SnapshotType type) {
        return switch (type) {
            case Daily ignored -> BigInteger.ZERO;
            case Monthly ignored -> BigInteger.ONE;
        };
    }
}

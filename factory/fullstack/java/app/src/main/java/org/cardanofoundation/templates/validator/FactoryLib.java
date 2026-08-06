package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.AssetEntry;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.stdlib.annotation.OnchainLibrary;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Rules shared by the three factory scripts.
 *
 * <p>These live in an {@code @OnchainLibrary} rather than in one of the validators because each
 * validator compiles to its own script: a helper reached across classes would otherwise be
 * duplicated by hand, and a constant like the marker name has to be identical everywhere or the
 * scripts stop recognising each other's tokens.
 */
@OnchainLibrary
public class FactoryLib {

    /**
     * The factory's identity token. Fixed, so any script can recognise a marker.
     *
     * <p>Exposed as a method rather than a constant: julc inlines library <em>methods</em> across
     * validators, but a static field read from another class does not lower.
     */
    public static byte[] markerName() {
        return "FACTORY_MARKER".getBytes();
    }

    /** Ada rides along under the empty policy id; asset rules only ever mean the tokens. */
    public static JulcList<AssetEntry> nonAda(Value value) {
        return ValuesLib.flattenTyped(value)
                .filter(entry -> ByteStringLib.length(entry.policyId()) > 0L);
    }

    /** The whole transaction mints exactly one token, and it is this one. */
    public static boolean onlyMinted(Value mint, byte[] policyId, byte[] tokenName) {
        JulcList<AssetEntry> minted = nonAda(mint);
        if (minted.size() != 1L) {
            return false;
        }
        AssetEntry entry = minted.head();
        return ByteStringLib.equals(entry.policyId(), policyId)
                && ByteStringLib.equals(entry.tokenName(), tokenName)
                && entry.amount().equals(BigInteger.ONE);
    }

    public static boolean hasMarker(Value value, byte[] markerPolicy) {
        return ValuesLib.assetOf(value, markerPolicy, markerName()).equals(BigInteger.ONE);
    }

    /** The marker and nothing else: mirrors Aiken's {@code has_nft_strict}. */
    public static boolean holdsOnlyTheMarker(Value value, byte[] markerPolicy) {
        JulcList<AssetEntry> tokens = nonAda(value);
        if (tokens.size() != 1L) {
            return false;
        }
        AssetEntry entry = tokens.head();
        return ByteStringLib.equals(entry.policyId(), markerPolicy)
                && ByteStringLib.equals(entry.tokenName(), markerName())
                && entry.amount().equals(BigInteger.ONE);
    }

    public static boolean nonEmpty(byte[] bytes) {
        return ByteStringLib.length(bytes) > 0L;
    }

    public static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }

    public static boolean hasInlineDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.OutputDatumInline ignored -> true;
            case OutputDatum.OutputDatumHash ignored -> false;
            case OutputDatum.NoOutputDatum ignored -> false;
        };
    }
}

package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.stdlib.annotation.OnchainLibrary;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Rules shared by the three wallet scripts.
 *
 * <p>Each validator compiles to its own script, so a helper reached across validator classes
 * would otherwise be duplicated by hand — and the marker name in particular has to be
 * byte-identical everywhere, or the scripts stop recognising each other's tokens.
 */
@OnchainLibrary
public class WalletLib {

    /**
     * What the wallet proposes to do: pay {@code recipient} exactly {@code lovelaceAmount}, with
     * an opaque payload along for the ride.
     *
     * <p>Declared here rather than inside a validator because all three scripts read it, and a
     * record nested in one validator class is not visible to the others.
     */
    public record PaymentIntent(Address recipient, BigInteger lovelaceAmount, byte[] data) {}

    /**
     * The token that marks a pending payment intent.
     *
     * <p>A method rather than a constant: julc inlines library <em>methods</em> across
     * validators, but a static field read from another class does not lower.
     */
    public static byte[] markerName() {
        return "INTENT_MARKER".getBytes();
    }

    public static boolean hasMarker(Value value, byte[] walletPolicy) {
        return ValuesLib.assetOf(value, walletPolicy, markerName()).equals(BigInteger.ONE);
    }

    /** Compares payment credentials — the part that decides who can actually spend. */
    public static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}

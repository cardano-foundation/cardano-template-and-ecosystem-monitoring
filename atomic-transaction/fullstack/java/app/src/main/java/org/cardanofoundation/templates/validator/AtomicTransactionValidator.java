package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MultiValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;

/**
 * One script with two entrypoints of deliberately mismatched strictness.
 *
 * <p>The spend entrypoint accepts anything. The mint entrypoint demands a password.
 * Using both in a single transaction is what makes Cardano's atomicity visible: the
 * permissive spend still cannot commit on its own, because the strict mint runs in the
 * same transaction and one failing script invalidates the whole thing.
 *
 * <p>julc compiles this class to Plutus V3 during {@code javac}.
 */
@MultiValidator
public class AtomicTransactionValidator {

    public static final String REQUIRED_PASSWORD = "super_secret_password";

    public record Redeemer(String password) {}

    /** Gates the whole transaction: mint only when the redeemer carries the password. */
    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(Redeemer redeemer, ScriptContext ctx) {
        // Read record components through the accessor. julc lowers accessors, not raw
        // field reads, and a bare `redeemer.password` fails with "Unbound variable".
        return REQUIRED_PASSWORD.equals(redeemer.password());
    }

    /** Accepts unconditionally, so any failure you observe came from the mint. */
    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData redeemer, ScriptContext ctx) {
        return true;
    }
}

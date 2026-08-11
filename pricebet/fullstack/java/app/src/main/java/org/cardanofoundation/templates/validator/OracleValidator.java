package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;

/**
 * Holds a price reading at a stable address.
 *
 * <p>This script exists so the example is self-contained; a real deployment would point
 * {@code oracleHash} at whichever oracle it trusts. Its only job is to give the reading an
 * address that {@link BetValidator} can name, and a script hash that cannot be forged.
 *
 * <p>The reading is always consumed as a <b>reference input</b>, so this spend path is never
 * exercised in normal operation. It refuses everything, which means a published reading cannot
 * be quietly withdrawn or rewritten while bets are relying on it — publishing a correction means
 * publishing a new UTxO, leaving the old one visible.
 */
@SpendingValidator
public class OracleValidator {

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData datum, PlutusData redeemer, ScriptContext ctx) {
        return false;
    }
}

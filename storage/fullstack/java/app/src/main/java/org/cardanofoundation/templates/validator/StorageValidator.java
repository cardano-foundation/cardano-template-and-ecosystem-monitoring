package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;

/**
 * The append-only half of the registry: a script that never lets go.
 *
 * <p>Every snapshot published here is permanent, and this validator is the reason. It refuses
 * every spend, so a registry UTxO has no exit — no owner, no deadline, no admin key changes
 * that. What lands here stays here.
 *
 * <p>Because nothing can ever be re-checked after the fact, the datum has to be right the
 * moment it is written. That check lives in {@link StorageMintValidator}, which is the only
 * way an output reaches this address with a registry NFT attached.
 */
@SpendingValidator
public class StorageValidator {

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData datum, PlutusData redeemer, ScriptContext ctx) {
        return false;
    }
}

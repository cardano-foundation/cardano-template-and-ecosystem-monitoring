package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.randomTxOutRef_typed;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;

import org.cardanofoundation.templates.validator.AtomicTransactionValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.PolicyId;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled validator on a real Plutus VM, so these tests exercise the same
 * UPLC the chain would execute — not the Java source.
 */
class AtomicTransactionValidatorTest {

    private static final PolicyId POLICY = PolicyId.of(new byte[28]);

    private final JulcEval eval = JulcEval.forClass(AtomicTransactionValidator.class);

    @Test
    void mintAcceptsTheRequiredPassword() {
        boolean accepted = eval
                .call("mint", redeemer(AtomicTransactionValidator.REQUIRED_PASSWORD), mintContext())
                .asBoolean();

        assertTrue(accepted);
    }

    @Test
    void mintRejectsAWrongPassword() {
        boolean accepted = eval
                .call("mint", redeemer("wrong_password"), mintContext())
                .asBoolean();

        assertFalse(accepted);
    }

    /**
     * A near-miss rather than an obviously different value: the password is compared as
     * bytes, so a same-length variant proves the check is not just a length test.
     */
    @Test
    void mintRejectsAPasswordThatDiffersByOneCharacter() {
        String nearMiss = "super_secret_passwerd";

        boolean accepted = eval.call("mint", redeemer(nearMiss), mintContext()).asBoolean();

        assertFalse(accepted);
    }

    @Test
    void spendAcceptsAnyRedeemer() {
        boolean accepted = eval.call("spend", unitData(), spendContext()).asBoolean();

        assertTrue(accepted);
    }

    private static PlutusData redeemer(String password) {
        return constrData(0, bytesData(password.getBytes(StandardCharsets.UTF_8)));
    }

    private static PlutusData mintContext() {
        return ScriptContextTestBuilder.minting(POLICY).buildPlutusData();
    }

    private static PlutusData spendContext() {
        return ScriptContextTestBuilder.spending(randomTxOutRef_typed()).buildPlutusData();
    }
}

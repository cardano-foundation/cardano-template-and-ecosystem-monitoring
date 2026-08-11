package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.StorageValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.ledger.ScriptHash;
import com.bloxbean.cardano.julc.ledger.TxId;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * The registry's permanence rests on a single claim: nothing spends from this script.
 *
 * <p>An always-false validator is trivial to write and easy to get subtly wrong — an accidental
 * {@code true} branch would silently make every published snapshot editable. So rather than
 * trusting the source, these tests throw the cases at it that a rule-based validator would
 * normally wave through: the rightful owner, a signed transaction, a well-formed datum.
 */
class StorageValidatorTest {

    private static final byte[] STORAGE_HASH = fill((byte) 0x07, 28);
    private static final Address STORAGE = new Address(
            new Credential.ScriptCredential(new ScriptHash(STORAGE_HASH)), Optional.empty());

    private static final byte[] PUBLISHER = fill((byte) 0x01, 28);

    private static final TxOutRef ENTRY =
            new TxOutRef(new TxId(fill((byte) 0xCC, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(StorageValidator.class);

    @Test
    void refusesTheSnapshotPublisher() {
        assertFalse(spend(registryDatum(), unitData(), PUBLISHER));
    }

    @Test
    void refusesAnUnsignedSpend() {
        assertFalse(spend(registryDatum(), unitData(), null));
    }

    /** No redeemer is a magic word — there is no branch to reach. */
    @Test
    void refusesEveryRedeemer() {
        assertFalse(spend(registryDatum(), constrData(0), PUBLISHER));
        assertFalse(spend(registryDatum(), constrData(1), PUBLISHER));
        assertFalse(spend(registryDatum(), intData(42), PUBLISHER));
        assertFalse(spend(registryDatum(), bytesData("unlock".getBytes(StandardCharsets.UTF_8)), PUBLISHER));
    }

    /** Nor is a malformed datum an escape hatch. */
    @Test
    void refusesAnUnexpectedDatum() {
        assertFalse(spend(unitData(), unitData(), PUBLISHER));
    }

    private boolean spend(PlutusData datum, PlutusData redeemer, byte[] signer) {
        TxOut held = new TxOut(STORAGE, Value.lovelace(BigInteger.valueOf(2_000_000)),
                new OutputDatum.OutputDatumInline(datum), Optional.empty());

        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(ENTRY)
                .input(new TxInInfo(ENTRY, held));

        if (signer != null) {
            builder = builder.signer(new PubKeyHash(signer));
        }
        return eval.call("spend", datum, redeemer, builder.buildPlutusData()).asBoolean();
    }

    private static PlutusData registryDatum() {
        return constrData(0,
                bytesData("2025-12-19".getBytes(StandardCharsets.UTF_8)),
                constrData(0),
                bytesData(fill((byte) 0x5A, 32)),
                intData(1_700_000_000L));
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}

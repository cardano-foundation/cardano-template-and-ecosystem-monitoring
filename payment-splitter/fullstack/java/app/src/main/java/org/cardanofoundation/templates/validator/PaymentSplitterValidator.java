package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Splits whatever it holds equally between a fixed set of payees.
 *
 * <p>The payee list is a script parameter, so each group has its own address and its membership
 * is fixed the moment that address exists. Anyone may trigger the split — there is no privileged
 * caller — because the rules leave nothing for the caller to gain by doing so.
 */
@SpendingValidator
public class PaymentSplitterValidator {

    @Param static JulcList<byte[]> payees;

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData datum, PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        JulcList<TxOut> outputs = ContextsLib.txInfoOutputs(tx);

        // Closed set: every output must go to a payee. Without this the caller could route a
        // slice to an address of their own and still "split" the rest.
        if (!outputs.all(output -> isPayee(OutputLib.txOutAddress(output)))) {
            return false;
        }
        BigInteger fee = ContextsLib.txInfoFee(tx);
        BigInteger firstShare = shareOf(payees.head(), tx, fee);

        return payees.all(payee -> shareOf(payee, tx, fee).equals(firstShare));
    }

    /**
     * What this payee actually gained.
     *
     * <p>The correction is the whole difficulty. Whoever submits the transaction pays the fee and
     * gets change back as an output, so counting raw outputs would credit them with their own
     * money and no split would ever look equal. Subtracting what they contributed, less the fee
     * they covered, leaves only the share newly assigned to them.
     */
    static BigInteger shareOf(byte[] payee, TxInfo tx, BigInteger fee) {
        BigInteger received = totalTo(ContextsLib.txInfoOutputs(tx), payee);
        BigInteger contributed = totalFrom(ContextsLib.txInfoInputs(tx), payee);

        if (contributed.compareTo(BigInteger.ZERO) > 0) {
            return received.subtract(contributed.subtract(fee));
        }
        return received;
    }

    static BigInteger totalTo(JulcList<TxOut> outputs, byte[] payee) {
        return sum(outputs.filter(output -> isThisPayee(OutputLib.txOutAddress(output), payee)));
    }

    static BigInteger totalFrom(JulcList<TxInInfo> inputs, byte[] payee) {
        return sum(inputs
                .filter(input -> isThisPayee(OutputLib.txOutAddress(input.resolved()), payee))
                .map(input -> input.resolved()));
    }

    static BigInteger sum(JulcList<TxOut> outputs) {
        if (outputs.isEmpty()) {
            return BigInteger.ZERO;
        }
        return ValuesLib.lovelaceOf(OutputLib.txOutValue(outputs.head()))
                .add(sum(outputs.tail()));
    }

    static boolean isPayee(Address address) {
        return payees.any(payee -> isThisPayee(address, payee));
    }

    static boolean isThisPayee(Address address, byte[] payee) {
        return AddressLib.isPubKeyAddress(address)
                && ByteStringLib.equals(AddressLib.credentialHash(address), payee);
    }
}

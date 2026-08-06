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
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * The vault the wallet actually spends from.
 *
 * <p>Two ways out:
 *
 * <ul>
 *   <li><b>ExecuteTx</b> — carry out a pending intent: pay the recipient exactly what the intent
 *       says, and burn the marker so it cannot be replayed.
 *   <li><b>Withdraw</b> — an owner-only sweep, for recovery or closing the wallet.
 * </ul>
 *
 * <p>Execution is <em>co-authorisation</em>, not delegation. The intent decides what happens; the
 * owner's signature decides whether it happens at all. Neither is sufficient alone, which is what
 * makes it safe to publish an intent openly before executing it.
 */
@SpendingValidator
public class FundsValidator {

    @Param static byte[] owner;

    /** Binds this vault to one wallet, so another wallet's markers mean nothing here. */
    @Param static byte[] walletPolicy;

    public sealed interface Action permits ExecuteTx, Withdraw {}

    public record ExecuteTx() implements Action {}

    public record Withdraw() implements Action {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PlutusData datum, Action redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);

        if (!ContextsLib.signedBy(tx, owner)) {
            return false;
        }
        return switch (redeemer) {
            case ExecuteTx ignored -> executes(tx);
            case Withdraw ignored -> true;
        };
    }

    static boolean executes(TxInfo tx) {
        // Exactly one intent in the transaction, so it is unambiguous which one is being paid.
        JulcList<TxInInfo> intents = ContextsLib.txInfoInputs(tx)
                .filter(input -> WalletLib.hasMarker(
                        OutputLib.txOutValue(input.resolved()), walletPolicy));

        if (intents.size() != 1L) {
            return false;
        }
        WalletLib.PaymentIntent intent =
                (WalletLib.PaymentIntent) (Object)
                        OutputLib.getInlineDatum(intents.head().resolved());

        // Exact equality, not "at least": paying more than the intent says would be a transfer
        // the owner never agreed to, even though it looks generous.
        BigInteger paid = lovelacePaidTo(ContextsLib.txInfoOutputs(tx), intent.recipient());
        boolean burned = ValuesLib.assetOf(ContextsLib.txInfoMint(tx), walletPolicy,
                WalletLib.markerName()).equals(BigInteger.valueOf(-1));

        return paid.equals(intent.lovelaceAmount()) && burned;
    }

    /** Sums every output to the recipient — a payment may legitimately arrive split. */
    static BigInteger lovelacePaidTo(JulcList<TxOut> outputs, Address recipient) {
        return total(outputs.filter(
                output -> WalletLib.sameAddress(OutputLib.txOutAddress(output), recipient)));
    }

    static BigInteger total(JulcList<TxOut> outputs) {
        if (outputs.isEmpty()) {
            return BigInteger.ZERO;
        }
        return ValuesLib.lovelaceOf(OutputLib.txOutValue(outputs.head()))
                .add(total(outputs.tail()));
    }
}

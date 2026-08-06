package org.cardanofoundation.templates.validator;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * Two-party asset swap with explicit opt-in, and no arbitrator.
 *
 * <p>Lifecycle:
 * <pre>
 *   Initiation    initiator has locked their side
 *        │  RecipientDeposit — recipient puts up their side and is named in the datum
 *        ▼
 *   ActiveEscrow  both sides committed
 *        │  CompleteTrade — both sign, bundles cross over
 *        │  CancelTrade   — unwind, each side gets their own deposit back
 *        ▼
 *      settled
 * </pre>
 *
 * <p>Every branch requires exactly one script input, which is what stops one transaction from
 * satisfying two escrows at once by pointing both at the same outputs.
 */
@SpendingValidator
public class EscrowValidator {

    public sealed interface EscrowDatum permits Initiation, ActiveEscrow {}

    public record Initiation(Address initiator, Value initiatorAssets) implements EscrowDatum {}

    public record ActiveEscrow(Address initiator, Value initiatorAssets,
                               Address recipient, Value recipientAssets) implements EscrowDatum {}

    public sealed interface EscrowRedeemer permits RecipientDeposit, CancelTrade, CompleteTrade {}

    public record RecipientDeposit(Address recipient, Value recipientAssets)
            implements EscrowRedeemer {}

    public record CancelTrade() implements EscrowRedeemer {}

    public record CompleteTrade() implements EscrowRedeemer {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(EscrowDatum datum, EscrowRedeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxInInfo ownInput = ContextsLib.findOwnInput(ctx).get();
        Address ownAddress = OutputLib.txOutAddress(ownInput.resolved());

        // Exactly one input from this script. Without it, two escrow UTxOs could be
        // spent by one transaction that only pays out enough to satisfy one of them.
        if (countInputsAt(ContextsLib.txInfoInputs(tx), ownAddress) != 1L) {
            return false;
        }

        JulcList<TxOut> outputs = ContextsLib.txInfoOutputs(tx);

        return switch (redeemer) {
            case RecipientDeposit depositRedeemer -> deposit(datum, depositRedeemer, outputs, ownAddress,
                    OutputLib.txOutValue(ownInput.resolved()));
            case CancelTrade ignored -> cancel(datum, tx, outputs, ownAddress);
            case CompleteTrade ignored -> complete(datum, tx, outputs, ownAddress);
        };
    }

    /**
     * Initiation → ActiveEscrow.
     *
     * <p>Deliberately unsigned: anyone may push this transition, because the redeemer names the
     * recipient and the value check forces whoever submits it to actually put up that side. The
     * initiator's terms must be carried over untouched.
     */
    static boolean deposit(EscrowDatum datum, RecipientDeposit depositRedeemer,
                           JulcList<TxOut> outputs, Address ownAddress, Value lockedValue) {
        // Pattern-matching switch, not `instanceof ... name`: julc lowers the former only,
        // and rejects the latter with "Undefined variable".
        return switch (datum) {
            case ActiveEscrow ignored -> false;
            case Initiation initiation -> {
                // The escrow continues, so exactly one output must return to the script.
                if (OutputLib.countOutputsAt(outputs, ownAddress) != 1L) {
                    yield false;
                }
                TxOut continuing = OutputLib.uniqueOutputAt(outputs, ownAddress);
                yield carriesTerms(continuing, initiation, depositRedeemer, lockedValue);
            }
        };
    }

    static boolean carriesTerms(TxOut continuing, Initiation initiation,
                                RecipientDeposit depositRedeemer, Value lockedValue) {
        // Double cast through Object, the same idiom julc's own stdlib uses. On-chain a datum
        // is just Data, so this is a no-op that the pattern match below decodes; javac simply
        // has no way to know PlutusData and EscrowDatum describe the same bytes.
        EscrowDatum outDatum = (EscrowDatum) (Object) OutputLib.getInlineDatum(continuing);

        return switch (outDatum) {
            case Initiation ignored -> false;
            case ActiveEscrow active ->
                    sameAddress(active.initiator(), initiation.initiator())
                            && ValuesLib.eq(active.initiatorAssets(), initiation.initiatorAssets())
                            && sameAddress(active.recipient(), depositRedeemer.recipient())
                            && ValuesLib.eq(active.recipientAssets(), depositRedeemer.recipientAssets())
                            // Greater-or-equal, not equal: extra ada riding along is fine. What
                            // matters is the recipient's bundle being present on top of what was
                            // already locked.
                            && ValuesLib.geq(OutputLib.txOutValue(continuing),
                                    ValuesLib.add(lockedValue, depositRedeemer.recipientAssets()));
        };
    }

    /**
     * Unwind. Before the recipient joined, the initiator alone can reclaim. Once both sides have
     * committed, either party may trigger the unwind but the transaction must repay <em>both</em>
     * — otherwise one party could cancel and walk away with the other's deposit.
     */
    static boolean cancel(EscrowDatum datum, TxInfo tx, JulcList<TxOut> outputs,
                          Address ownAddress) {
        // Nothing may return to the script: this settles the escrow.
        if (OutputLib.countOutputsAt(outputs, ownAddress) != 0L) {
            return false;
        }

        return switch (datum) {
            case Initiation initiation -> signedBy(tx, initiation.initiator());

            case ActiveEscrow active ->
                    (signedBy(tx, active.initiator()) || signedBy(tx, active.recipient()))
                            && paidAtLeast(outputs, active.initiator(), active.initiatorAssets())
                            && paidAtLeast(outputs, active.recipient(), active.recipientAssets());
        };
    }

    /**
     * Atomic swap. Both parties must sign — neither can force settlement — and the bundles cross
     * over: the initiator receives the recipient's assets and vice versa.
     */
    static boolean complete(EscrowDatum datum, TxInfo tx, JulcList<TxOut> outputs,
                            Address ownAddress) {
        // Nothing may return to the script: this settles the escrow.
        if (OutputLib.countOutputsAt(outputs, ownAddress) != 0L) {
            return false;
        }

        return switch (datum) {
            // Nothing to complete before the recipient has joined.
            case Initiation ignored -> false;

            case ActiveEscrow active ->
                    signedBy(tx, active.initiator())
                            && signedBy(tx, active.recipient())
                            && paidAtLeast(outputs, active.initiator(), active.recipientAssets())
                            && paidAtLeast(outputs, active.recipient(), active.initiatorAssets());
        };
    }

    /**
     * True when everything paid to {@code party} covers what they are owed.
     *
     * <p>Sums across outputs rather than demanding a single one. A party is routinely paid more
     * than once in the same transaction — the fee payer receives change alongside their payout —
     * so requiring exactly one output would reject ordinary settlements.
     */
    static boolean paidAtLeast(JulcList<TxOut> outputs, Address party, Value owed) {
        JulcList<TxOut> paid =
                outputs.filter(output -> sameAddress(OutputLib.txOutAddress(output), party));
        return !paid.isEmpty() && ValuesLib.geq(total(paid), owed);
    }

    /**
     * Adds up the values of a non-empty output list.
     *
     * <p>Folds from the first element rather than from an empty value: julc's value helpers walk
     * the underlying map with head/tail and abort on the empty map that {@code Value.zero()}
     * produces.
     */
    static Value total(JulcList<TxOut> outputs) {
        Value head = OutputLib.txOutValue(outputs.head());
        JulcList<TxOut> rest = outputs.tail();
        return rest.isEmpty() ? head : ValuesLib.add(head, total(rest));
    }

    static long countInputsAt(JulcList<TxInInfo> inputs, Address address) {
        return inputs.filter(input -> sameAddress(OutputLib.txOutAddress(input.resolved()), address))
                .size();
    }

    /**
     * Compares payment credentials rather than whole addresses.
     *
     * <p>Building a {@code Credential} to compare against real chain data crashes julc's
     * evaluator, and whole-address equality would also make a payment to the same key fail
     * merely because the staking part differs.
     */
    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }

    static boolean signedBy(TxInfo tx, Address party) {
        return AddressLib.isPubKeyAddress(party)
                && ContextsLib.signedBy(tx, AddressLib.credentialHash(party));
    }
}

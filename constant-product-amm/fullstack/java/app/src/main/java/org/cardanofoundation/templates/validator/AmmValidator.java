package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MultiValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * A constant-product automated market maker.
 *
 * <p>One script does both jobs: it guards the pool UTxO and mints the LP tokens, so the LP policy
 * id <em>is</em> this script's hash. The datum records the two reserves and the LP supply; each
 * action rewrites it, and the script checks the arithmetic.
 *
 * <p>The rule that makes the rest safe is at the very end of {@link #spend}: the datum's reserves
 * must equal the tokens the continuing output actually holds. Without it every handler below
 * could be satisfied by a well-formed datum while the real tokens were sent somewhere else —
 * arithmetic that balances on paper and drains the pool in practice.
 */
@MultiValidator
public class AmmValidator {

    public record AmmDatum(BigInteger r0, BigInteger r1, BigInteger lpSupply) {}

    public sealed interface AmmRedeemer permits Deposit, Redeem, Swap {}

    public record Deposit(BigInteger x0, BigInteger x1) implements AmmRedeemer {}

    public record Redeem(BigInteger lp) implements AmmRedeemer {}

    public record Swap(boolean t0In, BigInteger amountIn, BigInteger minAmountOut)
            implements AmmRedeemer {}

    /**
     * The pair and the fee rate, fixed in the script's hash.
     *
     * <p>Deliberately six flat parameters rather than one nested record. A parameter containing
     * nested records is encoded differently by the two paths that apply them — the test harness
     * and the off-chain loader — so the same script read different values on chain than under
     * test. Flat parameters have one unambiguous encoding.
     */
    @Param static byte[] t0Policy;

    @Param static byte[] t0Name;

    @Param static byte[] t1Policy;

    @Param static byte[] t1Name;

    @Param static BigInteger feeNumerator;

    @Param static BigInteger feeDenominator;

    /**
     * Minting only reconciles the LP delta with the datum; every invariant lives in the spend
     * side. That split is safe because LP tokens can only move when the pool is spent.
     */
    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        JulcList<TxOut> poolInputs = ContextsLib.txInfoInputs(tx)
                .map(input -> input.resolved())
                .filter(resolved -> atScript(OutputLib.txOutAddress(resolved), policyId));

        if (poolInputs.isEmpty()) {
            return false;
        }
        AmmDatum before = (AmmDatum) (Object) OutputLib.getInlineDatum(poolInputs.head());

        JulcList<TxOut> continuing = ContextsLib.txInfoOutputs(tx)
                .filter(output -> atScript(OutputLib.txOutAddress(output), policyId));

        if (continuing.size() != 1L) {
            return false;
        }
        AmmDatum after = (AmmDatum) (Object) OutputLib.getInlineDatum(continuing.head());

        BigInteger declared = after.lpSupply().subtract(before.lpSupply());
        BigInteger actual = mintedUnderPolicy(tx, policyId);

        return actual.equals(declared);
    }

    static BigInteger mintedUnderPolicy(TxInfo tx, byte[] policyId) {
        return sumAmounts(ValuesLib.flattenTyped(ContextsLib.txInfoMint(tx))
                .filter(entry -> ByteStringLib.equals(entry.policyId(), policyId))
                .map(entry -> entry.amount()));
    }

    static BigInteger sumAmounts(JulcList<BigInteger> amounts) {
        if (amounts.isEmpty()) {
            return BigInteger.ZERO;
        }
        return amounts.head().add(sumAmounts(amounts.tail()));
    }

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(AmmDatum datum, AmmRedeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();
        Address poolAddress = OutputLib.txOutAddress(own);

        JulcList<TxOut> continuing = ContextsLib.txInfoOutputs(tx)
                .filter(output -> sameAddress(OutputLib.txOutAddress(output), poolAddress));

        if (continuing.size() != 1L) {
            return false;
        }
        TxOut poolOutput = continuing.head();
        AmmDatum next = (AmmDatum) (Object) OutputLib.getInlineDatum(poolOutput);

        boolean transitionValid = switch (redeemer) {
            case Deposit action -> deposits(datum, next, action);
            case Redeem action -> redeems(datum, next, action);
            case Swap action -> swaps(datum, next, action);
        };

        // Bind the datum to reality. The handlers only check arithmetic; this is what stops a
        // valid-looking datum being paired with tokens sent elsewhere.
        return transitionValid
                && ValuesLib.assetOf(OutputLib.txOutValue(poolOutput),
                        t0Policy, t0Name).equals(next.r0())
                && ValuesLib.assetOf(OutputLib.txOutValue(poolOutput),
                        t1Policy, t1Name).equals(next.r1());
    }

    /**
     * Adding liquidity. The first deposit sets the price; every later one must match it.
     *
     * <p>Requiring the ratio to match is what stops a depositor moving the price in their own
     * favour by funding the two sides unevenly.
     */
    static boolean deposits(AmmDatum datum, AmmDatum next, Deposit action) {
        BigInteger minted = next.lpSupply().subtract(datum.lpSupply());

        // Written as one expression rather than nested early returns: a `return false` inside an
        // if/else block does not lower the way it reads, and silently let bad deposits through.
        return action.x0().compareTo(BigInteger.ZERO) > 0
                && action.x1().compareTo(BigInteger.ZERO) > 0
                && minted.compareTo(BigInteger.ZERO) > 0
                && (datum.lpSupply().equals(BigInteger.ZERO)
                        ? isIntegerSqrt(minted, action.x0().multiply(action.x1()))
                        : matchesPool(datum, action, minted))
                && next.r0().equals(datum.r0().add(action.x0()))
                && next.r1().equals(datum.r1().add(action.x1()));
    }

    /**
     * True when {@code candidate} is the integer square root of {@code product}.
     *
     * <p>The first deposit mints sqrt(x0·x1). Rather than computing a square root on chain, the
     * claimed amount is verified — which is exact and far cheaper.
     */
    static boolean isIntegerSqrt(BigInteger candidate, BigInteger product) {
        BigInteger low = candidate.multiply(candidate);
        BigInteger high = candidate.add(BigInteger.ONE).multiply(candidate.add(BigInteger.ONE));

        return low.compareTo(product) <= 0 && high.compareTo(product) > 0;
    }

    /**
     * A later deposit must match the pool's current ratio and mint proportionally.
     *
     * <p>The ratio rule is what stops a depositor moving the price in their own favour by funding
     * the two sides unevenly.
     */
    static boolean matchesPool(AmmDatum datum, Deposit action, BigInteger minted) {
        BigInteger lp0 = action.x0().multiply(datum.lpSupply()).divide(datum.r0());
        BigInteger lp1 = action.x1().multiply(datum.lpSupply()).divide(datum.r1());
        BigInteger expected = lp0.compareTo(lp1) <= 0 ? lp0 : lp1;

        return action.x0().multiply(datum.r1()).equals(action.x1().multiply(datum.r0()))
                && minted.equals(expected);
    }

    /** Removing liquidity returns a proportional slice of both reserves. */
    static boolean redeems(AmmDatum datum, AmmDatum next, Redeem action) {
        BigInteger lp = action.lp();
        BigInteger out0 = lp.multiply(datum.r0()).divide(datum.lpSupply());
        BigInteger out1 = lp.multiply(datum.r1()).divide(datum.lpSupply());

        return lp.compareTo(BigInteger.ZERO) > 0
                && lp.compareTo(datum.lpSupply()) <= 0
                && next.r0().equals(datum.r0().subtract(out0))
                && next.r1().equals(datum.r1().subtract(out1))
                && next.lpSupply().equals(datum.lpSupply().subtract(lp));
    }

    /**
     * Trading. The output is whatever the constant-product curve allows after the fee.
     *
     * <p>Two guards sit either side of the arithmetic: the trader's own slippage bound, and the
     * invariant {@code r0·r1} never decreasing — which is what actually keeps the pool solvent
     * regardless of rounding.
     */
    static boolean swaps(AmmDatum datum, AmmDatum next, Swap action) {
        // Written as two branches rather than one with mutable locals: julc requires every
        // on-chain variable to be initialised where it is declared.
        return action.amountIn().compareTo(BigInteger.ZERO) > 0
                && (action.t0In()
                        ? sells(datum, next, action, datum.r0(), datum.r1(), true)
                        : sells(datum, next, action, datum.r1(), datum.r0(), false));
    }

    /**
     * One direction of a swap, with {@code reserveIn} and {@code reserveOut} named accordingly.
     *
     * <p>The fee is applied by scaling the input rather than the output, which is why
     * {@code feeDenominator} multiplies only the reserve side of the divisor.
     */
    static boolean sells(AmmDatum datum, AmmDatum next, Swap action,
            BigInteger reserveIn, BigInteger reserveOut, boolean t0In) {
        BigInteger adjusted = action.amountIn().multiply(feeNumerator);
        BigInteger amountOut = reserveOut.multiply(adjusted)
                .divide(reserveIn.multiply(feeDenominator).add(adjusted));

        BigInteger newR0 = t0In
                ? datum.r0().add(action.amountIn())
                : datum.r0().subtract(amountOut);
        BigInteger newR1 = t0In
                ? datum.r1().subtract(amountOut)
                : datum.r1().add(action.amountIn());

        return amountOut.compareTo(action.minAmountOut()) >= 0
                && newR0.multiply(newR1).compareTo(datum.r0().multiply(datum.r1())) >= 0
                && next.r0().equals(newR0)
                && next.r1().equals(newR1)
                && next.lpSupply().equals(datum.lpSupply());
    }

    static boolean atScript(Address address, byte[] scriptHash) {
        return AddressLib.isScriptAddress(address)
                && ByteStringLib.equals(AddressLib.credentialHash(address), scriptHash);
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}

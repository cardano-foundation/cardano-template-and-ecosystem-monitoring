package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MintingValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;

/**
 * Opens and closes a game by minting or burning its identity token.
 *
 * <p>Opening requires <em>both</em> players to sign: a lottery is a mutual agreement, and one
 * player must not be able to enrol another. Both commitments must also be non-empty, because an
 * empty bytestring is the "not yet revealed" sentinel — a game opened with an empty commit would
 * have a commitment that any reveal trivially matches.
 *
 * <p>Burning is deliberately open. {@link LotteryValidator} decides when a game may close and who
 * may close it; re-checking that here would be circular.
 */
@MintingValidator
public class LotteryCreatorValidator {

    /** Independent games get independent policies, and so independent token identities. */
    @Param static BigInteger gameIndex;

    public sealed interface MintRedeemer permits Mint, Burn {}

    public record Mint() implements MintRedeemer {}

    public record Burn() implements MintRedeemer {}

    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(MintRedeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        return switch (redeemer) {
            case Mint ignored -> opensAGame(tx, policyId);
            case Burn ignored -> LotteryLib.onlyToken(ContextsLib.txInfoMint(tx), policyId,
                    BigInteger.valueOf(-1));
        };
    }

    static boolean opensAGame(TxInfo tx, byte[] policyId) {
        if (!LotteryLib.onlyToken(ContextsLib.txInfoMint(tx), policyId, BigInteger.ONE)) {
            return false;
        }
        JulcList<TxOut> games = OutputLib.outputsWithToken(
                ContextsLib.txInfoOutputs(tx), policyId, LotteryLib.tokenName());

        if (games.size() != 1L) {
            return false;
        }
        TxOut game = games.head();
        if (!hasInlineDatum(game)) {
            return false;
        }
        LotteryLib.LotteryDatum datum =
                (LotteryLib.LotteryDatum) (Object) OutputLib.getInlineDatum(game);

        return ContextsLib.signedBy(tx, datum.player1())
                && ContextsLib.signedBy(tx, datum.player2())
                && !LotteryLib.isEmpty(datum.commit1())
                && !LotteryLib.isEmpty(datum.commit2());
    }

    static boolean hasInlineDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.OutputDatumInline ignored -> true;
            case OutputDatum.OutputDatumHash ignored -> false;
            case OutputDatum.NoOutputDatum ignored -> false;
        };
    }
}

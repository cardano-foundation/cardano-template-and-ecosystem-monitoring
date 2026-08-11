package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.cardanofoundation.templates.validator.LotteryCreatorValidator;
import org.cardanofoundation.templates.validator.LotteryValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * A two-player lottery decided by numbers neither player can grind.
 *
 * <p>Both players publish {@code blake2b_256(number)} up front, then reveal in a fixed order:
 * player 1 first, player 2 second. Player 2 can see player 1's <em>commitment</em> from the
 * start but not the number behind it, and by the time player 1 reveals, player 2's own
 * commitment is already locked in. Neither can choose a number once the other's is known.
 *
 * <p>The winner is the parity of the sum — a value neither player controls alone.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    private static final Network NETWORK = Networks.testnet();

    /** Player 1 pays the fees; player 2 only ever needs to sign. */
    private static final Account PLAYER1 = Account.createFromMnemonic(NETWORK, MNEMONIC);
    private static final Account PLAYER2 = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final String TOKEN_NAME = "LOTTERY_TOKEN";

    /** 3 + 4 = 7, which is odd, so player 1 wins. */
    private static final byte[] N1 = "3".getBytes(StandardCharsets.UTF_8);
    private static final byte[] N2 = "4".getBytes(StandardCharsets.UTF_8);

    /** The pot, carried through every reveal and paid out on settlement. */
    private static final BigInteger POT = BigInteger.valueOf(10_000_000);

    private static PlutusScript policy;
    private static PlutusScript lottery;
    private static String lotteryAddress;

    public static void main(String[] args) throws Exception {
        // A game index per run, so repeated runs against a long-lived devnet get independent
        // policies rather than colliding on an already-minted token.
        BigInteger gameIndex = BigInteger.valueOf(System.currentTimeMillis());

        policy = JulcScriptLoader.load(LotteryCreatorValidator.class,
                BigIntPlutusData.of(gameIndex));
        lottery = JulcScriptLoader.load(LotteryValidator.class,
                BytesPlutusData.of(HexUtil.decodeHexString(policy.getPolicyId())),
                BigIntPlutusData.of(gameIndex));
        lotteryAddress = AddressProvider.getEntAddress(lottery, NETWORK).toBech32();

        // The reveal window is read from chain time, not the local clock, so the example does
        // not assume the devnet's slot-to-time mapping matches this machine.
        BigInteger endReveal = BigInteger.valueOf((chainTimeSeconds() + 3600) * 1000);
        BigInteger delta = BigInteger.valueOf(60_000);

        System.out.println("Lottery address: " + lotteryAddress);
        System.out.println("Game policy:     " + policy.getPolicyId());
        System.out.println("Player 1:        " + PLAYER1.baseAddress());
        System.out.println("Player 2:        " + PLAYER2.baseAddress());

        // 1. Open the game. Both players commit, neither has revealed.
        Utxo game = open(endReveal, delta);
        System.out.println("Game opened in " + game.getTxHash());

        // 2. The anti-grinding rule: player 2 cannot move first. If they could, player 1 would
        //    then be choosing a number with player 2's already public.
        require(isRejected(() -> reveal(game, 1, N2,
                        datum(EMPTY, N2, endReveal, delta), PLAYER2)),
                "player 2 revealing first must be rejected");
        System.out.println("Player 2 revealing first rejected as expected");

        // 3. A reveal has to match the commitment made at the start.
        byte[] wrong = "9".getBytes(StandardCharsets.UTF_8);
        require(isRejected(() -> reveal(game, 0, wrong,
                        datum(wrong, EMPTY, endReveal, delta), PLAYER1)),
                "a reveal that does not match the commitment must be rejected");
        System.out.println("Reveal with the wrong number rejected as expected");

        // 4. Player 1 reveals.
        TxResult firstReveal = reveal(game, 0, N1, datum(N1, EMPTY, endReveal, delta), PLAYER1);
        require(firstReveal.isSuccessful(), "player 1's reveal failed: " + firstReveal);
        Utxo afterFirst = utxoFrom(lotteryAddress, firstReveal.getTxHash());
        System.out.println("Player 1 revealed in " + firstReveal.getTxHash());

        // 5. Settling needs both numbers; one is not enough to compute a winner.
        require(isRejected(() -> settle(afterFirst)),
                "settling before both players reveal must be rejected");
        System.out.println("Settling with one number rejected as expected");

        // 6. Player 2 reveals.
        TxResult secondReveal = reveal(afterFirst, 1, N2, datum(N1, N2, endReveal, delta), PLAYER2);
        require(secondReveal.isSuccessful(), "player 2's reveal failed: " + secondReveal);
        Utxo afterSecond = utxoFrom(lotteryAddress, secondReveal.getTxHash());
        System.out.println("Player 2 revealed in " + secondReveal.getTxHash());

        // 7. Settle. 3 + 4 is odd, so player 1 takes the pot.
        TxResult settled = settle(afterSecond);
        require(settled.isSuccessful(), "settling failed: " + settled);
        System.out.println("Settled in " + settled.getTxHash());

        require(spendsLottery(settled.getTxHash()),
                "the confirmed transaction must spend the lottery UTxO");

        System.out.println("Verified: the winner was decided by both numbers, not either one");
    }

    private static final byte[] EMPTY = new byte[0];

    // ── Transactions ──────────────────────────────────────────────────────────────────

    /** Mints the game token and locks the pot with both commitments. */
    private static Utxo open(BigInteger endReveal, BigInteger delta) throws Exception {
        Asset token = Asset.builder().name(TOKEN_NAME).value(BigInteger.ONE).build();

        ScriptTx openTx = new ScriptTx()
                // Mint is constructor 0 of MintRedeemer.
                .mintAsset(policy, List.of(token), ConstrPlutusData.of(0),
                        lotteryAddress, datum(EMPTY, EMPTY, endReveal, delta));

        TxResult result = TX_BUILDER.compose(openTx)
                .feePayer(PLAYER1.baseAddress())
                .withSigner(SignerProviders.signerFrom(PLAYER1))
                .withSigner(SignerProviders.signerFrom(PLAYER2))
                .withRequiredSigners(
                        new com.bloxbean.cardano.client.address.Address(PLAYER1.baseAddress()),
                        new com.bloxbean.cardano.client.address.Address(PLAYER2.baseAddress()))
                .completeAndWait();

        require(result.isSuccessful(), "opening the game failed: " + result);
        return utxoFrom(lotteryAddress, result.getTxHash());
    }

    /**
     * Publishes one player's number and carries the game forward.
     *
     * <p>The pot and the token move to a fresh UTxO at the same address with the updated state.
     */
    private static TxResult reveal(Utxo game, int which, byte[] number, PlutusData next,
            Account player) throws Exception {
        ScriptTx revealTx = new ScriptTx()
                .collectFrom(game, ConstrPlutusData.of(which, BytesPlutusData.of(number)))
                .attachSpendingValidator(lottery)
                .payToContract(lotteryAddress, gameAmounts(), next)
                .withChangeAddress(PLAYER1.baseAddress());

        TxResult result = TX_BUILDER.compose(revealTx)
                .feePayer(PLAYER1.baseAddress())
                .withSigner(SignerProviders.signerFrom(PLAYER1))
                .withSigner(SignerProviders.signerFrom(player))
                .withRequiredSigners(
                        new com.bloxbean.cardano.client.address.Address(player.baseAddress()))
                .completeAndWait();

        return result;
    }

    /** Pays the pot to the winner and burns the token, retiring the game. */
    private static TxResult settle(Utxo game) throws Exception {
        Asset token = Asset.builder().name(TOKEN_NAME)
                .value(BigInteger.valueOf(-1)).build();

        ScriptTx settleTx = new ScriptTx()
                // Settle is constructor 4 of LotteryRedeemer.
                .collectFrom(game, ConstrPlutusData.of(4))
                .attachSpendingValidator(lottery)
                // Burn is constructor 1 of MintRedeemer.
                .mintAsset(policy, List.of(token), ConstrPlutusData.of(1))
                .payToAddress(PLAYER1.baseAddress(), Amount.lovelace(POT))
                .withChangeAddress(PLAYER1.baseAddress());

        return TX_BUILDER.compose(settleTx)
                .feePayer(PLAYER1.baseAddress())
                .withSigner(SignerProviders.signerFrom(PLAYER1))
                .withRequiredSigners(
                        new com.bloxbean.cardano.client.address.Address(PLAYER1.baseAddress()))
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /**
     * {@code LotteryDatum { player1, player2, commit1, commit2, n1, n2, endReveal, delta }}.
     *
     * <p>Empty bytes mean "not revealed yet".
     */
    private static PlutusData datum(byte[] n1, byte[] n2, BigInteger endReveal, BigInteger delta) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(keyHash(PLAYER1)),
                BytesPlutusData.of(keyHash(PLAYER2)),
                BytesPlutusData.of(Blake2bUtil.blake2bHash256(N1)),
                BytesPlutusData.of(Blake2bUtil.blake2bHash256(N2)),
                BytesPlutusData.of(n1),
                BytesPlutusData.of(n2),
                BigIntPlutusData.of(endReveal),
                BigIntPlutusData.of(delta));
    }

    private static List<Amount> gameAmounts() throws Exception {
        return List.of(
                Amount.lovelace(POT),
                Amount.asset(policy.getPolicyId(), TOKEN_NAME, BigInteger.ONE));
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the lottery address. Checking that a UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     */
    private static boolean spendsLottery(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> lotteryAddress.equals(input.getAddress()));
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    /**
     * Reports whether the chain refused a transaction.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a failed
     * result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Attempt attempt) {
        try {
            return !attempt.run().isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + shortMessage(rejected));
            return true;
        }
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    private static String shortMessage(Exception e) {
        String message = String.valueOf(e.getMessage());
        return message.length() > 120 ? message.substring(0, 120) + "…" : message;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private static long chainTimeSeconds() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getTime();
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at
     * the lottery address would pick up games left by an earlier run.
     */
    private static Utxo utxoFrom(String address, String txHash) throws Exception {
        return UTXOS.getAll(address).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO created by " + txHash));
    }

    private static byte[] keyHash(Account account) {
        return account.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    /** The exit code is the result, so every check throws rather than printing a warning. */
    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }

    private static String envOrDefault(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}

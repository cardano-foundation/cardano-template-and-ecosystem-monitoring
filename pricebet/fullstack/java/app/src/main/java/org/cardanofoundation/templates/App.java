package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;

import org.cardanofoundation.templates.validator.BetValidator;
import org.cardanofoundation.templates.validator.OracleValidator;

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
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * A bet on whether a price clears a target before a deadline, settled by an oracle.
 *
 * <p>The owner stakes first and names the terms; a player joins by matching the stake. At
 * settlement the oracle's reading is consulted as a <b>reference input</b> — read, not consumed
 * — so any number of bets can resolve against the same reading in the same block without
 * competing for it.
 *
 * <p>The bet pins which oracle it trusts at creation, and no transition may re-point it. Without
 * that, a player could join and swap in an oracle that always reports a winning price.
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
    private static final Account OWNER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    /** Funded by the owner up front, so the player genuinely stakes their own ada. */
    private static final Account PLAYER = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final BigInteger STAKE = BigInteger.valueOf(5_000_000);
    private static final BigInteger POT = STAKE.multiply(BigInteger.TWO);
    private static final BigInteger TARGET = BigInteger.valueOf(100);

    private static final PlutusScript ORACLE = JulcScriptLoader.load(OracleValidator.class);
    private static final PlutusScript BET = JulcScriptLoader.load(BetValidator.class);

    private static final String ORACLE_ADDRESS =
            AddressProvider.getEntAddress(ORACLE, NETWORK).toBech32();
    private static final String BET_ADDRESS =
            AddressProvider.getEntAddress(BET, NETWORK).toBech32();

    public static void main(String[] args) throws Exception {
        // Deadlines come from chain time rather than the local clock, so the example does not
        // assume the devnet's slot-to-time mapping matches this machine.
        long now = chainTimeSeconds();
        BigInteger deadline = BigInteger.valueOf((now + 3600) * 1000);
        BigInteger expiry = deadline.add(BigInteger.valueOf(600_000));

        System.out.println("Bet address:    " + BET_ADDRESS);
        System.out.println("Oracle address: " + ORACLE_ADDRESS);
        System.out.println("Oracle hash:    " + hex(ORACLE.getScriptHash()));

        // 0. Give the player their own ada, so joining is a real stake and not the owner
        //    paying both sides.
        fundPlayer();

        // 1. Publish two readings: one that clears the target, one that falls short. Both live
        //    at the same oracle, so the losing case differs only in the number.
        Utxo good = publishReading(TARGET.add(BigInteger.valueOf(25)), expiry);
        Utxo short_ = publishReading(TARGET.subtract(BigInteger.ONE), expiry);
        System.out.println("Readings published: " + good.getTxHash());

        // 2. The owner opens the bet.
        Utxo bet = openBet(deadline);
        System.out.println("Bet opened in " + bet.getTxHash());

        // 3. Joining must not re-point the bet at a friendlier oracle.
        require(isRejected(() -> join(bet, deadline, fakeOracleHash(), POT)),
                "a join that swaps the oracle must be rejected");
        System.out.println("Join that swaps the oracle rejected as expected");

        // 4. Nor join without actually matching the stake.
        require(isRejected(() -> join(bet, deadline, ORACLE.getScriptHash(),
                        POT.subtract(BigInteger.valueOf(1_000_000)))),
                "a join that underfunds the pot must be rejected");
        System.out.println("Join that underfunds the pot rejected as expected");

        // 5. Join properly.
        TxResult joined = join(bet, deadline, ORACLE.getScriptHash(), POT);
        require(joined.isSuccessful(), "joining failed: " + joined);
        Utxo taken = utxoFrom(BET_ADDRESS, joined.getTxHash());
        System.out.println("Player joined in " + joined.getTxHash());

        // 6. A reading that falls short of the target does not win the pot.
        require(isRejected(() -> win(taken, short_, deadline)),
                "winning on a price below the target must be rejected");
        System.out.println("Win on a short price rejected as expected");

        // 7. The reading clears the target, so the player takes the pot.
        TxResult won = win(taken, good, deadline);
        require(won.isSuccessful(), "settling the win failed: " + won);
        System.out.println("Player won in " + won.getTxHash());

        require(spendsBet(won.getTxHash()), "the confirmed transaction must spend the bet UTxO");
        require(oracleStillUnspent(good), "the oracle reading must be referenced, not consumed");

        System.out.println("Verified: the oracle decided the outcome and its reading survived");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    /** The player needs their own ada so the stake they put up is genuinely theirs. */
    private static void fundPlayer() throws Exception {
        Tx fund = new Tx()
                .payToAddress(PLAYER.baseAddress(), Amount.lovelace(BigInteger.valueOf(25_000_000)))
                .from(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(fund)
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();
        require(result.isSuccessful(), "funding the player failed: " + result);
    }

    /** Publishes a price reading. It is only ever read, so no script runs to create it. */
    private static Utxo publishReading(BigInteger price, BigInteger expiry) throws Exception {
        Tx publish = new Tx()
                .payToContract(ORACLE_ADDRESS, Amount.lovelace(BigInteger.valueOf(2_000_000)),
                        reading(price, expiry))
                .from(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(publish)
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();

        require(result.isSuccessful(), "publishing the reading failed: " + result);
        return utxoFrom(ORACLE_ADDRESS, result.getTxHash());
    }

    /** The owner stakes and names the terms: which oracle, what target, by when. */
    private static Utxo openBet(BigInteger deadline) throws Exception {
        Tx open = new Tx()
                .payToContract(BET_ADDRESS, Amount.lovelace(STAKE),
                        betDatum(null, ORACLE.getScriptHash(), deadline))
                .from(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(open)
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();

        require(result.isSuccessful(), "opening the bet failed: " + result);
        return utxoFrom(BET_ADDRESS, result.getTxHash());
    }

    /**
     * The player matches the stake and is recorded in the datum.
     *
     * <p>{@code oracleHash} and {@code pot} are what the rejection cases bend — everything else
     * is identical to a valid join, so a refusal can only be about the thing under test.
     */
    private static TxResult join(Utxo bet, BigInteger deadline, byte[] oracleHash, BigInteger pot)
            throws Exception {
        ScriptTx joinTx = new ScriptTx()
                // Join is constructor 0 of PriceBetRedeemer.
                .collectFrom(bet, ConstrPlutusData.of(0))
                .attachSpendingValidator(BET)
                .payToContract(BET_ADDRESS, List.of(Amount.lovelace(pot)),
                        betDatum(playerKeyHash(), oracleHash, deadline))
                .withChangeAddress(PLAYER.baseAddress());

        return TX_BUILDER.compose(joinTx)
                .feePayer(PLAYER.baseAddress())
                .withSigner(SignerProviders.signerFrom(PLAYER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        PLAYER.baseAddress()))
                .validTo(soon())
                .completeAndWait();
    }

    /** The player claims the pot, citing a reading that clears the target. */
    private static TxResult win(Utxo bet, Utxo reading, BigInteger deadline) throws Exception {
        ScriptTx winTx = new ScriptTx()
                // Win is constructor 1 of PriceBetRedeemer.
                .collectFrom(bet, ConstrPlutusData.of(1))
                .attachSpendingValidator(BET)
                // Referenced, not collected: the reading stays available to every other bet.
                .readFrom(reading)
                .payToAddress(PLAYER.baseAddress(), Amount.lovelace(POT))
                .withChangeAddress(OWNER.baseAddress());

        // The owner pays the fee even though the player is claiming. If the player paid, their
        // payout and their change would be merged into one output and the fee taken out of it,
        // leaving them a few hundred thousand lovelace short of the pot the validator checks.
        return TX_BUILDER.compose(winTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withSigner(SignerProviders.signerFrom(PLAYER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        PLAYER.baseAddress()))
                .validTo(soon())
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /**
     * {@code PriceBetDatum { owner, player, oracleHash, targetRate, deadline, betAmount }}.
     *
     * <p>{@code player} is {@code None} until someone joins.
     */
    private static PlutusData betDatum(byte[] player, byte[] oracleHash, BigInteger deadline) {
        PlutusData maybePlayer = player == null
                ? ConstrPlutusData.of(1)                           // None
                : ConstrPlutusData.of(0, BytesPlutusData.of(player)); // Some

        return ConstrPlutusData.of(0,
                BytesPlutusData.of(ownerKeyHash()),
                maybePlayer,
                BytesPlutusData.of(oracleHash),
                BigIntPlutusData.of(TARGET),
                BigIntPlutusData.of(deadline),
                BigIntPlutusData.of(STAKE));
    }

    /** {@code OracleDatum { GenericData { 0 -> price, 1 -> timestamp, 2 -> expiry } }}. */
    private static PlutusData reading(BigInteger price, BigInteger expiry) throws Exception {
        MapPlutusData priceMap = MapPlutusData.builder().build();
        priceMap.put(BigIntPlutusData.of(0), BigIntPlutusData.of(price));
        priceMap.put(BigIntPlutusData.of(1), BigIntPlutusData.of(chainTimeSeconds() * 1000));
        priceMap.put(BigIntPlutusData.of(2), BigIntPlutusData.of(expiry));

        // GenericData is constructor 2 of PriceData.
        return ConstrPlutusData.of(0, ConstrPlutusData.of(2, priceMap));
    }

    /** A hash no oracle can produce, used to prove the bet refuses to be re-pointed. */
    private static byte[] fakeOracleHash() {
        byte[] hash = new byte[28];
        java.util.Arrays.fill(hash, (byte) 0x5A);
        return hash;
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the bet address. Checking that a UTxO merely disappeared would pass by accident whenever
     * the lookup itself failed.
     */
    private static boolean spendsBet(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> BET_ADDRESS.equals(input.getAddress()));
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    /**
     * A reference input is read, not consumed. If settling had spent the reading, every other
     * bet relying on it would have been invalidated by one player's claim.
     */
    private static boolean oracleStillUnspent(Utxo reading) throws Exception {
        return UTXOS.getAll(ORACLE_ADDRESS).stream()
                .anyMatch(utxo -> utxo.getTxHash().equals(reading.getTxHash())
                        && utxo.getOutputIndex() == reading.getOutputIndex());
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

    /** An upper bound comfortably inside the deadline, which every path here requires. */
    private static long soon() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getSlot() + 600;
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at a
     * script address would pick up leftovers from an earlier run.
     */
    private static Utxo utxoFrom(String address, String txHash) throws Exception {
        return UTXOS.getAll(address).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO created by " + txHash));
    }

    private static byte[] ownerKeyHash() {
        return keyHash(OWNER);
    }

    private static byte[] playerKeyHash() {
        return keyHash(PLAYER);
    }

    private static byte[] keyHash(Account account) {
        return account.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    private static String hex(byte[] bytes) {
        return com.bloxbean.cardano.client.util.HexUtil.encodeHexString(bytes);
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

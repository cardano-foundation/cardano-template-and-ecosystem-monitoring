package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;

import org.cardanofoundation.templates.validator.BetValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.TransactionEvaluator;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultProtocolParamsSupplier;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;
import com.bloxbean.cardano.julc.clientlib.PlutusDataAdapter;
import com.bloxbean.cardano.julc.clientlib.eval.JulcTransactionEvaluator;
import com.bloxbean.cardano.julc.clientlib.eval.SlotConfig;

/**
 * A two-player bet settled by an oracle.
 *
 * <p>One script does both jobs — minting the token that gives the bet its identity, and guarding
 * the UTxO that token travels with. Because a multi-validator's policy id <em>is</em> its script
 * hash, the contract can ask "does this UTxO carry a token minted by the script that owns it?",
 * which is what stops a look-alike output at the same address being passed off as a real bet.
 *
 * <p>The rules that matter most are about conflicts of interest: the referee may be neither
 * player, checked both when the bet is created and when it is joined.
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

    private static final Account PLAYER1 = Account.createFromMnemonic(NETWORK, MNEMONIC);
    private static final Account PLAYER2 = new Account(NETWORK);
    private static final Account ORACLE = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final String TOKEN_NAME = "BET";
    private static final BigInteger STAKE = BigInteger.valueOf(6_000_000);
    private static final BigInteger POT = STAKE.multiply(BigInteger.TWO);

    /**
     * How far the POSIX time a <em>slot</em> maps to runs ahead of the block {@code time} the API
     * reports. The devkit compresses Byron through Alonzo into an instant and starts Babbage at a
     * relative time of 600s, and that offset stays for the life of the chain.
     *
     * <p>Measured from the node's own rejection dump, which prints the datum and the translated
     * validity bound side by side: an expiry of {@code 1786356209000} built from block time
     * against a bound of {@code 1786356724000} on a transaction ending 30 slots out.
     */
    private static final long SLOT_TIME_SKEW_SECONDS =
            Long.parseLong(envOrDefault("CARDANO_SLOT_TIME_SKEW_SECONDS", "600"));

    /**
     * The betting window, in the time base the validator compares against.
     *
     * <p>Near enough the runtime of the whole example, since settlement is what everything waits
     * on. It only has to outlast the transactions that must land before the expiry — four script
     * transactions, ~20s here — plus the lead {@link #soon()} puts on their upper bound.
     *
     * <p>It can be this small only because scripts are costed locally against
     * {@link #devnetSlots()} rather than by ogmios. Ogmios does not apply
     * {@link #SLOT_TIME_SKEW_SECONDS}, so a transaction it happily evaluates can still be refused
     * by the node — and settlement, which it gates, would wait a further 600s for plain block time
     * to catch up. That disagreement, not the contract, is what used to force a 700s window.
     */
    private static final long BETTING_WINDOW_SECONDS = 45;

    /**
     * How long to wait for the chain's clock to pass the expiry before giving up.
     *
     * <p>A bound, not an expectation, and necessarily larger than the window above. Without one
     * a stalled devnet leaves the example sleeping until the CI job is killed, which surfaces as
     * a cancelled job with no explanation instead of a failure that names its cause.
     */
    private static final long MAX_WAIT_SECONDS = 180;

    /**
     * How long to pause between settlement attempts while the window is still open.
     *
     * <p>Also the worst case by which the run overshoots the expiry, since the window closing is
     * only noticed on the next attempt. Evaluating locally makes an attempt cheap enough to poll
     * this often, which is most of why the run finishes close to the window rather than well past
     * it.
     */
    private static final long SETTLE_RETRY_SECONDS = 3;

    private static final PlutusScript BET = JulcScriptLoader.load(BetValidator.class);
    private static final String BET_ADDRESS =
            AddressProvider.getEntAddress(BET, NETWORK).getAddress();

    private static final byte[] EMPTY = new byte[0];

    /** Costs every script this example submits. See {@link #localEvaluator()}. */
    private static final TransactionEvaluator EVALUATOR = localEvaluator();

    public static void main(String[] args) throws Exception {
        // Times come from the chain rather than the local clock, so the example does not assume
        // the devnet's slot-to-time mapping matches this machine.
        long expirySeconds = chainPosixSeconds() + BETTING_WINDOW_SECONDS;
        BigInteger expiration = BigInteger.valueOf(expirySeconds * 1000);

        System.out.println("Bet address: " + BET_ADDRESS);
        System.out.println("Policy id:   " + BET.getPolicyId());
        System.out.println("Player 2:    " + PLAYER2.baseAddress());
        System.out.println("Oracle:      " + ORACLE.baseAddress());
        // Both need a little ada so they can sign; only player 1 ever pays a fee.
        fund(PLAYER2, 30_000_000);
        fund(ORACLE, 10_000_000);
        // 1. A creator who is also the referee could simply declare themselves the winner.
        require(isRejected(() -> create(datum(keyHash(PLAYER1), EMPTY, keyHash(PLAYER1),
                        expiration))),
                "creating a bet where the oracle is player 1 must be rejected");
        System.out.println("Bet with the creator as its own oracle rejected as expected");

        // 2. Open the bet properly.
        Utxo bet = openBet(expiration);
        System.out.println("Bet created in " + bet.getTxHash());

        // 3. Betting against yourself is not a bet.
        require(isRejected(() -> join(bet, keyHash(PLAYER1), PLAYER1, expiration, POT)),
                "player 1 joining their own bet must be rejected");
        System.out.println("Self-join rejected as expected");

        // 4. The pot must be exactly double — a symmetric bet is the whole premise.
        require(isRejected(() -> join(bet, keyHash(PLAYER2), PLAYER2, expiration,
                        POT.subtract(BigInteger.valueOf(1_000_000)))),
                "an under-funded join must be rejected");
        System.out.println("Under-funded join rejected as expected");

        // 5. Player 2 joins.
        TxResult joined = join(bet, keyHash(PLAYER2), PLAYER2, expiration, POT);
        require(joined.isSuccessful(), "joining failed: " + joined);
        Utxo live = utxoFrom(BET_ADDRESS, joined.getTxHash());
        System.out.println("Player 2 joined in " + joined.getTxHash());

        // 6. The oracle cannot call it early. Stated as a precondition rather than assumed: if
        //    the earlier steps had already run past the expiry, a rejection here would prove
        //    nothing, and the case would quietly stop testing anything.
        require(chainPosixSeconds() < expirySeconds,
                "the betting window closed before the early-settlement case could run; "
                        + "raise BETTING_WINDOW_SECONDS");
        require(isRejected(() -> settle(live, PLAYER1)),
                "settling before the expiry must be rejected");
        System.out.println("Early settlement rejected as expected");

        // 7. Wait out the betting window, then settle. Retrying is what makes this independent
        //    of the devnet's slot/time skew: the first attempt that succeeds is, by definition,
        //    the first one the chain considers to be past the expiry.
        TxResult settled = settleWhenWindowCloses(live, expirySeconds);
        System.out.println("Oracle announced player 1 in " + settled.getTxHash());

        require(spendsBet(settled.getTxHash()),
                "the confirmed transaction must spend the bet UTxO");

        System.out.println("Verified: the referee decided it, and only after the window closed");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    private static void fund(Account account, long lovelace) throws Exception {
        Tx fund = new Tx()
                .payToAddress(account.baseAddress(), Amount.lovelace(BigInteger.valueOf(lovelace)))
                .from(PLAYER1.baseAddress());

        TxResult result = TX_BUILDER.compose(fund)
                .withSigner(SignerProviders.signerFrom(PLAYER1))
                .completeAndWait();
        require(result.isSuccessful(), "funding failed: " + result);
    }

    private static Utxo openBet(BigInteger expiration) throws Exception {
        TxResult result = create(datum(keyHash(PLAYER1), EMPTY, keyHash(ORACLE), expiration));
        require(result.isSuccessful(), "creating the bet failed: " + result);
        return utxoFrom(BET_ADDRESS, result.getTxHash());
    }

    /** Mints the bet token and locks player 1's stake with it. */
    private static TxResult create(PlutusData datum) throws Exception {
        Asset token = Asset.builder().name(TOKEN_NAME).value(BigInteger.ONE).build();

        // The mint and the payout are stated separately on purpose. Handing the receiver to
        // mintAsset would send the token with only its minimum ada, and the bet would be opened
        // with a stake nobody chose — which the join rule, checking for exactly double, catches
        // immediately.
        Tx createTx = new Tx()
                .mintAsset(BET, List.of(token), PlutusData.unit())
                .payToContract(BET_ADDRESS,
                        List.of(Amount.lovelace(STAKE),
                                Amount.asset(BET.getPolicyId(), TOKEN_NAME, BigInteger.ONE)),
                        datum)
                .withChangeAddress(PLAYER1.baseAddress());

        return TX_BUILDER.compose(createTx)
                .feePayer(PLAYER1.baseAddress())
                .withSigner(SignerProviders.signerFrom(PLAYER1))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        PLAYER1.baseAddress()))
                .withTxEvaluator(EVALUATOR)
                .validTo(soon())
                .completeAndWait();
    }

    /**
     * The opponent matches the stake, and the bet becomes live.
     *
     * <p>{@code joiner} and {@code pot} are what the rejection cases bend — everything else is
     * identical to a valid join, so a refusal can only be about the thing under test.
     */
    private static TxResult join(Utxo bet, byte[] joiner, Account signer, BigInteger expiration,
            BigInteger pot) throws Exception {
        ScriptTx joinTx = new ScriptTx()
                // Join is constructor 0 of Action.
                .collectFrom(bet, ConstrPlutusData.of(0))
                .attachSpendingValidator(BET)
                .payToContract(BET_ADDRESS,
                        List.of(Amount.lovelace(pot),
                                Amount.asset(BET.getPolicyId(), TOKEN_NAME, BigInteger.ONE)),
                        datum(keyHash(PLAYER1), joiner, keyHash(ORACLE), expiration))
                .withChangeAddress(PLAYER2.baseAddress());

        return TX_BUILDER.compose(joinTx)
                .feePayer(PLAYER2.baseAddress())
                .withSigner(SignerProviders.signerFrom(PLAYER2))
                .withSigner(SignerProviders.signerFrom(signer))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        signer.baseAddress()))
                .withTxEvaluator(EVALUATOR)
                .validTo(soon())
                .completeAndWait();
    }

    /**
     * The oracle names the winner and the pot is paid out.
     *
     * <p>The validator insists on exactly one output carrying no datum, so this transaction
     * deliberately has no explicit payment: everything, including the bet token, flows to the
     * winner as the single change output. A second output would be somewhere for a slice of the
     * pot to be diverted to.
     */
    private static TxResult settle(Utxo bet, Account winner) throws Exception {
        ScriptTx settleTx = new ScriptTx()
                // AnnounceWinner is constructor 1 of Action.
                .collectFrom(bet, ConstrPlutusData.of(1,
                        BytesPlutusData.of(keyHash(winner))))
                .attachSpendingValidator(BET)
                // An explicit output is required, not just a change address: with nothing to
                // pay, cardano-client-lib never fills in the transaction body and so cannot
                // resolve this input's redeemer index — it fails to *build*, which looks like a
                // validator rejection but proves nothing.
                .payToAddress(winner.baseAddress(),
                        List.of(Amount.lovelace(STAKE),
                                Amount.asset(BET.getPolicyId(), TOKEN_NAME, BigInteger.ONE)))
                .withChangeAddress(winner.baseAddress());

        return TX_BUILDER.compose(settleTx)
                .feePayer(winner.baseAddress())
                // The payout and the change both go to the winner; merging them is what leaves
                // the single output the validator insists on.
                .mergeOutputs(true)
                .withSigner(SignerProviders.signerFrom(winner))
                .withSigner(SignerProviders.signerFrom(ORACLE))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        ORACLE.baseAddress()))
                .withTxEvaluator(EVALUATOR)
                .validFrom(currentSlot())
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code BetDatum { player1, player2, oracle, expiration }}; empty player2 = still open. */
    private static PlutusData datum(byte[] player1, byte[] player2, byte[] oracle,
            BigInteger expiration) {
        return PlutusDataAdapter.convert(new BetValidator.BetDatum(player1, player2, oracle, expiration));
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
            String detail = causeChain(rejected);

            // A negative case is only evidence if the script actually ran and refused. QuickTx
            // wraps *any* failure during cost evaluation — a missing VM provider, an unreachable
            // backend, a malformed transaction — in a TxBuildException whose own message reads
            // only "Error while evaluating script cost", so the reason has to come from the
            // cause. Treating that wrapper as a rejection is not hypothetical: a misconfigured
            // classpath once reported "No JulcVmProvider found" as the validator saying no.
            require(isScriptFailure(detail),
                    "expected the validator to refuse this transaction, but it failed for another "
                            + "reason: " + detail);
            return true;
        }
    }

    /** Flattens the exception chain; the useful detail is in the cause, not the top message. */
    private static String causeChain(Throwable thrown) {
        StringBuilder chain = new StringBuilder();
        for (Throwable t = thrown; t != null && t != t.getCause(); t = t.getCause()) {
            if (chain.length() > 0) {
                chain.append(" <- ");
            }
            chain.append(t.getClass().getSimpleName()).append(": ").append(t.getMessage());
        }
        return chain.toString();
    }

    /**
     * Evidence that phase-2 evaluation ran and the script said no.
     *
     * <p>Each of these names a specific script that refused — the local evaluator's, ogmios's,
     * and the node's phrasings. Deliberately not "Failed to compute script cost", which is what
     * cardano-client-lib says whenever evaluation could not be completed <em>at all</em>.
     */
    private static boolean isScriptFailure(String detail) {
        return detail.contains("Script evaluation failed")
                || detail.contains("EvaluationFailure")
                || detail.contains("ValidationTagMismatch")
                || detail.contains("PlutusFailure");
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    /**
     * Waits for the betting window to close, then settles.
     *
     * <p>Simply retries: costing a script in this process is cheap enough that attempting the
     * settlement is itself the clock check, and a refusal is the answer rather than a cost.
     */
    private static TxResult settleWhenWindowCloses(Utxo bet, long expirySeconds) throws Exception {
        System.out.println("Waiting for the betting window to close…");

        long giveUpAt = System.currentTimeMillis() + MAX_WAIT_SECONDS * 1000;

        // Retrying rather than computing when to stop: the expiry is compared against a bound the
        // ledger derives from a slot, not against any clock this side can read directly. The first
        // attempt that succeeds is, by definition, the first one the chain considers to be past it.
        while (System.currentTimeMillis() < giveUpAt) {
            try {
                TxResult result = settle(bet, PLAYER1);
                if (result.isSuccessful()) {
                    return result;
                }
            } catch (Exception stillInsideTheWindow) {
                // Expected until the expiry has passed; the validator is doing its job.
            }
            Thread.sleep(SETTLE_RETRY_SECONDS * 1000);
        }
        throw new IllegalStateException("the betting window had not closed after "
                + MAX_WAIT_SECONDS + "s (chain time " + chainTimeSeconds()
                + ", expiry " + expirySeconds + ")");
    }

    /**
     * Now, in the base the contract is written against: block time carried into slot time.
     *
     * <p>The expiry in the datum and every validity bound the validator reads live here, so the
     * example works in it throughout rather than converting at each use and getting one wrong.
     */
    private static long chainPosixSeconds() throws Exception {
        return chainTimeSeconds() + SLOT_TIME_SKEW_SECONDS;
    }

    private static long chainTimeSeconds() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getTime();
    }

    private static long currentSlot() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getSlot();
    }

    /**
     * The devnet's slot-to-POSIX mapping, read off the chain rather than assumed.
     *
     * <p>Slots advance one per second in step with block time — measured, 45 slots per 45s — so a
     * single sample fixes the whole mapping: the slot and time of any block give the epoch that
     * slot zero sits at, and {@link #SLOT_TIME_SKEW_SECONDS} carries it into the base the node
     * validates in. Derived per run because a devnet gets a fresh start time every time it is
     * recreated, which a hardcoded constant would silently outlive.
     */
    private static SlotConfig devnetSlots() {
        try {
            var block = BACKEND.getBlockService().getLatestBlock().getValue();
            long slotZeroPosixMs =
                    (block.getTime() - block.getSlot() + SLOT_TIME_SKEW_SECONDS) * 1000L;
            return new SlotConfig(0, slotZeroPosixMs, 1000);
        } catch (Exception e) {
            throw new IllegalStateException("could not read the devnet's slot mapping from "
                    + BACKEND_URL, e);
        }
    }

    /**
     * Costs scripts in this process instead of asking ogmios.
     *
     * <p>Not an optimisation but a correctness fix. Ogmios translates slots without the devkit's
     * era offset, so it disagrees with the node about when a deadline falls: it will pass a
     * transaction the node then refuses with {@code ValidationTagMismatch}, and it holds up
     * settlement until plain block time reaches an expiry the node already considers past.
     * Evaluating against {@link #devnetSlots()} puts the check on the same clock as the node.
     */
    private static TransactionEvaluator localEvaluator() {
        return new JulcTransactionEvaluator(UTXOS,
                new DefaultProtocolParamsSupplier(BACKEND.getEpochService()),
                scriptHash -> java.util.Optional.empty(),
                devnetSlots());
    }

    /**
     * An upper bound comfortably inside the betting window.
     *
     * <p>Every second of this lead is a second the window has to be longer than the work it
     * covers, so it is kept just wide enough to survive the few blocks between building a
     * transaction and it being accepted.
     */
    private static long soon() throws Exception {
        return currentSlot() + 15;
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at the
     * bet address would pick up bets left by an earlier run.
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

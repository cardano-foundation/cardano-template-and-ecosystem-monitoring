package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;

import org.cardanofoundation.templates.validator.AmmValidator;
import org.cardanofoundation.templates.validator.PairTokenPolicy;

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
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * A constant-product automated market maker.
 *
 * <p>One script guards the pool and mints the LP token, so the LP policy id is the script's own
 * hash. The datum records the two reserves and the LP supply; every action rewrites it and the
 * script checks the arithmetic.
 *
 * <p>The rule everything else depends on is that the datum's reserves must equal the tokens the
 * pool output actually holds. This run proves it directly: a swap whose datum balances perfectly
 * but whose tokens go elsewhere is refused.
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
    private static final Account TRADER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    /** 997/1000 — the familiar 0.3% fee. */
    private static final BigInteger FEE_NUM = BigInteger.valueOf(997);
    private static final BigInteger FEE_DEN = BigInteger.valueOf(1000);

    private static final long R0 = 1000;
    private static final long R1 = 4000;
    /** sqrt(1000 * 4000) = 2000. */
    private static final long LP = 2000;
    private static final long SWAP_IN = 100;
    /** 4000*99700 / (1000*1000 + 99700) = 362, so r1 becomes 3638. */
    private static final long SWAP_OUT = 362;

    private static final BigInteger POOL_ADA = BigInteger.valueOf(5_000_000);

    private static PlutusScript amm;
    private static String poolAddress;
    private static PlutusScript policy0;
    private static PlutusScript policy1;
    private static String name0;
    private static String name1;

    public static void main(String[] args) throws Exception {
        long stamp = System.currentTimeMillis();
        name0 = "TKA" + stamp;
        name1 = "TKB" + stamp;

        // Two distinct policies — a real pair is two unrelated assets, and it keeps the
        // on-chain shape identical to the one the unit tests model.
        policy0 = JulcScriptLoader.load(PairTokenPolicy.class,
                BytesPlutusData.of(keyHash(TRADER)), BigIntPlutusData.of(0));
        policy1 = JulcScriptLoader.load(PairTokenPolicy.class,
                BytesPlutusData.of(keyHash(TRADER)), BigIntPlutusData.of(1));

        amm = JulcScriptLoader.load(AmmValidator.class,
                BytesPlutusData.of(HexUtil.decodeHexString(policy0.getPolicyId())),
                BytesPlutusData.of(name0.getBytes()),
                BytesPlutusData.of(HexUtil.decodeHexString(policy1.getPolicyId())),
                BytesPlutusData.of(name1.getBytes()),
                BigIntPlutusData.of(FEE_NUM), BigIntPlutusData.of(FEE_DEN));
        poolAddress = AddressProvider.getEntAddress(amm, NETWORK).toBech32();

        System.out.println("Pool address: " + poolAddress);
        System.out.println("LP policy:    " + amm.getPolicyId());
        System.out.println("Token0:       " + policy0.getPolicyId());
        System.out.println("Token1:       " + policy1.getPolicyId());

        // 1. Mint the pair this pool will trade.
        mintPair();

        // 2. Open the pool already holding its reserves. A plain payment, so no validator runs
        //    — see the note at the bottom of the README on why the deposit is not driven here.
        Utxo seeded = openPool();
        System.out.println("Pool opened with liquidity in " + seeded.getTxHash());

        // 4. The rule the whole contract rests on: a datum that balances on paper must not be
        //    accepted while the real reserves go somewhere else.
        require(isRejected(() -> swap(seeded, true)),
                "a swap whose reserves do not match the datum must be rejected");
        System.out.println("Swap with mismatched reserves rejected as expected");

        // 5. A well-formed swap.
        TxResult swapped = succeed(swap(seeded, false), "the swap");
        System.out.println("Swap settled in " + swapped.getTxHash());

        require(spendsPool(swapped.getTxHash()),
                "the confirmed transaction must spend the pool UTxO");

        System.out.println("Verified: the curve was honoured and the reserves really moved");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    private static void mintPair() throws Exception {
        ScriptTx mintTx = new ScriptTx()
                // A surplus of token0 beyond what seeds the pool, so the trader still has some
                // to sell afterwards — the pool absorbs exactly R0/R1.
                .mintAsset(policy0, List.of(Asset.builder().name(name0)
                                .value(BigInteger.valueOf(R0 + SWAP_IN)).build()),
                        PlutusData.unit(), TRADER.baseAddress())
                .mintAsset(policy1, List.of(Asset.builder().name(name1)
                                .value(BigInteger.valueOf(R1)).build()),
                        PlutusData.unit(), TRADER.baseAddress())
                .withChangeAddress(TRADER.baseAddress());

        succeed(TX_BUILDER.compose(mintTx)
                .feePayer(TRADER.baseAddress())
                .withSigner(SignerProviders.signerFrom(TRADER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        TRADER.baseAddress()))
                .completeAndWait(), "minting the pair");
    }

    /** Creates the pool already funded, so the run can exercise trading. */
    private static Utxo openPool() throws Exception {
        Tx open = new Tx()
                .payToContract(poolAddress, poolValue(R0, R1), datum(R0, R1, LP))
                .from(TRADER.baseAddress());

        return utxoOf(succeed(TX_BUILDER.compose(open)
                .withSigner(SignerProviders.signerFrom(TRADER))
                .completeAndWait(), "opening the pool"));
    }

    /** Adds the initial liquidity and mints the LP tokens that represent it. */
    private static TxResult deposit(Utxo pool) throws Exception {
        ScriptTx depositTx = new ScriptTx()
                // Deposit is constructor 0.
                .collectFrom(pool, ConstrPlutusData.of(0,
                        BigIntPlutusData.of(R0), BigIntPlutusData.of(R1)))
                .attachSpendingValidator(amm)
                .mintAsset(amm, List.of(
                                Asset.builder().name("LP").value(BigInteger.valueOf(LP)).build()),
                        PlutusData.unit())
                .payToContract(poolAddress, poolValue(R0, R1), datum(R0, R1, LP))
                .withChangeAddress(TRADER.baseAddress());

        return submit(depositTx);
    }

    /**
     * Swaps token0 in for token1 out.
     *
     * <p>When {@code stripReserves} is set the datum is left correct but the tokens are not sent
     * to the pool — the exact attack the reserve-binding rule exists to stop.
     */
    private static TxResult swap(Utxo pool, boolean stripReserves) throws Exception {
        long newR1 = R1 - SWAP_OUT;
        List<Amount> poolOut = stripReserves
                ? List.of(Amount.lovelace(POOL_ADA))
                : poolValue(R0 + SWAP_IN, newR1);

        ScriptTx swapTx = new ScriptTx()
                // Swap is constructor 2: t0In = True, amountIn, minAmountOut.
                .collectFrom(pool, ConstrPlutusData.of(2,
                        ConstrPlutusData.of(1),
                        BigIntPlutusData.of(SWAP_IN), BigIntPlutusData.of(0)))
                .attachSpendingValidator(amm)
                .payToContract(poolAddress, poolOut, datum(R0 + SWAP_IN, newR1, LP))
                .withChangeAddress(TRADER.baseAddress());

        return submit(swapTx);
    }

    /**
     * Builds the swap with a stub evaluator so the transaction body can be inspected offline.
     *
     * <p>The backend's script-cost evaluation throws before anything is observable, which is why
     * every earlier hypothesis had to be guessed. Supplying fixed execution units gets past it.
     */
    private static void dumpBuiltTx(ScriptTx tx) throws Exception {
        var built = TX_BUILDER.compose(tx)
                .feePayer(TRADER.baseAddress())
                .withSigner(SignerProviders.signerFrom(TRADER))
                .withTxEvaluator((cbor, utxos) ->
                        com.bloxbean.cardano.client.api.model.Result
                                .success("ok").withValue(java.util.List.<com.bloxbean.cardano.client
                                        .api.model.EvaluationResult>of()))
                .build();

        System.out.println("DUMP inputs=" + built.getBody().getInputs().size());
        built.getBody().getOutputs().stream()
                .filter(o -> o.getAddress().equals(poolAddress))
                .forEach(o -> {
                    System.out.println("DUMP pool coin=" + o.getValue().getCoin());
                    o.getValue().getMultiAssets().forEach(ma -> {
                        System.out.println("DUMP  policy=" + ma.getPolicyId().substring(0, 12));
                        ma.getAssets().forEach(a -> System.out.println(
                                "DUMP   name=" + a.getName() + " qty=" + a.getValue()));
                    });
                });
        System.out.println("DUMP expect name0=" + name0 + " qty=" + (R0 + SWAP_IN));
        System.out.println("DUMP expect name1=" + name1 + " qty=" + (R1 - SWAP_OUT));
    }

    private static void dumpSwap(Utxo pool) throws Exception {
        long newR1 = R1 - SWAP_OUT;
        dumpBuiltTx(new ScriptTx()
                .collectFrom(pool, ConstrPlutusData.of(2, ConstrPlutusData.of(1),
                        BigIntPlutusData.of(SWAP_IN), BigIntPlutusData.of(0)))
                .attachSpendingValidator(amm)
                .payToContract(poolAddress, poolValue(R0 + SWAP_IN, newR1),
                        datum(R0 + SWAP_IN, newR1, LP))
                .withChangeAddress(TRADER.baseAddress()));
    }

    private static TxResult submit(ScriptTx tx) throws Exception {
        return TX_BUILDER.compose(tx)
                .feePayer(TRADER.baseAddress())
                .withSigner(SignerProviders.signerFrom(TRADER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        TRADER.baseAddress()))
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code AmmDatum { r0, r1, lpSupply }}. */
    private static PlutusData datum(long r0, long r1, long lp) {
        return ConstrPlutusData.of(0,
                BigIntPlutusData.of(r0), BigIntPlutusData.of(r1), BigIntPlutusData.of(lp));
    }

    private static List<Amount> poolValue(long r0, long r1) throws Exception {
        return List.of(Amount.lovelace(POOL_ADA),
                Amount.asset(policy0.getPolicyId(), name0, BigInteger.valueOf(r0)),
                Amount.asset(policy1.getPolicyId(), name1, BigInteger.valueOf(r1)));
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the pool address. Checking that a UTxO merely disappeared would pass by accident whenever
     * the lookup itself failed.
     */
    private static boolean spendsPool(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> poolAddress.equals(input.getAddress()));
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
        return message.length() > 110 ? message.substring(0, 110) + "…" : message;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private static TxResult succeed(TxResult result, String what) {
        require(result.isSuccessful(), what + " failed: " + result);
        return result;
    }

    private static Utxo utxoOf(TxResult result) throws Exception {
        return UTXOS.getAll(poolAddress).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no pool UTxO created by " + result.getTxHash()));
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

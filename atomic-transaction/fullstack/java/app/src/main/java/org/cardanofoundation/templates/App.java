package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.Optional;

import org.cardanofoundation.templates.validator.AtomicTransactionValidator;

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
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;
import com.bloxbean.cardano.julc.clientlib.PlutusDataAdapter;

/**
 * Atomic transactions on Cardano.
 *
 * <p>A Cardano transaction runs every script it touches before any of its effects apply.
 * This example puts two scripts in one transaction — a spending validator that always
 * succeeds and a minting policy that demands a password — and shows that a failing mint
 * also cancels the spend. Nothing partial is ever recorded.
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

    private static final String ASSET_NAME = "AtomicToken";
    private static final Network NETWORK = Networks.testnet();
    private static final Account ACCOUNT = Account.createFromMnemonic(NETWORK, MNEMONIC);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    /** Loads the Plutus script julc produced from {@link AtomicTransactionValidator}. */
    private static final PlutusScript SCRIPT = JulcScriptLoader.load(AtomicTransactionValidator.class);
    private static final String SCRIPT_ADDRESS =
            AddressProvider.getEntAddress(SCRIPT, NETWORK).getAddress();

    public static void main(String[] args) throws Exception {
        System.out.println("Script address: " + SCRIPT_ADDRESS);

        // 1. Lock funds, giving the spend entrypoint something to unlock.
        Utxo locked = lockFunds();
        System.out.println("Locked 10 ADA at " + locked.getTxHash() + "#" + locked.getOutputIndex());

        // 2. Spend it and mint with the WRONG password, in one transaction.
        require(isRejected(locked, "wrong_password"), "the wrong password should have been rejected");

        // The spend would have passed on its own, yet nothing happened: the UTxO is untouched.
        // That is the atomicity guarantee, observed rather than asserted.
        require(isUnspent(locked), "a rejected transaction must leave the locked UTxO in place");
        System.out.println("Rejected as expected, and the locked UTxO is untouched");

        // 3. The same transaction with the correct password.
        String txHash = submitAtomicTx(locked, AtomicTransactionValidator.REQUIRED_PASSWORD);
        System.out.println("Atomic spend + mint confirmed in " + txHash);

        // 4. Prove the spending validator really ran, rather than trusting the tx status.
        require(spendsScriptAddress(txHash), "confirmed tx must consume an input at the script address");
        System.out.println("Verified: the transaction consumed the script UTxO and minted " + ASSET_NAME);
    }

    /** Pays 10 ADA to the script address and returns the UTxO that payment created. */
    private static Utxo lockFunds() throws Exception {
        Tx lockTx = new Tx()
                .payToAddress(SCRIPT_ADDRESS, Amount.ada(10))
                .from(ACCOUNT.baseAddress());

        TxResult result = TX_BUILDER.compose(lockTx)
                .feePayer(ACCOUNT.baseAddress())
                .withSigner(SignerProviders.signerFrom(ACCOUNT))
                .completeAndWait();
        require(result.isSuccessful(), "funding the script address failed: " + result);

        // Match on this transaction's hash. A devnet is long-lived, so simply taking the
        // first UTxO at the script address can pick up leftovers from an earlier run.
        return UTXOS.getAll(SCRIPT_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no script UTxO created by " + result.getTxHash()));
    }

    /** Spends the locked UTxO and mints one asset, both governed by the same script. */
    private static String submitAtomicTx(Utxo locked, String password) throws Exception {
        PlutusData redeemer =
                PlutusDataAdapter.convert(new AtomicTransactionValidator.Redeemer(password));

        ScriptTx atomicTx = new ScriptTx()
                .collectFrom(locked, PlutusData.unit())
                .attachSpendingValidator(SCRIPT)
                .payToAddress(ACCOUNT.baseAddress(), Amount.ada(10))
                .mintAsset(SCRIPT,
                        Asset.builder().name(ASSET_NAME).value(BigInteger.ONE).build(),
                        redeemer,
                        ACCOUNT.baseAddress());

        TxResult result = TX_BUILDER.compose(atomicTx)
                .feePayer(ACCOUNT.baseAddress())
                .withSigner(SignerProviders.signerFrom(ACCOUNT))
                .completeAndWait();
        require(result.isSuccessful(), "atomic transaction was not accepted: " + result);
        return result.getTxHash();
    }

    /**
     * Attempts the atomic transaction and reports whether the chain refused it.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a failing
     * mint policy surfaces while the client is still building — as an exception rather
     * than a failed result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Utxo locked, String password) {
        try {
            submitAtomicTx(locked, password);
            return false;
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
    }

    private static boolean isUnspent(Utxo utxo) {
        return UTXOS.getAll(SCRIPT_ADDRESS).stream()
                .anyMatch(candidate -> candidate.getTxHash().equals(utxo.getTxHash())
                        && candidate.getOutputIndex() == utxo.getOutputIndex());
    }

    /**
     * Fail-closed proof that the spending validator ran: the confirmed transaction must
     * list an input at the script address. Checking that the UTxO merely disappeared would
     * pass by accident whenever the lookup itself fails.
     *
     * <p>Polls, because a node confirms a transaction slightly before the indexer serves it.
     */
    private static boolean spendsScriptAddress(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            Optional<Boolean> spent = readInputs(txHash);
            if (spent.isPresent()) {
                return spent.get();
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    /** Empty while the transaction is not yet indexed. */
    private static Optional<Boolean> readInputs(String txHash) {
        try {
            var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
            if (!response.isSuccessful()) {
                return Optional.empty();
            }
            return Optional.of(response.getValue().getInputs().stream()
                    .anyMatch(input -> SCRIPT_ADDRESS.equals(input.getAddress())));
        } catch (Exception notIndexedYet) {
            return Optional.empty();
        }
    }

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

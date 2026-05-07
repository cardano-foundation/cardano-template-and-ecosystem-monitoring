/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+
//RUNTIME_OPTIONS --enable-preview

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import com.bloxbean.cardano.aiken.AikenScriptUtil;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.exception.ApiException;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.bip39.Sha256Hash;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintUtil;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusContractBlueprint;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusVersion;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

public class Htlc {

        // Backend service to connect to Cardano node. Here we are using Blockfrost as
        // an example.
        static BackendService backendService = new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        // Dummy mnemonic for the example. Replace with a valid mnemonic.
        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

        static String secret = "Secret Answer"; // The secret answer to be used in the HTLC

        // The network used for this example is Testnet
        static Network network = Networks.testnet();

        static Account payee1 = Account.createFromMnemonic(network, mnemonic);

        static Address ownerAddress = payee1.getBaseAddress();
        // In this example we are using the same address, but in a real scenario, you
        // might have a different address for the receiver.
        static Address receiverAddress = payee1.getBaseAddress();
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        // Expiration must be set *before* getParametrisedPlutusScript runs, since
        // the script address depends on it. The buffer must be larger than the
        // wall-clock time spent in lockFunds + waitForScriptUtxo + GUESS prep,
        // because the script-context validity range reflects actual chain time,
        // not the time when expiration was computed. In a healthy yaci-devkit,
        // lockFunds confirms in seconds; if completeAndWait() blocks for minutes,
        // restart yaci-devkit — its indexer has fallen behind the chain head.
        static long expirationMs = Instant.now().plusSeconds(30).toEpochMilli();

        static PlutusScript plutusScript = getParametrisedPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        static final long startMs = System.currentTimeMillis();

        public static void main(String[] args) throws ApiException, InterruptedException {

                // Happy path 1: GUESS with correct secret (before expiration)
                lockFunds(20);
                waitForScriptUtxo(60);
                TxResult guessTx = unlockScript(Optional.of(secret), 5);
                printResult("GUESS", guessTx);

                // Happy path 2: WITHDRAW by owner (after expiration)
                lockFunds(10);
                waitForScriptUtxo(60);
                waitUntilExpired();
                TxResult withdrawTx = unlockScript(Optional.empty(), 5);
                printResult("WITHDRAW", withdrawTx);

                if (!guessTx.isSuccessful() || !withdrawTx.isSuccessful())
                        throw new AssertionError("HTLC CCL test failed");
        }

        private static void printResult(String label, TxResult r) {
                System.out.println(label + " result: successful=" + r.isSuccessful()
                                + " txHash=" + r.getTxHash()
                                + " response=" + r.getResponse());
        }

        // Sleep until wall clock has passed expiration with a small margin.
        // If lockFunds was slow, expiration may already be in the past — no wait needed.
        private static void waitUntilExpired() throws InterruptedException {
                long target = expirationMs + 30_000L;
                long now = System.currentTimeMillis();
                if (now >= target) {
                        System.out.println("Expiration already passed — proceeding to WITHDRAW.");
                        return;
                }
                long waitMs = target - now;
                System.out.println("Waiting " + (waitMs / 1000) + "s for expiration to pass before WITHDRAW...");
                Thread.sleep(waitMs);
        }

        // Poll until at least one UTXO appears at the script address (yaci-store indexer
        // can lag a few seconds behind chain confirmation).
        private static void waitForScriptUtxo(int timeoutSec) throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        List<Utxo> utxos = utxoSupplier.getAll(scriptAddress.getAddress());
                        if (!utxos.isEmpty()) {
                                System.out.println("Script UTXO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                System.out.println("Timed out waiting for script UTXO after " + timeoutSec + "s");
        }

        /**
         * Unlock script funds. If a secret is provided, takes the GUESS path
         * (Constr 0 [answer]); otherwise takes the WITHDRAW path (Constr 1 []).
         */
        private static TxResult unlockScript(Optional<String> secretGuess, int adaAmount) throws ApiException {

                // Getting all utxos from the script address
                List<Utxo> allScriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                System.out.println("Current slot: " + slot);
                // Use ConstrPlutusData.of(alternative, fields...) factory, which
                // explicitly produces Constr-tagged CBOR (tag 121 for alt=0, tag 122
                // for alt=1, etc.). The builder pattern was producing bytes-only output
                // in CCL 0.8.0-pre4 — the script-context dump showed redeemer as just
                // <bytes>, not Constr 0 [<bytes>], so the validator couldn't pattern-
                // match `redeemer: Htlc { GUESS { answer } | WITHDRAW }`.
                ConstrPlutusData redeemer = secretGuess
                                .map(s -> ConstrPlutusData.of(0L, BytesPlutusData.of(s.getBytes())))  // GUESS { answer }
                                .orElseGet(() -> ConstrPlutusData.of(1L));                            // WITHDRAW

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(allScriptUtxos,
                                                redeemer)
                                .payToAddress(receiverAddress.getAddress(), Amount.ada(
                                                adaAmount))
                                .attachSpendingValidator(plutusScript)
                                .withChangeAddress(ownerAddress.getAddress());
                // Narrow validity range to give more headroom: validity_upper = slot+5,
                // not slot+10. With expiration buffer 30s and lockFunds confirmation
                // ~10s, this gives valid_before ~15s of margin instead of ~10s.
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 5)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
        }

        /**
         * Locks funds to the HTLC contract address.
         *
         * @param adaMount The amount of Ada to lock.
         */
        private static void lockFunds(int adaMount) {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                Tx tx = new Tx().payToContract(scriptAddress.getAddress(), Amount.ada(adaMount), PlutusData.unit())
                                .withChangeAddress(ownerAddress.getAddress())
                                .from(ownerAddress.getAddress());
                // complete() submits the tx without waiting for many confirmations.
                // completeAndWait() can block for ~10 min on yaci-devkit waiting for
                // "finality"; we only need the UTXO to be spendable, which is what
                // waitForScriptUtxo() detects (first appearance in the indexer).
                TxResult txResult = quickTxBuilder.compose(tx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .complete();
                System.out.println("Funds lock submitted. TxHash: %s".formatted(txResult.getTxHash()));
        }

        /**
         * Retrieves the parametrized Plutus script for the HTLC contract.
         *
         * @return The Plutus script with the parameters applied.
         */
        private static PlutusScript getParametrisedPlutusScript() {
                Path plutusJson = Paths.get(System.getProperty("user.dir"),
                                "..", "..", "onchain", "aiken", "plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String htlcCompiledCode = blueprint.getValidators().getFirst().getCompiledCode();

                byte[] hashedAnswer = Sha256Hash.hash(secret.getBytes());
                System.out.println("Expiration time (epoch ms): " + expirationMs);

                String compiledCode = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(
                                                BytesPlutusData.of(hashedAnswer),
                                                BigIntPlutusData.of(expirationMs),
                                                BytesPlutusData.of(ownerAddress.getPaymentCredentialHash().get())),
                                htlcCompiledCode);

                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }
}

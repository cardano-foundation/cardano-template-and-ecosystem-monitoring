/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+
//COMPILE_OPTIONS --enable-preview -source 24
//RUNTIME_OPTIONS --enable-preview

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.io.File;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
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
        static PlutusScript plutusScript = getParametrisedPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                // Happy path 1: GUESS with correct secret
                lockFunds(20);
                waitForScriptUtxo(60);
                TxResult success = unlockFundsWithSecret(Optional.of(secret), 5);
                System.out.println("Funds unlocked successfully. TxHash: %s".formatted(success.getTxHash()));

                // Happy path 2: WITHDRAW after expiration
                lockFunds(10);
                waitForScriptUtxo(60);
                System.out.println("Waiting for 70 seconds for expiration before owner withdrawal...");
                Thread.sleep(70000);
                TxResult unlockFunds = unlockFundsWithSecret(Optional.empty(), 5);
                System.out.println("Funds unlocked successfully without secret. TxHash: %s"
                                .formatted(unlockFunds.getTxHash()));

                if (!success.isSuccessful() || !unlockFunds.isSuccessful())
                        throw new AssertionError("HTLC CCL test failed");
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
         * Unlocks the funds from the HTLC contract using the provided secret guess.
         *
         * @param secretGuess The secret guess to unlock the funds. If empty, it will
         *                    unlock as the owner without providing the secret.
         * @param adaAmount   The amount of Ada to unlock.
         * @return The transaction result.
         * @throws ApiException If there is an error during the transaction.
         */
        private static TxResult unlockFundsWithSecret(Optional<String> secretGuess, int adaAmount) throws ApiException {

                // Getting all utxos from the script address
                List<Utxo> allScriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                System.out.println("Current slot: " + slot);
                ConstrPlutusData redeemer = secretGuess.map(secret -> ConstrPlutusData.builder()
                                .alternative(0)
                                .data(ListPlutusData.of(BytesPlutusData.of(secret.getBytes())))
                                .build()).orElse(
                                                ConstrPlutusData.builder()
                                                                .alternative(1)
                                                                .data(ListPlutusData.of())
                                                                .build());

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(allScriptUtxos,
                                                redeemer)
                                .payToAddress(receiverAddress.getAddress(), Amount.ada(
                                                adaAmount))
                                .attachSpendingValidator(plutusScript)
                                .withChangeAddress(ownerAddress.getAddress());
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 10)
                                .validTo(slot + 10) // Set a validity range
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
                // Locking 10 Ada to the contract address
                Tx tx = new Tx().payToContract(scriptAddress.getAddress(), Amount.ada(adaMount), PlutusData.unit())
                                .withChangeAddress(ownerAddress.getAddress())
                                .from(ownerAddress.getAddress());
                TxResult txResult = quickTxBuilder.compose(tx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .completeAndWait();
                System.out.println("Funds locked. TxHash: %s".formatted(txResult.getTxHash()));
        }

        /**
         * Retrieves the parametrized Plutus script for the HTLC contract.
         *
         * @return The Plutus script with the parameters applied.
         */
        private static PlutusScript getParametrisedPlutusScript() {
                PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File("../../onchain/aiken/plutus.json"));
                String simpleTransferCompiledCode = plutusContractBlueprint.getValidators().getFirst()
                                .getCompiledCode();

                byte[] hashedAnswer = Sha256Hash.hash(secret.getBytes()); // Hash the secret answer
                long expiration;
                try {
                        long blockTime = backendService.getBlockService().getLatestBlock().getValue().getTime();
                        expiration = (blockTime + 60) * 1000L;
                } catch (ApiException e) {
                        expiration = LocalDateTime.now().plusMinutes(1).toEpochSecond(ZoneOffset.UTC) * 1000;
                }
                System.out.println("Expiration time (epoch ms): " + expiration);
                // Apply parameters to the validator compiled code to get the compiled code
                String compiledCode = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(
                                                BytesPlutusData.of(hashedAnswer),
                                                BigIntPlutusData.of(expiration),
                                                BytesPlutusData.of(ownerAddress.getPaymentCredentialHash().get())),
                                simpleTransferCompiledCode);

                PlutusScript plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode,
                                PlutusVersion.v3);
                return plutusScript;
        }
}

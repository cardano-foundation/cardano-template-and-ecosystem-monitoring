///usr/bin/env jbang "$0" "$@" ; exit $?
/// 
// @formatter:off
//JAVA 24+

//DEPS com.bloxbean.cardano:cardano-client-lib:0.7.0-beta2
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.7.0-beta2
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.math.BigInteger;
import java.nio.file.Path;
import java.nio.file.Paths;

import java.util.List;

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
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintUtil;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusContractBlueprint;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusVersion;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

public class AtomicTransaction {

        // Backend service to connect to Cardano node. Here we are using Blockfrost as
        // an example.
        static BackendService backendService = new BFBackendService("http://localhost:8081/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        // Dummy mnemonic for the example. Replace with a valid mnemonic.
        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

        static String secret = "Secret Answer"; // The secret answer to be used in the HTLC

        // The network used for this example is Testnet
        static Network network = Networks.testnet();

        static Account account = Account.createFromMnemonic(network, mnemonic);

        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);
        static PlutusScript plutusScript = getPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {

                // Fund the script address first
                Tx tx = new Tx()
                                .payToAddress(scriptAddress.getAddress(), Amount.ada(10))
                                .from(account.baseAddress());
                TxResult scriptTopUp = quickTxBuilder.compose(tx)
                                .withSigner(SignerProviders.signerFrom(account))
                                .feePayer(account.baseAddress())
                                .completeAndWait();
                System.out.println("Script Address Funded in Tx: " + scriptTopUp);

                UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());
                List<Utxo> utxos = utxoSupplier.getAll(scriptAddress.getAddress());
                Utxo utxoToUnlock = utxos.getFirst();
                // Now try to unlock the script UTXO and mint a demo token with the wrong password
                // Since transactions in cardano are atomic eventhough the spend is always true
                // the transaction will fail since the wrong password is provided
                ScriptTx scriptTxWrongPassword = new ScriptTx()
                                .collectFrom(utxoToUnlock, PlutusData.unit())
                                .payToAddress(account.baseAddress(), Amount.ada(10))
                                .mintAsset(plutusScript,
                                                Asset.builder().name("TestAsset").value(BigInteger.ONE).build(),
                                                ConstrPlutusData.builder().alternative(0)
                                                                .data(ListPlutusData.of(BytesPlutusData
                                                                                .of("wrong_password")))
                                                                .build(),
                                                account.baseAddress())
                                .attachSpendingValidator(plutusScript);
                TxResult txWrongPassword = quickTxBuilder.compose(scriptTxWrongPassword)
                                .withSigner(SignerProviders.signerFrom(account))
                                .feePayer(account.baseAddress())
                                .completeAndWait();
                System.out.println("Transaction with wrong password failed as expected: " + txWrongPassword.isSuccessful());

                // // Now try to unlock the script UTXO and mint a demo token with the correct password
                // Since both verifications will pass, the transaction will be successful
                ScriptTx scriptTxCorrectPassword = new ScriptTx()
                                .collectFrom(utxoToUnlock, PlutusData.unit())
                                .payToAddress(account.baseAddress(), Amount.ada(10))
                                .mintAsset(plutusScript,
                                                Asset.builder().name("TestAsset").value(BigInteger.ONE).build(),
                                                ConstrPlutusData.builder().alternative(0)
                                                                .data(ListPlutusData.of(BytesPlutusData
                                                                                .of("super_secret_password")))
                                                                .build(),
                                                account.baseAddress())
                                .attachSpendingValidator(plutusScript);
                TxResult txCorrectPassword = quickTxBuilder.compose(scriptTxCorrectPassword)
                                .withSigner(SignerProviders.signerFrom(account))
                                .feePayer(account.baseAddress())
                                .completeAndWait();
                System.out.println("Transaction with correct password success: " + txCorrectPassword.isSuccessful());
        }

        private static PlutusScript getPlutusScript() {
                String workingDir = System.getProperty("user.dir");
                Path plutusJsonPath = Paths.get(workingDir, "..", "onchain", "aiken", "plutus.json");

                PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader
                                .loadBlueprint(plutusJsonPath.toFile());
                String simpleTransferCompiledCode = plutusContractBlueprint.getValidators().getFirst()
                                .getCompiledCode();

                PlutusScript plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(
                                simpleTransferCompiledCode,
                                PlutusVersion.v3);
                return plutusScript;
        }
}
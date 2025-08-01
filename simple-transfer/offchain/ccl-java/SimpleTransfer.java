/// usr/bin/env jbang "$0" "$@" ; exit $?

//JAVA 24+
//COMPILE_OPTIONS --enable-preview -source 24
//RUNTIME_OPTIONS --enable-preview

//DEPS com.bloxbean.cardano:cardano-client-lib:0.7.0-beta2
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.7.0-beta2
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0

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
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintUtil;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusContractBlueprint;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusVersion;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

import java.io.File;
import java.util.List;

public class SimpleTransfer {

        // Backend service to connect to Cardano node. Here we are using Blockfrost as
        // an example.
        static BackendService backendService = new BFBackendService("http://localhost:8081/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        // Dummy mnemonic for the example. Replace with a valid mnemonic.
        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

        // The network used for this example is Testnet
        static Network network = Networks.testnet();

        static Account payee1 = new Account(network, mnemonic);

        static Address ownerAddress = payee1.getBaseAddress();
        // In this example we are using the same address, but in a real scenario, you
        // might have a different address for the receiver.
        static Address receiverAddress = payee1.getBaseAddress();

        public static void main(String[] args) throws ApiException {
                PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File("../../onchain/aiken/plutus.json"));
                String simpleTransferCompiledCode = plutusContractBlueprint.getValidators().getFirst()
                                .getCompiledCode();

                // Apply parameters to the validator compiled code to get the compiled code
                String compiledCode = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(BytesPlutusData.of(receiverAddress.getPaymentCredentialHash().get())),
                                simpleTransferCompiledCode);

                PlutusScript plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode,
                                PlutusVersion.v3);
                Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

                QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

                // Locking 10 Ada to the contract address
                Tx tx = new Tx().payToAddress(scriptAddress.getAddress(), Amount.ada(10))
                                .withChangeAddress(ownerAddress.getAddress())
                                .from(ownerAddress.getAddress());
                TxResult txResult = quickTxBuilder.compose(tx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .completeAndWait();
                System.out.println("Funds locked. TxHash:");
                System.out.println(txResult.getTxHash());

                // Getting all utxos from the script address
                List<Utxo> allScriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
                // Paying 5 Ada to the receiver address and leaving the remaining amount as
                // change in the script
                ScriptTx scriptTx1 = new ScriptTx()
                                .collectFrom(allScriptUtxos, PlutusData.unit())
                                .payToAddress(receiverAddress.getAddress(), Amount.ada(5))
                                .attachSpendingValidator(plutusScript)
                                .withChangeAddress(scriptAddress.getAddress());
                TxResult txResult1 = quickTxBuilder.compose(scriptTx1)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
                System.out.println("Funds withdrawn. TxHash:");
                System.out.println(txResult1.getTxHash());
        }
}
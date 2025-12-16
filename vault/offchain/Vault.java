/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+
//COMPILE_OPTIONS --enable-preview -source 24
//RUNTIME_OPTIONS --enable-preview

//DEPS com.bloxbean.cardano:cardano-client-lib:0.7.0-beta2
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.7.0-beta2
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.io.File;
import java.math.BigInteger;
import java.util.List;

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
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder.TxContext;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

public class Vault {

    // Backend service to connect to Cardano node. Here we are using Blockfrost as
    // an example.
    static BackendService backendService = new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
    static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

    // Dummy mnemonic for the example. Replace with a valid mnemonic.
    static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

    // The network used for this example is Testnet
    static Network network = Networks.testnet();

    static Account owner = Account.createFromMnemonic(network, mnemonic);


    static Address ownerAddress = owner.getBaseAddress();
    // In this example we are using the same address, but in a real scenario, you
    // might have a different address for the receiver.
    static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);
    static PlutusScript plutusScript = getParametrisedPlutusScript();
    static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

    public static void main(String[] args) throws InterruptedException, ApiException {
        System.out.println("Owner Address: " + ownerAddress.getAddress());
        System.out.println("Script Address: " + scriptAddress.getAddress());

        // First pay some money to the vault
        Tx payToVaultTx = new Tx()
                .payToAddress(scriptAddress.getAddress(), Amount.ada(10))
                .from(ownerAddress.getAddress());
        TxResult payToVaultTxResult = quickTxBuilder.compose(payToVaultTx)
                .withSigner(SignerProviders.signerFrom(owner))
                .feePayer(ownerAddress.getAddress())
                .completeAndWait();
        System.out.println("Pay to vault tx: " + payToVaultTxResult.getTxHash());

        List<Utxo> allScriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
        allScriptUtxos = allScriptUtxos.stream().filter(utxo -> utxo.getInlineDatum() == null).toList();
        System.out.println("Script Utxos without datum: " + allScriptUtxos);
        long lockTime = System.currentTimeMillis() - 1000;
        ScriptTx withDrawRequestTx = new ScriptTx()
                .collectFrom(allScriptUtxos.getFirst(), ConstrPlutusData.builder().alternative(0).data(ListPlutusData.of()).build()) // 0 = Request to withdraw
                .payToContract(scriptAddress.getAddress(), Amount.ada(10), ConstrPlutusData.builder()
                        .alternative(0)
                        .data(ListPlutusData.of(BigIntPlutusData.of(lockTime)))
                        .build())
                .attachSpendingValidator(plutusScript)
                .withChangeAddress(scriptAddress.getAddress());
        long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
       TxResult withdrawRequestResult = quickTxBuilder.compose(withDrawRequestTx)
                .withRequiredSigners(ownerAddress)
                .withSigner(SignerProviders.signerFrom(owner))
                .feePayer(ownerAddress.getAddress())
                .validFrom(slot)
                .validTo(slot + 100)
                .completeAndWait();
        System.out.println("Withdraw request tx: " + withdrawRequestResult.getTxHash());

        // Wait for some time (more than the lock time set in the datum)
        System.out.println("Waiting for 15 seconds before finalizing the withdraw...");
        Thread.sleep(15 * 1000);
        allScriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
        allScriptUtxos = allScriptUtxos.stream().filter(utxo -> utxo.getInlineDatum() != null).toList();
        System.out.println("Script Utxos with datum: " + allScriptUtxos);
        ScriptTx finalizeWithDrawTx = new ScriptTx()
                .collectFrom(allScriptUtxos.getFirst(),
                                        ConstrPlutusData.builder().alternative(1)
                                                        .data(ListPlutusData.of())
                                                        .build()) // 1 = Finalize withdraw
                .payToAddress(ownerAddress.getAddress(), Amount.ada(10))
                .attachSpendingValidator(plutusScript)
                .withChangeAddress(scriptAddress.getAddress());
        slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
        TxResult finalizeWithdrawResult = quickTxBuilder.compose(finalizeWithDrawTx)
                .withRequiredSigners(ownerAddress)
                .withSigner(SignerProviders.signerFrom(owner))
                .feePayer(ownerAddress.getAddress())
                .validFrom(slot)
                .validTo(slot + 100)
                .completeAndWait();
        System.out.println("Finalize withdraw tx: " + finalizeWithdrawResult.getTxHash());

        if (!finalizeWithdrawResult.isSucessful())
            throw new AssertionError("Withdrawal failed : " + finalizeWithdrawResult);

    }

    private static PlutusScript getParametrisedPlutusScript() {
        PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader
                .loadBlueprint(new File("vault/onchain/aiken/plutus.json"));
        String simpleTransferCompiledCode = plutusContractBlueprint.getValidators().getFirst()
                .getCompiledCode();

        long expiration = System.currentTimeMillis();// + 10 * 1000; // Set expiration time to 10 seconds from now
        System.out.println("Expiration time (epoch seconds): " + expiration);
        // Apply parameters to the validator compiled code to get the compiled code
        String compiledCode = AikenScriptUtil.applyParamToScript(
                ListPlutusData.of(
                        BytesPlutusData.of(owner.getBaseAddress().getPaymentCredentialHash().get()),
                        BigIntPlutusData.of(10000) // milliseconds to wait after allowing to finalize the withdraw from the vault - 10 seconds
                ), simpleTransferCompiledCode);

        PlutusScript plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode,
                PlutusVersion.v3);
        return plutusScript;
    }
}

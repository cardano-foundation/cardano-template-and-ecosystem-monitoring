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
import com.bloxbean.cardano.client.api.exception.ApiException;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.ScriptUtxoFinders;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintUtil;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusVersion;
import com.bloxbean.cardano.client.plutus.spec.*;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.util.JsonUtil;

import java.io.File;

static BackendService backendService = new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

static Account payee1 = new Account(Networks.testnet(), mnemonic);

static Address payee1Addr = payee1.getBaseAddress();

static Address payee2Addr = new Account(Networks.testnet()).getBaseAddress();
static Address payee3Addr = new Account(Networks.testnet()).getBaseAddress();
static Address payee4Addr = new Account(Networks.testnet()).getBaseAddress();
static Address payee5Addr = new Account(Networks.testnet()).getBaseAddress();

static double lockAdaAmt = 10;

static PlutusScript plutusScript;
static String scriptAddress;

static void init() {
    var plutusContractBlueprint = PlutusBlueprintLoader.loadBlueprint(new File("../../onchain/aiken/plutus.json"));
    String paymentSplitterValidatorCompiledCode = plutusContractBlueprint.getValidators().get(0).getCompiledCode();

    //Apply parameters to the validator compiled code to get the final compiled code
    String compiledCode = AikenScriptUtil.applyParamToScript(ListPlutusData.of(
            ListPlutusData.of(
                    BytesPlutusData.of(payee1Addr.getPaymentCredentialHash().get()),
                    BytesPlutusData.of(payee2Addr.getPaymentCredentialHash().get()),
                    BytesPlutusData.of(payee3Addr.getPaymentCredentialHash().get()),
                    BytesPlutusData.of(payee4Addr.getPaymentCredentialHash().get()),
                    BytesPlutusData.of(payee5Addr.getPaymentCredentialHash().get())
            )
    ), paymentSplitterValidatorCompiledCode);

    plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);

    //Get script address
    scriptAddress = AddressProvider.getEntAddress(plutusScript, Networks.testnet()).toBech32();
    System.out.println("Script Address: " + scriptAddress);
}

static void lock() {
    PlutusData ownerDatum = ConstrPlutusData.of(0, BytesPlutusData.of(payee1.getBaseAddress().getPaymentCredentialHash().get()));

    Tx tx = new Tx()
            .payToContract(scriptAddress, Amount.ada(10), ownerDatum)
            .from(payee1.baseAddress());

    QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);
    var result = quickTxBuilder.compose(tx)
            .withSigner(SignerProviders.signerFrom(payee1))
            .completeAndWait(System.out::println);

    if (result.isSuccessful())
        System.out.println("Success: " + result.getValue());
    else
        System.out.println("Failed: " + result);
}

static void unlock() throws ApiException {
    PlutusData ownerDatum = ConstrPlutusData.of(0, BytesPlutusData.of(payee1.getBaseAddress().getPaymentCredentialHash().get()));

    var scriptUtxo = ScriptUtxoFinders.findFirstByInlineDatum(new DefaultUtxoSupplier(backendService.getUtxoService()), scriptAddress, ownerDatum)
            .orElseThrow(() -> new ApiException("Script Utxo not found"));

    var redeemer = ConstrPlutusData.of(0, BytesPlutusData.of("Payday"));

    var splitAmount = lockAdaAmt / 5;

    ScriptTx scriptTx = new ScriptTx()
            .collectFrom(scriptUtxo, redeemer)
            .payToAddress(payee1Addr.toBech32(), Amount.ada(splitAmount))
            .payToAddress(payee2Addr.toBech32(), Amount.ada(splitAmount))
            .payToAddress(payee3Addr.toBech32(), Amount.ada(splitAmount))
            .payToAddress(payee4Addr.toBech32(), Amount.ada(splitAmount))
            .payToAddress(payee5Addr.toBech32(), Amount.ada(splitAmount))
            .attachSpendingValidator(plutusScript);

    //A dummy tx which pays from payee1 to payee1. This is to make sure the outputs from ScriptTx are not touched
    //to deduct fee.
    Tx tx = new Tx()
            .payToAddress(payee1Addr.toBech32(), Amount.ada(2))
            .from(payee1Addr.toBech32());

    QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);
    var result = quickTxBuilder.compose(scriptTx, tx)
            .feePayer(payee1Addr.toBech32())
            .withSigner(SignerProviders.signerFrom(payee1))
            .withRequiredSigners(payee1Addr)
            .completeAndWait(System.out::println);

    if (result.isSuccessful())
        System.out.println("Success: " + result.getValue());
    else
        System.out.println("Failed: " + result);
}

//Main method
void main(String[] args) throws ApiException {
    init();

    System.out.println("Locking funds to the script address");
    lock();

    System.out.println("Unlocking funds from the script address");
    unlock();

}

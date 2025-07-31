package org.cardanofoundation;

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
import com.bloxbean.cardano.client.function.helper.ScriptUtxoFinders;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusContractBlueprint;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.TxResult;

import java.io.File;

public class Main {

    // Backend service to connect to Cardano node. Here we are using Blockfrost as an example.
    static BackendService backendService = new BFBackendService("http://localhost:8081/api/v1/", "Dummy Key");
    static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

    // Dummy mnemonic for the example. Replace with a valid mnemonic.
    static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

    // The network used for this example is Testnet
    static Network network = Networks.testnet();

    static Account payee1 = new Account(network, mnemonic);

    static Address ownerAddress = payee1.getBaseAddress();
    // In this example we are using the same address, but in a real scenario, you might have a different address for the receiver.
    static Address receiverAddress = payee1.getBaseAddress();

    public static void main(String[] args) throws ApiException {
        PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader.loadBlueprint(new File("../../onchain/aiken/plutus.json"));
        PlutusScript plutusScript = plutusContractBlueprint.getPlutusScript("simple_transfer.simpleTransfer.spend");
        Address address = AddressProvider.getEntAddress(plutusScript, network);
        QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        // Paying 10 Ada to the contract address attaching the paymentCredentialHash as datum.
        ScriptTx scriptTx = new ScriptTx()
                .payToContract(address.getAddress(),
                        Amount.ada(10),
                        ConstrPlutusData.builder().data(ListPlutusData.of(BytesPlutusData.of(receiverAddress.getPaymentCredentialHash().get()))).build())
                .withChangeAddress(ownerAddress.getAddress());
        TxResult txResult = quickTxBuilder.compose(scriptTx)
                .feePayer(ownerAddress.getAddress())
                .withSigner(SignerProviders.signerFrom(payee1))
                .completeAndWait();
        System.out.println("Funds locked. TxHash:");
        System.out.println(txResult.getTxHash());

        // Getting the Utxo from the contract address which can be spent by the payee1 address.
        Utxo scriptUtxo = ScriptUtxoFinders.findFirstByInlineDatum(utxoSupplier, address.getAddress(),
                ConstrPlutusData.builder()
                        .data(ListPlutusData.of(BytesPlutusData.of(receiverAddress.getPaymentCredentialHash().get())))
                        .build()).orElseThrow();

        // Collecting the utxo and paying it to payee1 address.
        ScriptTx scriptTx1 = new ScriptTx()
                .collectFrom(scriptUtxo, PlutusData.unit())
                .payToAddress(ownerAddress.getAddress(), scriptUtxo.getAmount())
                .attachSpendingValidator(plutusScript);
        TxResult txResult1 = quickTxBuilder.compose(scriptTx1)
                .feePayer(ownerAddress.getAddress())
                .withSigner(SignerProviders.signerFrom(payee1))
                .withRequiredSigners(ownerAddress)
                .completeAndWait();
        System.out.println("Funds withdrawn. TxHash:");
        System.out.println(txResult1.getTxHash());
    }
}
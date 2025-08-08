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
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.plutus.util.Bytes;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.util.HexUtil;

public class Crowdfund {

    // Backend service to connect to Cardano node. Here we are using Blockfrost as
    // an example.
    static BackendService backendService = new BFBackendService("http://localhost:8081/api/v1/", "Dummy Key");
    static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

    // Dummy mnemonic for the example. Replace with a valid mnemonic.
    static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

    // The network used for this example is Testnet
    static Network network = Networks.testnet();

    static Account initiator = Account.createFromMnemonic(network, mnemonic);
    static Account donater = initiator; // In this example, we are using the same account for the donater.
    static Account beneficiar = initiator; // In this example, we are using the same account for the beneficiar.

    static Address ownerAddress = initiator.getBaseAddress();
    // In this example we are using the same address, but in a real scenario, you
    // might have a different address for the receiver.
    static Address receiverAddress = initiator.getBaseAddress();
    static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);
    static PlutusScript plutusScript = getParametrisedPlutusScript();
    static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

    static int crowdFundGoal = 10_000_000; // 10 ADA in lovelace

    public static void main(String[] args) throws InterruptedException, ApiException {
        MapPlutusData donorsMap = MapPlutusData.builder()
                .build();
        donorsMap.put(BytesPlutusData.of(initiator.getBaseAddress().getPaymentCredentialHash().get()),
                BigIntPlutusData.of(5_000_000L)); // 5 ADA
        Tx tx = new Tx()
                .payToContract(scriptAddress.getAddress(), Amount.ada(5),
                        ConstrPlutusData.of(0,
                                donorsMap))
                .from(initiator.baseAddress())
                .withChangeAddress(initiator.baseAddress());
        TxResult initTx = quickTxBuilder.compose(tx)
                .feePayer(initiator.baseAddress())
                .withSigner(SignerProviders.signerFrom(initiator))
                .completeAndWait();
        System.out.println("Crowdfund initialized. Tx Hash: " + initTx.getTxHash());

        // Reclaiming the funds after the crowdfund the deadline is exceeded and the
        // goal is not reached
        // Thread.sleep(5000); // Sleep for 5 seconds to simulate some delay
        // TxResult reclaimResult = getReclaimTxResult(initiator, 5);
        // System.out.println("Reclaim Tx Hash: " + reclaimResult.getTxHash());
        // System.out.print(reclaimResult);

        TxResult donateTxResult = getDonateTxResult(donater, 5, donorsMap);
        System.out.println("Donation made. Tx Hash: " + donateTxResult.getTxHash());

        // Now we can claim the funds by providing the secret answer
        TxResult claimTxResult = getClaimTxResult(beneficiar, 10);
        System.out.println("Funds claimed by beneficiar. Tx Hash: " +
                claimTxResult.getTxHash());
    }

    private static TxResult getReclaimTxResult(Account initiator, int adaAmount)
            throws ApiException {
        long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
        List<Utxo> scriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
        System.out.println("Script UTXOs: " + scriptUtxos);
        ScriptTx reclaimTx = new ScriptTx()
                .collectFrom(scriptUtxos.getFirst(), ConstrPlutusData.builder()
                        .alternative(2)
                        .data(ListPlutusData.of())
                        .build())
                .attachSpendingValidator(plutusScript)
                .payToAddress(initiator.baseAddress(), Amount.ada(adaAmount))
                .withChangeAddress(scriptAddress.getAddress());
        TxResult reclaimTxResult = quickTxBuilder.compose(reclaimTx)
                .feePayer(initiator.baseAddress())
                .validFrom(slot)
                .validTo(slot + 10) // Set a valid to slot for the transaction
                .withRequiredSigners(initiator.getBaseAddress())
                .withSigner(SignerProviders.signerFrom(initiator))
                .completeAndWait();
        return reclaimTxResult;
    }

    private static TxResult getDonateTxResult(Account account, int adaMount, MapPlutusData donorsMap)
            throws ApiException {
        BytesPlutusData paymentCredentialHashBytes = BytesPlutusData
                .of(account.getBaseAddress().getPaymentCredentialHash().get());

        if (donorsMap.getMap().containsKey(paymentCredentialHashBytes)) {
            donorsMap.getMap().replace(paymentCredentialHashBytes,
                    BigIntPlutusData.of(((BigIntPlutusData) donorsMap.getMap().get(paymentCredentialHashBytes))
                            .getValue().intValue() + adaMount * 1_000_000L));
        } else {
            donorsMap.getMap().put(paymentCredentialHashBytes, BigIntPlutusData.of(adaMount * 1_000_000L));
        }

        // Now we can make a donation to the crowdfund
        List<Utxo> scriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
        long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
        ScriptTx donateTx = new ScriptTx()
                .collectFrom(scriptUtxos.getFirst(), ConstrPlutusData.builder()
                        .alternative(0)
                        .data(ListPlutusData.of())
                        .build())
                .attachSpendingValidator(plutusScript)
                .payToContract(scriptAddress.getAddress(), Amount.ada(10),
                        ConstrPlutusData.of(0,
                                donorsMap))
                .withChangeAddress(donater.baseAddress());
        TxResult donateTxResult = quickTxBuilder.compose(donateTx)
                .feePayer(donater.baseAddress())
                .validFrom(slot)
                .validTo(slot + 10) // Set a valid to slot for the transaction
                .withRequiredSigners(donater.getBaseAddress())
                .withSigner(SignerProviders.signerFrom(donater)).completeAndWait();
        return donateTxResult;
    }

    private static TxResult getClaimTxResult(Account beneficiar, int adaAmount)
            throws InterruptedException, ApiException {
        Thread.sleep(20000); // Sleep for 25 seconds to simulate some delay
        List<Utxo> scriptUtxos2 = utxoSupplier.getAll(scriptAddress.getAddress());
        long slot2 = backendService.getBlockService().getLatestBlock().getValue().getSlot();
        ScriptTx claimTx = new ScriptTx()
                .collectFrom(scriptUtxos2.getFirst(), ConstrPlutusData.builder()
                        .alternative(1)
                        .data(ListPlutusData.of())
                        .build())
                .attachSpendingValidator(plutusScript)
                .payToAddress(beneficiar.baseAddress(), Amount.ada(
                        adaAmount), plutusScript)
                .withChangeAddress(beneficiar.getBaseAddress().getAddress());
        TxResult claimTxResult = quickTxBuilder.compose(claimTx)
                .validFrom(slot2 - 10)
                .validTo(slot2 + 20) // Set a valid to slot for the transaction
                .feePayer(beneficiar.baseAddress())
                .withRequiredSigners(beneficiar.getBaseAddress())
                .withSigner(SignerProviders.signerFrom(beneficiar))
                .completeAndWait();

        return claimTxResult;
    }

    private static PlutusScript getParametrisedPlutusScript() {
        PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader
                .loadBlueprint(new File("crowdfund/onchain/aiken/plutus.json"));
        String simpleTransferCompiledCode = plutusContractBlueprint.getValidators().getFirst()
                .getCompiledCode();

        long expiration = System.currentTimeMillis();// + 10 * 1000; // Set expiration time to 10 seconds from now
        System.out.println("Expiration time (epoch seconds): " + expiration);
        // Apply parameters to the validator compiled code to get the compiled code
        String compiledCode = AikenScriptUtil.applyParamToScript(
                ListPlutusData.of(
                        BytesPlutusData.of(beneficiar.getBaseAddress().getPaymentCredentialHash().get()),
                        BigIntPlutusData.of(crowdFundGoal),
                        BigIntPlutusData.of(expiration)),
                simpleTransferCompiledCode);

        PlutusScript plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode,
                PlutusVersion.v3);
        return plutusScript;
    }
}

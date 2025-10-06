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
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.exception.CborSerializationException;
import com.bloxbean.cardano.client.function.helper.ScriptUtxoFinders;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintUtil;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusContractBlueprint;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusVersion;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.plutus.spec.PlutusV3Script;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;

public class TokenTransfer {
        private static final String ASSET_NAME = "TestAsset";
        // Backend service to connect to Cardano node. Here we are using Blockfrost as
        // an example.
        static BackendService backendService = new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());
        // Dummy mnemonic for the example. Replace with a valid mnemonic.
        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);
        // The network used for this example is Testnet
        static Network network = Networks.testnet();

        static Account payee1 = Account.createFromMnemonic(network, mnemonic);
        static PlutusV3Script alwaysTrueScript = PlutusV3Script.builder()
                        .type("PlutusScriptV3")
                        .cborHex("46450101002499")
                        .build();

        public static void main(String[] args) throws CborSerializationException {
                System.out.println("Token Transfer Example");

                // Apply parameters to the validator compiled code to get the compiled code
                PlutusScript plutusScript = createParametrizedContract();
                Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);
                System.out.println("Script Address: " + scriptAddress.getAddress());

                TxResult mintTokens = mintTokens(scriptAddress);
                System.out.println("Minted Asset. TxHash: " + mintTokens.getTxHash());

                // Unlocking the tokens from the script address and sending them to the payee1
                List<Utxo> mintUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
                Utxo mintUtxo = mintUtxos.get(0);
                String unit = alwaysTrueScript.getPolicyId() + "" + HexUtil.encodeHexString(ASSET_NAME.getBytes());
                ScriptTx tx = new ScriptTx()
                                .collectFrom(mintUtxo, PlutusData.unit())
                                .payToAddress(payee1.getBaseAddress().getAddress(),
                                                mintUtxo.getAmount().stream().filter(a -> a.getUnit().equals(unit))
                                                                .toList())
                                .attachSpendingValidator(plutusScript)
                                .withChangeAddress(payee1.baseAddress());
                TxResult completeAndWait = quickTxBuilder.compose(tx)
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(payee1.getBaseAddress())
                                .feePayer(payee1.baseAddress())
                                .completeAndWait();
                System.out.println("TxHash: " + completeAndWait.getTxHash());
                System.out.println("Transferred Asset to " + payee1.getBaseAddress().getAddress());

                // Verify transactions succeeded
                if (!mintTokens.isSuccessful() || !completeAndWait.isSuccessful())
                        throw new AssertionError("TokenTransfer CCL test failed");
        }

        /**
         * First we need to mint an asset using a Plutus script. We are using an
         * always-succeeds Plutus script and sending them directly to our script.
         *
         * @param scriptAddress The address of the script where the asset will be
         *                      minted.
         * @return TxResult containing the transaction result.
         */
        private static TxResult mintTokens(Address scriptAddress) {
                ScriptTx mintTx = new ScriptTx()
                                .mintAsset(alwaysTrueScript, new Asset(ASSET_NAME, BigInteger.valueOf(10)),
                                                PlutusData.unit(), scriptAddress.getAddress())

                                .withChangeAddress(payee1.baseAddress());
                TxResult mintTokens = quickTxBuilder.compose(mintTx)
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(payee1.getBaseAddress())
                                .mergeOutputs(true)
                                .feePayer(payee1.baseAddress())
                                .completeAndWait();
                return mintTokens;
        }

        /**
         * Create a parametrized contract by applying parameters to the compiled code
         * of the Plutus script. This is used to create a contract that can handle
         * the transfer of assets.
         *
         * @return PlutusScript containing the compiled code of the parametrized
         *         contract.
         * @throws CborSerializationException
         */
        private static PlutusScript createParametrizedContract() throws CborSerializationException {
                PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File("../../onchain/aiken/plutus.json"));
                String simpleTransferCompiledCode = plutusContractBlueprint.getValidators().getFirst()
                                .getCompiledCode();

                String compiledCode = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(
                                                BytesPlutusData.of(payee1.getBaseAddress().getPaymentCredentialHash()
                                                                .get()),
                                                BytesPlutusData.of(alwaysTrueScript.getScriptHash()),
                                                BytesPlutusData.of(ASSET_NAME)),
                                simpleTransferCompiledCode);
                PlutusScript plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode,
                                PlutusVersion.v3);
                return plutusScript;
        }
}

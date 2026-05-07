/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+
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
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;

public class TokenTransfer {
        private static final String ASSET_NAME = "TestAsset";
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

                // Step 1: Mint tokens to payee1's wallet (wallet outputs don't require a datum)
                TxResult mintResult = mintTokens();
                System.out.println("Minted Asset. TxHash: " + mintResult.getTxHash());

                // Step 2: Lock the minted tokens to the script address with a datum
                // Plutus V3 script outputs require an inline datum — use payToContract
                String unit = alwaysTrueScript.getPolicyId() + HexUtil.encodeHexString(ASSET_NAME.getBytes());
                List<Utxo> walletUtxos = utxoSupplier.getAll(payee1.baseAddress());
                Utxo mintedUtxo = walletUtxos.stream()
                                .filter(u -> u.getAmount().stream().anyMatch(a -> a.getUnit().equals(unit)))
                                .findFirst()
                                .orElseThrow(() -> new RuntimeException("Minted token not found in wallet"));
                List<Amount> tokenAmounts = mintedUtxo.getAmount().stream()
                                .filter(a -> a.getUnit().equals(unit))
                                .toList();

                Tx lockTx = new Tx()
                                .payToContract(scriptAddress.getAddress(), tokenAmounts, PlutusData.unit())
                                .withChangeAddress(payee1.baseAddress())
                                .from(payee1.baseAddress());
                TxResult lockResult = quickTxBuilder.compose(lockTx)
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .feePayer(payee1.baseAddress())
                                .completeAndWait();
                System.out.println("Locked tokens to script. TxHash: " + lockResult.getTxHash());

                // Step 3: Unlock the tokens from the script address and send to payee1
                List<Utxo> scriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
                Utxo scriptUtxo = scriptUtxos.get(0);
                ScriptTx unlockTx = new ScriptTx()
                                .collectFrom(scriptUtxo, PlutusData.unit())
                                .payToAddress(payee1.getBaseAddress().getAddress(),
                                                scriptUtxo.getAmount().stream()
                                                                .filter(a -> a.getUnit().equals(unit))
                                                                .toList())
                                .attachSpendingValidator(plutusScript)
                                .withChangeAddress(payee1.baseAddress());
                TxResult unlockResult = quickTxBuilder.compose(unlockTx)
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(payee1.getBaseAddress())
                                .feePayer(payee1.baseAddress())
                                .completeAndWait();
                System.out.println("TxHash: " + unlockResult.getTxHash());
                System.out.println("Transferred Asset to " + payee1.getBaseAddress().getAddress());

                // Verify all transactions succeeded
                if (!mintResult.isSuccessful() || !lockResult.isSuccessful() || !unlockResult.isSuccessful())
                        throw new AssertionError("TokenTransfer CCL test failed");
        }

        /**
         * Mints 10 TestAsset tokens to payee1's wallet using the always-succeeds
         * Plutus script as the minting policy.
         */
        private static TxResult mintTokens() {
                ScriptTx mintTx = new ScriptTx()
                                .mintAsset(alwaysTrueScript, new Asset(ASSET_NAME, BigInteger.valueOf(10)),
                                                PlutusData.unit(), payee1.baseAddress())
                                .withChangeAddress(payee1.baseAddress());
                return quickTxBuilder.compose(mintTx)
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(payee1.getBaseAddress())
                                .mergeOutputs(true)
                                .feePayer(payee1.baseAddress())
                                .completeAndWait();
        }

        /**
         * Create a parametrized contract by applying parameters to the compiled code
         * of the Plutus script.
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

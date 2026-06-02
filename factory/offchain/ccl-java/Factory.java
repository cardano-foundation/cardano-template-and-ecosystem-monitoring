/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.io.File;
import java.math.BigInteger;
import java.util.ArrayList;
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
import com.bloxbean.cardano.client.exception.CborSerializationException;
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
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;

/**
 * Factory pattern with three chained validators: factory_marker (mint),
 * factory (spend), product (mint+spend). Parameters chain so that
 * marker_policy = factory_marker(owner_pkh, seed_outref), the factory address
 * depends on marker_policy, and each product depends on factory + product_id.
 * Exercises createFactory and createProduct.
 *
 * OutputReference encodes as ConstrPlutusData.of(0, txHashBytes, idx) — the
 * Aiken record gets the Constr-0 tag.
 */
public class Factory {

        private static final String FACTORY_MARKER_NAME = "FACTORY_MARKER";
        private static final String PRODUCT_ID = "P-1";
        private static final String PRODUCT_TAG = "demo-tag";

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        static Account owner = Account.createFromMnemonic(network, mnemonic);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        public static void main(String[] args) throws ApiException, InterruptedException {
                byte[] ownerPkh = owner.getBaseAddress().getPaymentCredentialHash().get();

                List<Utxo> walletUtxos = utxoSupplier.getAll(owner.baseAddress());
                if (walletUtxos.isEmpty()) throw new AssertionError("No wallet UTxOs");
                Utxo seedUtxo = walletUtxos.getFirst();

                PlutusScript markerScript = applyParams(getValidator("factory_marker."),
                                List.of(BytesPlutusData.of(ownerPkh),
                                                outputReference(seedUtxo)));
                String markerPolicyId = policyId(markerScript);

                PlutusScript factoryScript = applyParams(getValidator("factory."),
                                List.of(BytesPlutusData.of(ownerPkh),
                                                BytesPlutusData.of(HexUtil.decodeHexString(markerPolicyId))));
                Address factoryAddr = AddressProvider.getEntAddress(factoryScript, network);

                System.out.println("Factory address: " + factoryAddr.getAddress());
                System.out.println("Marker policy:   " + markerPolicyId);

                TxResult initRes = createFactory(seedUtxo, markerScript, markerPolicyId, factoryAddr);
                System.out.println("CREATE_FACTORY result: successful=" + initRes.isSuccessful()
                                + " txHash=" + initRes.getTxHash());
                if (!initRes.isSuccessful())
                        throw new AssertionError("Factory CREATE failed: " + initRes.getResponse());
                waitForScriptUtxoTx(factoryAddr, initRes.getTxHash(), 60);

                TxResult prodRes = createProduct(ownerPkh, markerPolicyId, factoryScript, factoryAddr,
                                initRes.getTxHash());
                System.out.println("CREATE_PRODUCT result: successful=" + prodRes.isSuccessful()
                                + " txHash=" + prodRes.getTxHash());
                if (!prodRes.isSuccessful())
                        throw new AssertionError("Factory PRODUCT failed: " + prodRes.getResponse());
        }

        private static TxResult createFactory(Utxo seedUtxo, PlutusScript markerScript,
                        String markerPolicyId, Address factoryAddr) throws ApiException {
                String tokenNameHex = HexUtil.encodeHexString(FACTORY_MARKER_NAME.getBytes());

                PlutusData initialDatum = ConstrPlutusData.of(0, ListPlutusData.of());
                PlutusData mintRedeemer = ConstrPlutusData.of(0);
                Asset asset = new Asset(FACTORY_MARKER_NAME, BigInteger.ONE);

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(seedUtxo)
                                .mintAsset(markerPolicyId, List.of(asset), mintRedeemer,
                                                factoryAddr.getAddress(), initialDatum)
                                .attachMintValidator(markerScript);

                // withSigner attaches a signing key. withRequiredSigners records the pkh
                // in required_signers so it appears inside the script context — the
                // marker validator's must_be_signed_by check needs the latter.
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(owner.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult createProduct(byte[] ownerPkh, String markerPolicyId,
                        PlutusScript factoryScript, Address factoryAddr, String prevTxHash)
                        throws ApiException {
                Utxo factoryUtxo = findScriptUtxoByTx(factoryAddr, prevTxHash);
                if (factoryUtxo == null)
                        throw new AssertionError("Factory UTxO not indexed");

                PlutusScript productScript = applyParams(getValidator("product"),
                                List.of(BytesPlutusData.of(ownerPkh),
                                                BytesPlutusData.of(HexUtil.decodeHexString(markerPolicyId)),
                                                BytesPlutusData.of(PRODUCT_ID.getBytes())));
                String productPolicyId = policyId(productScript);
                Address productAddr = AddressProvider.getEntAddress(productScript, network);

                List<PlutusData> registry = new ArrayList<>();
                registry.add(BytesPlutusData.of(HexUtil.decodeHexString(productPolicyId)));
                PlutusData updatedFactoryDatum = ConstrPlutusData.of(0,
                                ListPlutusData.of(registry.toArray(new PlutusData[0])));

                PlutusData spendRedeemer = ConstrPlutusData.of(0,
                                BytesPlutusData.of(HexUtil.decodeHexString(productPolicyId)),
                                BytesPlutusData.of(PRODUCT_ID.getBytes()));

                PlutusData productDatum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(PRODUCT_TAG.getBytes()));

                String markerNameHex = HexUtil.encodeHexString(FACTORY_MARKER_NAME.getBytes());
                Asset productAsset = new Asset(PRODUCT_ID, BigInteger.ONE);
                PlutusData mintRedeemer = ConstrPlutusData.of(0);

                List<Amount> factoryOutputAmount = List.of(
                                Amount.asset(markerPolicyId, FACTORY_MARKER_NAME, BigInteger.ONE));

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(factoryUtxo), spendRedeemer)
                                .mintAsset(productPolicyId, List.of(productAsset), mintRedeemer,
                                                productAddr.getAddress(), productDatum)
                                .payToContract(factoryAddr.getAddress(), factoryOutputAmount,
                                                updatedFactoryDatum)
                                .attachSpendingValidator(factoryScript)
                                .attachMintValidator(productScript);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(owner.getBaseAddress())
                                .completeAndWait();
        }

        private static PlutusData outputReference(Utxo utxo) {
                return ConstrPlutusData.of(0,
                                BytesPlutusData.of(HexUtil.decodeHexString(utxo.getTxHash())),
                                BigIntPlutusData.of(utxo.getOutputIndex()));
        }

        private static String getValidator(String prefix) {
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json"));
                return blueprint.getValidators().stream()
                                .filter(v -> v.getTitle().startsWith(prefix))
                                .findFirst().orElseThrow().getCompiledCode();
        }

        private static PlutusScript applyParams(String compiledCode, List<PlutusData> params) {
                String parametrised = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(params.toArray(new PlutusData[0])),
                                compiledCode);
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }

        private static String policyId(PlutusScript script) {
                try {
                        return script.getPolicyId();
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }
        }

        private static void waitForScriptUtxoTx(Address address, String txHash, int timeoutSec)
                        throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        if (findScriptUtxoByTx(address, txHash) != null) {
                                System.out.println("Script UTxO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                throw new AssertionError("Timed out waiting for script UTxO from tx " + txHash);
        }

        private static Utxo findScriptUtxoByTx(Address address, String txHash) {
                List<Utxo> all = utxoSupplier.getAll(address.getAddress());
                for (Utxo u : all) {
                        if (txHash.equals(u.getTxHash())) return u;
                }
                return null;
        }
}

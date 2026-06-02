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
import java.util.List;

import org.bouncycastle.crypto.digests.SHA3Digest;

import com.bloxbean.cardano.aiken.AikenScriptUtil;
import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.address.Credential;
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
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.util.HexUtil;

/**
 * Upgradable proxy with three validators:
 *   proxy            (mint+spend)  param: seed_outref
 *   script_logic_v_1 (withdraw)    param: proxy_policy_id
 *   script_logic_v_2 (withdraw)    param: proxy_policy_id
 * Exercises init (one-shot mint of a state token + lock proxy state). mint and
 * change-version are stubbed because CCL 0.8.0-pre4 does not yet expose a
 * Plutus-witnessed stake-script registration; the evosdk port covers the full
 * flow.
 *
 * The proxy script is meant to live as a reference script on the proxy UTxO so
 * downstream txs don't have to re-attach the full validator.
 */
public class Proxy {

        private static final String PROXY_MINT_TOKEN = "ProxyMintToken";

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        static Account owner = Account.createFromMnemonic(network, mnemonic);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        public static void main(String[] args) throws Exception {
                List<Utxo> utxos = utxoSupplier.getAll(owner.baseAddress());
                if (utxos.isEmpty()) throw new AssertionError("No wallet UTxOs");
                Utxo seedUtxo = utxos.stream()
                                .filter(u -> u.getAmount().stream()
                                                .filter(a -> "lovelace".equals(a.getUnit()))
                                                .anyMatch(a -> a.getQuantity().longValueExact() > 5_000_000L))
                                .findFirst()
                                .orElseThrow(() -> new AssertionError("No suitable seed UTxO"));

                PlutusScript proxyScript = buildProxyScript(seedUtxo);
                String proxyPolicyId = computePolicyId(proxyScript);
                Address proxyAddress = AddressProvider.getEntAddress(proxyScript, network);

                PlutusScript v1Script = buildLogicScript(1, proxyPolicyId);
                String v1Hash = scriptHash(v1Script);
                Address v1RewardAddr = AddressProvider.getRewardAddress(v1Script, network);

                System.out.println("Proxy address:       " + proxyAddress.getAddress());
                System.out.println("Proxy policy:        " + proxyPolicyId);
                System.out.println("v1 reward address:   " + v1RewardAddr.getAddress());

                String stateTokenName = stateTokenName(seedUtxo.getTxHash(),
                                seedUtxo.getOutputIndex());
                System.out.println("State token name:    " + stateTokenName);

                TxResult initRes = init(seedUtxo, proxyScript, proxyPolicyId, proxyAddress,
                                v1Script, v1Hash, v1RewardAddr, stateTokenName);
                System.out.println("INIT result: successful=" + initRes.isSuccessful()
                                + " txHash=" + initRes.getTxHash());
                if (!initRes.isSuccessful())
                        throw new AssertionError("Proxy INIT failed: " + initRes.getResponse());
                waitForUtxoTx(proxyAddress, initRes.getTxHash(), 60);

                System.out.println("Init succeeded. mint() and change-version() require a"
                                + " Plutus-witnessed stake-script registration that CCL 0.8.0-pre4"
                                + " does not yet expose; see evosdk port for the full flow.");
        }

        private static TxResult init(Utxo seedUtxo, PlutusScript proxyScript, String proxyPolicyId,
                        Address proxyAddress, PlutusScript v1Script, String v1Hash,
                        Address v1RewardAddr, String stateTokenName) throws Exception {
                byte[] ownerVkh = owner.getBaseAddress().getPaymentCredentialHash().get();

                PlutusData proxyDatum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(HexUtil.decodeHexString(v1Hash)),
                                BytesPlutusData.of(ownerVkh));

                PlutusData mintRedeemer = ConstrPlutusData.of(1);

                // Asset(String, ...) interprets the name as UTF-8 unless prefixed with "0x";
                // the state token is the raw 32-byte sha3_256 hash, so "0x" forces hex decoding.
                Asset asset = new Asset("0x" + stateTokenName, BigInteger.ONE);

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(seedUtxo)
                                .mintAsset(proxyPolicyId, List.of(asset), mintRedeemer,
                                                proxyAddress.getAddress(), proxyDatum)
                                .attachMintValidator(proxyScript);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(owner.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult mintProduct(PlutusScript proxyScript, String proxyPolicyId,
                        Address proxyAddress, PlutusScript v1Script, String v1Hash,
                        Address v1RewardAddr, String prevTxHash) throws ApiException {
                Utxo proxyUtxo = findUtxoByTx(proxyAddress, prevTxHash);
                if (proxyUtxo == null) throw new AssertionError("Proxy UTxO not indexed");

                PlutusData proxyMintRedeemer = ConstrPlutusData.of(0);
                PlutusData withdrawRedeemer = ConstrPlutusData.of(0,
                                BytesPlutusData.of(PROXY_MINT_TOKEN.getBytes()),
                                BytesPlutusData.of("NoPassword".getBytes()));

                Asset productAsset = new Asset(PROXY_MINT_TOKEN, BigInteger.ONE);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                ScriptTx scriptTx = new ScriptTx()
                                .readFrom(proxyUtxo)
                                .mintAsset(proxyPolicyId, List.of(productAsset), proxyMintRedeemer,
                                                owner.baseAddress())
                                .attachMintValidator(proxyScript)
                                .withdraw(v1RewardAddr.getAddress(), BigInteger.ZERO, withdrawRedeemer)
                                .attachRewardValidator(v1Script);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(owner.getBaseAddress())
                                .completeAndWait();
        }

        private static PlutusScript buildProxyScript(Utxo seedUtxo) {
                String compiled = getValidator("proxy.");
                PlutusData seedOutRef = ConstrPlutusData.of(0,
                                BytesPlutusData.of(HexUtil.decodeHexString(seedUtxo.getTxHash())),
                                BigIntPlutusData.of(seedUtxo.getOutputIndex()));
                String parametrised = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(seedOutRef), compiled);
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }

        private static PlutusScript buildLogicScript(int version, String proxyPolicyId) {
                String compiled = getValidator("script_logic_v_" + version + ".");
                String parametrised = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(BytesPlutusData.of(HexUtil.decodeHexString(proxyPolicyId))),
                                compiled);
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }

        private static String getValidator(String prefix) {
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json"));
                return blueprint.getValidators().stream()
                                .filter(v -> v.getTitle().startsWith(prefix))
                                .findFirst().orElseThrow().getCompiledCode();
        }

        // State token name = sha3_256(tx_hash_bytes || ascii(output_index)).
        private static String stateTokenName(String txHashHex, int outputIndex) {
                byte[] txHashBytes = HexUtil.decodeHexString(txHashHex);
                byte[] idxBytes = String.valueOf(outputIndex).getBytes();
                byte[] msg = new byte[txHashBytes.length + idxBytes.length];
                System.arraycopy(txHashBytes, 0, msg, 0, txHashBytes.length);
                System.arraycopy(idxBytes, 0, msg, txHashBytes.length, idxBytes.length);
                SHA3Digest digest = new SHA3Digest(256);
                digest.update(msg, 0, msg.length);
                byte[] out = new byte[32];
                digest.doFinal(out, 0);
                return HexUtil.encodeHexString(out);
        }

        private static String computePolicyId(PlutusScript script) {
                try {
                        return script.getPolicyId();
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }
        }

        private static String scriptHash(PlutusScript script) {
                try {
                        return HexUtil.encodeHexString(script.getScriptHash());
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }
        }

        private static void waitForUtxoTx(Address address, String txHash, int timeoutSec)
                        throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        if (findUtxoByTx(address, txHash) != null) {
                                System.out.println("UTxO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                throw new AssertionError("Timed out waiting for UTxO from tx " + txHash);
        }

        private static Utxo findUtxoByTx(Address address, String txHash) {
                List<Utxo> all = utxoSupplier.getAll(address.getAddress());
                for (Utxo u : all) if (txHash.equals(u.getTxHash())) return u;
                return null;
        }
}

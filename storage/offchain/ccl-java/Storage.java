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
import java.security.MessageDigest;
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
 * One-shot snapshot publish against two validators:
 *   storage (spend, no params)           — ALWAYS FAILS so snapshots are immutable.
 *   mint    (mint, params seed_utxo +
 *            storage_validator_hash)     — mints exactly 1 state token
 *                                           (asset_name = sha2_256(snapshot_id))
 *                                           and outputs it to storage with RegistryDatum.
 *
 * The storage validator's permanent failure is the whole point: once a
 * snapshot UTxO is created it can never be spent, only added to.
 */
public class Storage {

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        static Account owner = Account.createFromMnemonic(network, mnemonic);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        public static void main(String[] args) throws Exception {
                // Wall-clock suffix avoids collisions with state tokens minted by previous
                // runs against the same yaci-devkit session.
                String snapshotId = "snap-" + System.currentTimeMillis() + "-daily";
                byte[] commitmentHash = sha256(("commitment-data-" + snapshotId).getBytes());

                TxResult res = publish(snapshotId, 0, commitmentHash);
                System.out.println("PUBLISH result: successful=" + res.isSuccessful()
                                + " txHash=" + res.getTxHash());
                if (!res.isSuccessful())
                        throw new AssertionError("Storage publish failed: " + res.getResponse());
        }

        private static TxResult publish(String snapshotId, int snapshotType, byte[] commitmentHash)
                        throws Exception {
                List<Utxo> utxos = utxoSupplier.getAll(owner.baseAddress());
                if (utxos.isEmpty()) throw new AssertionError("No wallet UTxOs");
                Utxo seedUtxo = utxos.getFirst();

                PlutusScript storageScript = loadStorageScript();
                Address storageAddress = AddressProvider.getEntAddress(storageScript, network);
                byte[] storageHash = storageScript.getScriptHash();

                PlutusScript mintScript = loadMintScript(seedUtxo, storageHash);
                String policyId;
                try {
                        policyId = mintScript.getPolicyId();
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }

                byte[] snapshotIdBytes = snapshotId.getBytes();
                byte[] assetNameBytes = sha256(snapshotIdBytes);
                String assetNameHex = HexUtil.encodeHexString(assetNameBytes);

                long publishedAtMs = backendService.getBlockService().getLatestBlock()
                                .getValue().getTime() * 1000L;

                PlutusData snapshotTypeConstr = ConstrPlutusData.of(snapshotType);
                PlutusData registryDatum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(snapshotIdBytes),
                                snapshotTypeConstr,
                                BytesPlutusData.of(commitmentHash),
                                BigIntPlutusData.of(publishedAtMs));
                PlutusData mintRedeemer = ConstrPlutusData.of(0,
                                BytesPlutusData.of(snapshotIdBytes),
                                snapshotTypeConstr,
                                BytesPlutusData.of(commitmentHash));

                // CCL's Asset(String, ...) interprets the name as UTF-8 unless prefixed
                // with "0x"; the on-chain asset name is the raw 32-byte sha256 digest,
                // so the "0x" prefix forces hex decoding.
                Asset asset = new Asset("0x" + assetNameHex, BigInteger.ONE);

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(seedUtxo)
                                .mintAsset(policyId, List.of(asset), mintRedeemer,
                                                storageAddress.getAddress(), registryDatum)
                                .attachMintValidator(mintScript);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .completeAndWait();
        }

        private static PlutusScript loadStorageScript() {
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json"));
                String compiled = blueprint.getValidators().stream()
                                .filter(v -> v.getTitle().startsWith("storage."))
                                .findFirst().orElseThrow().getCompiledCode();
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiled, PlutusVersion.v3);
        }

        private static PlutusScript loadMintScript(Utxo seedUtxo, byte[] storageHash) {
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json"));
                String compiled = blueprint.getValidators().stream()
                                .filter(v -> v.getTitle().startsWith("mint."))
                                .findFirst().orElseThrow().getCompiledCode();

                PlutusData seedOutRef = ConstrPlutusData.of(0,
                                BytesPlutusData.of(HexUtil.decodeHexString(seedUtxo.getTxHash())),
                                BigIntPlutusData.of(seedUtxo.getOutputIndex()));

                String parametrised = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(seedOutRef, BytesPlutusData.of(storageHash)),
                                compiled);
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }

        private static byte[] sha256(byte[] data) throws Exception {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                return md.digest(data);
        }
}

/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

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
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintUtil;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusContractBlueprint;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusVersion;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;

/**
 * Commit/reveal of anonymous data against a single validator that serves as both
 * mint policy and spend validator. COMMIT mints one token (asset_name =
 * blake2b_256(pkh || nonce)) into the script address with an inline datum;
 * REVEAL spends that UTxO supplying the nonce as redeemer.
 *
 * CCL quirk: ScriptCollectFromIntent silently drops the script input when no
 * payToAddress anchors the consumed value, so REVEAL forwards the full input
 * value back to the owner explicitly.
 */
public class AnonymousData {

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        static Account owner = Account.createFromMnemonic(network, mnemonic);
        static Address ownerAddress = owner.getBaseAddress();
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript plutusScript = loadPlutusScript();
        static String policyId = computePolicyId(plutusScript);
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        private static String computePolicyId(PlutusScript script) {
                try {
                        return script.getPolicyId();
                } catch (Exception e) {
                        throw new RuntimeException("Failed to compute policyId", e);
                }
        }

        static String NONCE_HEX = "deadbeef";
        static String DATA_HEX = HexUtil.encodeHexString("anonymous-payload".getBytes(StandardCharsets.UTF_8));

        public static void main(String[] args) throws ApiException, InterruptedException {
                byte[] pkh = ownerAddress.getPaymentCredentialHash().get();
                byte[] nonce = HexUtil.decodeHexString(NONCE_HEX);
                byte[] id = blake2b256(concat(pkh, nonce));
                String idHex = HexUtil.encodeHexString(id);
                System.out.println("ID = blake2b_256(pkh || nonce) = " + idHex);

                TxResult commitTx = commit(id, HexUtil.decodeHexString(DATA_HEX));
                System.out.println("COMMIT result: successful=" + commitTx.isSuccessful()
                                + " txHash=" + commitTx.getTxHash());
                if (!commitTx.isSuccessful())
                        throw new AssertionError("Commit failed");
                waitForUtxoWithToken(idHex, 60);

                TxResult revealTx = reveal(id, nonce);
                System.out.println("REVEAL result: successful=" + revealTx.isSuccessful()
                                + " txHash=" + revealTx.getTxHash());
                if (!revealTx.isSuccessful())
                        throw new AssertionError("Reveal failed");
        }

        private static TxResult commit(byte[] id, byte[] data) throws ApiException {
                String idHex = HexUtil.encodeHexString(id);

                // BytesPlutusData encodes Aiken ByteArray for both the policy redeemer (the ID)
                // and the inline datum (opaque user payload).
                PlutusData mintRedeemer = BytesPlutusData.of(id);
                PlutusData inlineDatum = BytesPlutusData.of(data);

                Asset asset = Asset.builder()
                                .name("0x" + idHex)
                                .value(BigInteger.ONE)
                                .build();

                ScriptTx scriptTx = new ScriptTx()
                                .mintAsset(policyId, List.of(asset), mintRedeemer,
                                                scriptAddress.getAddress(), inlineDatum)
                                .attachMintValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .completeAndWait();
        }

        private static TxResult reveal(byte[] id, byte[] nonce) throws ApiException {
                String idHex = HexUtil.encodeHexString(id);
                String unit = policyId + idHex.toLowerCase();
                Utxo target = utxoSupplier.getAll(scriptAddress.getAddress()).stream()
                                .filter(u -> u.getAmount().stream().anyMatch(a ->
                                                unit.equalsIgnoreCase(a.getUnit())))
                                .findFirst()
                                .orElseThrow(() -> new IllegalStateException("Committed UTxO not found"));

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                PlutusData spendRedeemer = BytesPlutusData.of(nonce);

                // CCL's collectFrom drops the script input when no payToAddress anchors its
                // value, so explicitly forward the entire input (lovelace + the singleton
                // token) to the owner. We deliberately do NOT burn the token here — the mint
                // handler enforces token_minted(+1) and would reject a -1 in the same tx.
                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(target), spendRedeemer)
                                .payToAddress(ownerAddress.getAddress(), target.getAmount())
                                .attachSpendingValidator(plutusScript);

                // validFrom(slot - 5) widens the lower bound a few slots into the past so
                // the chain-side validity check has slack against clock/indexer drift.
                // withSigner attaches a signing key; withRequiredSigners adds the pkh to the
                // tx's required_signers field so the validator's must_be_signed_by passes.
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 5)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
        }

        private static void waitForUtxoWithToken(String idHex, int timeoutSec) throws InterruptedException {
                String unit = policyId + idHex.toLowerCase();
                for (int i = 0; i < timeoutSec; i++) {
                        boolean found = utxoSupplier.getAll(scriptAddress.getAddress()).stream()
                                        .flatMap(u -> u.getAmount().stream())
                                        .anyMatch(a -> unit.equalsIgnoreCase(a.getUnit()));
                        if (found) {
                                System.out.println("Committed UTxO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                System.out.println("Timed out waiting for committed UTxO after " + timeoutSec + "s");
        }

        private static PlutusScript loadPlutusScript() {
                Path plutusJson = Paths.get(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }

        private static byte[] concat(byte[] a, byte[] b) {
                byte[] r = new byte[a.length + b.length];
                System.arraycopy(a, 0, r, 0, a.length);
                System.arraycopy(b, 0, r, a.length, b.length);
                return r;
        }

        private static byte[] blake2b256(byte[] in) {
                return Blake2bUtil.blake2bHash256(in);
        }
}

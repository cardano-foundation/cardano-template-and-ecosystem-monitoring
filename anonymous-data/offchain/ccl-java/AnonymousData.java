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
 * Anonymous data commit/reveal use-case.
 *
 *   ID = blake2b_256(pkh || nonce)
 *
 * Commit (mint): mint exactly one token with asset_name = ID, send it to the
 *   script address with an inline datum holding arbitrary user data.
 * Reveal (spend): spend that UTxO supplying the nonce as redeemer; the spender
 *   must be a signer whose pkh can reproduce the committed ID.
 *
 * The same script provides both the mint policy and the spend validator.
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

        // The validator has no parameters; the same compiled script serves both
        // the mint policy and the spending validator. Its hash is the policy id.
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

        // Test inputs.
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

                // Mint redeemer for the policy is the id (ByteArray).
                PlutusData mintRedeemer = BytesPlutusData.of(id);
                // Inline datum on the script output is the user's data (opaque).
                PlutusData inlineDatum = BytesPlutusData.of(data);

                Asset asset = Asset.builder()
                                .name("0x" + idHex)
                                .value(BigInteger.ONE)
                                .build();

                // Two-step: declare the policy script (so we can use the policyId-string
                // overload of mintAsset that supports an inline datum on the output).
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
                Utxo target = utxoSupplier.getAll(scriptAddress.getAddress()).stream()
                                .filter(u -> u.getAmount().stream().anyMatch(a ->
                                                (policyId + idHex).equalsIgnoreCase(a.getUnit())))
                                .findFirst()
                                .orElseThrow(() -> new IllegalStateException("Committed UTxO not found"));

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                // Spend redeemer is the nonce ByteArray.
                PlutusData spendRedeemer = BytesPlutusData.of(nonce);

                // Note: we do NOT burn the token. The contract's mint handler enforces
                // `token_minted(..., +1)` and would reject a -1 burn. The spend handler
                // imposes no constraint on where the token goes, so we forward the
                // entire UTxO value (token + lovelace) to the owner via change.
                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(target), spendRedeemer)
                                .attachSpendingValidator(plutusScript)
                                .withChangeAddress(ownerAddress.getAddress());

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
                Path plutusJson = Paths.get(System.getProperty("user.dir"),
                                "..", "..", "onchain", "aiken", "plutus.json");
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

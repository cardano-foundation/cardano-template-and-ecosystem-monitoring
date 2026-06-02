/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

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
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

/**
 * Decentralized identity against a single spend validator with no params.
 * Exercises TransferOwner (Constr 0) / AddDelegate (Constr 1) /
 * RemoveDelegate (Constr 2); the happy path runs init, add, remove.
 *
 * Delegate `expires` is derived from chain time with a 24h buffer, because
 * yaci-devkit's latest-block time can lag the current slot significantly
 * between transactions.
 */
public class Identity {

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        // Roles: index 0 = owner (locks the identity datum), index 1 = delegate.
        static Account owner = Account.createFromMnemonic(network, mnemonic);
        static Address ownerAddress = owner.getBaseAddress();
        static Account delegate = new Account(network,
                        "test test test test test test test test test test test test test test test test test test test test test test test sauce",
                        1);
        static Address delegateAddress = delegate.getBaseAddress();
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript plutusScript = loadPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                byte[] ownerVkh = ownerAddress.getPaymentCredentialHash().get();
                byte[] delegateVkh = delegateAddress.getPaymentCredentialHash().get();

                TxResult initRes = init(ownerVkh);
                System.out.println("INIT result: successful=" + initRes.isSuccessful()
                                + " txHash=" + initRes.getTxHash());
                if (!initRes.isSuccessful())
                        throw new AssertionError("Identity INIT failed");
                waitForScriptUtxoTx(initRes.getTxHash(), 60);

                long chainTimeMs = backendService.getBlockService()
                                .getLatestBlock().getValue().getTime() * 1000L;
                long expires = chainTimeMs + 24L * 60L * 60L * 1000L;
                TxResult addRes = addDelegate(ownerVkh, delegateVkh, expires, initRes.getTxHash());
                System.out.println("ADD result: successful=" + addRes.isSuccessful()
                                + " txHash=" + addRes.getTxHash());
                if (!addRes.isSuccessful())
                        throw new AssertionError("Identity ADD_DELEGATE failed: " + addRes.getResponse());
                waitForScriptUtxoTx(addRes.getTxHash(), 60);

                TxResult removeRes = removeDelegate(ownerVkh, delegateVkh, addRes.getTxHash());
                System.out.println("REMOVE result: successful=" + removeRes.isSuccessful()
                                + " txHash=" + removeRes.getTxHash());
                if (!removeRes.isSuccessful())
                        throw new AssertionError("Identity REMOVE_DELEGATE failed: " + removeRes.getResponse());
        }

        private static void waitForScriptUtxoTx(String txHash, int timeoutSec)
                        throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        if (findScriptUtxoByTx(txHash) != null) {
                                System.out.println("Script UTxO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                throw new AssertionError("Timed out waiting for script UTxO from tx " + txHash);
        }

        private static Utxo findScriptUtxoByTx(String txHash) {
                List<Utxo> all = utxoSupplier.getAll(scriptAddress.getAddress());
                for (Utxo u : all) {
                        if (txHash.equals(u.getTxHash()))
                                return u;
                }
                return null;
        }

        private static TxResult init(byte[] ownerVkh) {
                PlutusData datum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(ownerVkh),
                                ListPlutusData.of());
                Tx tx = new Tx()
                                .payToContract(scriptAddress.getAddress(), Amount.ada(5), datum)
                                .withChangeAddress(ownerAddress.getAddress())
                                .from(ownerAddress.getAddress());
                return quickTxBuilder.compose(tx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .completeAndWait();
        }

        private static TxResult addDelegate(byte[] ownerVkh, byte[] delegateVkh, long expiresMs,
                        String prevTxHash) throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null)
                        throw new AssertionError("Could not find script UTxO from tx " + prevTxHash);
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                ListPlutusData newDelegates = ListPlutusData.of(
                                ConstrPlutusData.of(0,
                                                BytesPlutusData.of(delegateVkh),
                                                BigIntPlutusData.of(expiresMs)));
                PlutusData newDatum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(ownerVkh), newDelegates);

                PlutusData redeemer = ConstrPlutusData.of(1,
                                BytesPlutusData.of(delegateVkh),
                                BigIntPlutusData.of(expiresMs));

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(scriptAddress.getAddress(), utxo.getAmount(), newDatum)
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
        }

        private static TxResult removeDelegate(byte[] ownerVkh, byte[] delegateVkh, String prevTxHash)
                        throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null)
                        throw new AssertionError("Could not find script UTxO from tx " + prevTxHash);
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                PlutusData newDatum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(ownerVkh),
                                ListPlutusData.of());

                PlutusData redeemer = ConstrPlutusData.of(2,
                                BytesPlutusData.of(delegateVkh));

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(scriptAddress.getAddress(), utxo.getAmount(), newDatum)
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
        }

        private static PlutusScript loadPlutusScript() {
                Path plutusJson = Paths.get(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }

        private static String bytesToHex(byte[] b) {
                StringBuilder sb = new StringBuilder(b.length * 2);
                for (byte x : b)
                        sb.append(String.format("%02x", x));
                return sb.toString();
        }
}

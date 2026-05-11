/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+
//RUNTIME_OPTIONS --enable-preview

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

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
import com.bloxbean.cardano.client.crypto.bip39.Sha256Hash;
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
 * Hashed Time-Lock Contract parametrised by (sha256(secret), expirationMs,
 * owner_pkh). Exercises GUESS (Constr 0 [answer]) before expiration and
 * WITHDRAW (Constr 1 []) after expiration.
 *
 * CCL quirk: in 0.8.0-pre4 the ConstrPlutusData builder produced bytes-only
 * output, breaking validator pattern-matching — use ConstrPlutusData.of so
 * redeemers carry the Constr tag (121 for alt 0, 122 for alt 1, ...).
 */
public class Htlc {

        static BackendService backendService = new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

        static String secret = "Secret Answer";

        static Network network = Networks.testnet();

        static Account payee1 = Account.createFromMnemonic(network, mnemonic);

        static Address ownerAddress = payee1.getBaseAddress();
        static Address receiverAddress = payee1.getBaseAddress();
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        // Expiration is baked into the parametrised script (it affects the script
        // hash) so it must be set before getParametrisedPlutusScript runs. The
        // buffer must outlast lockFunds + indexer wait + GUESS prep — if
        // completeAndWait blocks for minutes the yaci-devkit indexer is the
        // culprit, restart it.
        static long expirationMs = Instant.now().plusSeconds(30).toEpochMilli();

        static PlutusScript plutusScript = getParametrisedPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        static final long startMs = System.currentTimeMillis();

        public static void main(String[] args) throws ApiException, InterruptedException {

                lockFunds(20);
                waitForScriptUtxo(60);
                TxResult guessTx = unlockScript(Optional.of(secret), 5);
                printResult("GUESS", guessTx);

                lockFunds(10);
                waitForScriptUtxo(60);
                waitUntilExpired();
                TxResult withdrawTx = unlockScript(Optional.empty(), 5);
                printResult("WITHDRAW", withdrawTx);

                if (!guessTx.isSuccessful() || !withdrawTx.isSuccessful())
                        throw new AssertionError("HTLC CCL test failed");
        }

        private static void printResult(String label, TxResult r) {
                System.out.println(label + " result: successful=" + r.isSuccessful()
                                + " txHash=" + r.getTxHash()
                                + " response=" + r.getResponse());
        }

        private static void waitUntilExpired() throws InterruptedException {
                long target = expirationMs + 30_000L;
                long now = System.currentTimeMillis();
                if (now >= target) {
                        System.out.println("Expiration already passed — proceeding to WITHDRAW.");
                        return;
                }
                long waitMs = target - now;
                System.out.println("Waiting " + (waitMs / 1000) + "s for expiration to pass before WITHDRAW...");
                Thread.sleep(waitMs);
        }

        private static void waitForScriptUtxo(int timeoutSec) throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        List<Utxo> utxos = utxoSupplier.getAll(scriptAddress.getAddress());
                        if (!utxos.isEmpty()) {
                                System.out.println("Script UTXO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                System.out.println("Timed out waiting for script UTXO after " + timeoutSec + "s");
        }

        private static TxResult unlockScript(Optional<String> secretGuess, int adaAmount) throws ApiException {

                List<Utxo> allScriptUtxos = utxoSupplier.getAll(scriptAddress.getAddress());
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                System.out.println("Current slot: " + slot);
                // ConstrPlutusData.of emits Constr-tagged CBOR (tag 121 for alt 0, 122 for
                // alt 1). The 0.8.0-pre4 builder API emits bytes-only, which fails the
                // validator's `redeemer: Htlc { GUESS { answer } | WITHDRAW }` match.
                ConstrPlutusData redeemer = secretGuess
                                .map(s -> ConstrPlutusData.of(0L, BytesPlutusData.of(s.getBytes())))
                                .orElseGet(() -> ConstrPlutusData.of(1L));

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(allScriptUtxos,
                                                redeemer)
                                .payToAddress(receiverAddress.getAddress(), Amount.ada(
                                                adaAmount))
                                .attachSpendingValidator(plutusScript)
                                .withChangeAddress(ownerAddress.getAddress());
                // validFrom(slot - 5) widens the lower bound for clock drift; the upper
                // bound is kept tight (slot + 5) so the validity range still falls inside
                // the expiration window for GUESS while leaving headroom for the indexer.
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 5)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
        }

        private static void lockFunds(int adaMount) {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                Tx tx = new Tx().payToContract(scriptAddress.getAddress(), Amount.ada(adaMount), PlutusData.unit())
                                .withChangeAddress(ownerAddress.getAddress())
                                .from(ownerAddress.getAddress());
                // complete() (not completeAndWait) returns once the tx is submitted;
                // completeAndWait can block ~10 min on yaci-devkit waiting for "finality".
                // The next step polls the indexer for the script UTxO, which is enough
                // to know the UTxO is spendable.
                TxResult txResult = quickTxBuilder.compose(tx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .complete();
                System.out.println("Funds lock submitted. TxHash: %s".formatted(txResult.getTxHash()));
        }

        private static PlutusScript getParametrisedPlutusScript() {
                Path plutusJson = Paths.get(System.getProperty("user.dir"),
                                "..", "..", "onchain", "aiken", "plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String htlcCompiledCode = blueprint.getValidators().getFirst().getCompiledCode();

                byte[] hashedAnswer = Sha256Hash.hash(secret.getBytes());
                System.out.println("Expiration time (epoch ms): " + expirationMs);

                String compiledCode = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(
                                                BytesPlutusData.of(hashedAnswer),
                                                BigIntPlutusData.of(expirationMs),
                                                BytesPlutusData.of(ownerAddress.getPaymentCredentialHash().get())),
                                htlcCompiledCode);

                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }
}

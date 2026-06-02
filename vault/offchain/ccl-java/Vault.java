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
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintLoader;
import com.bloxbean.cardano.client.plutus.blueprint.PlutusBlueprintUtil;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusContractBlueprint;
import com.bloxbean.cardano.client.plutus.blueprint.model.PlutusVersion;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

/**
 * Time-locked vault parametrised by (owner_pkh, waitTimeMs). Exercises
 * WITHDRAW (Constr 0) which moves funds back to the script and starts the
 * cool-down by setting lock_time = now, then FINALIZE (Constr 1) once chain
 * time exceeds lock_time + waitTime. CANCEL (Constr 2) is omitted.
 *
 * Validity-range time interacts subtly with chain POSIX: validFrom(slot - 5)
 * widens the lower bound so the validator's strict-greater-than checks have
 * a few seconds of slack.
 */
public class Vault {

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        static Account payee1 = Account.createFromMnemonic(network, mnemonic);
        static Address ownerAddress = payee1.getBaseAddress();
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        // Must match the on-chain validator's waitTime parameter that is baked into
        // the script hash via getParametrisedPlutusScript.
        static long WAIT_TIME_MS = 60_000L;

        static PlutusScript plutusScript = getParametrisedPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                long farFuture = Instant.now().plusSeconds(3_153_600_000L).toEpochMilli();
                lockFunds(20, farFuture);
                waitForScriptUtxo(60);

                // Set the new lock_time well in the past so the validator's
                // valid_after(validity_range, lock_time) holds — the chain-side lower
                // bound (slot - 5 mapped to chain time) must exceed lock_time strictly.
                long withdrawLockTime = Instant.now().minusSeconds(60).toEpochMilli();
                TxResult withdrawTx = withdraw(withdrawLockTime);
                System.out.println("WITHDRAW result: successful=" + withdrawTx.isSuccessful()
                                + " txHash=" + withdrawTx.getTxHash());

                System.out.println("Waiting for waitTime to elapse before FINALIZE...");
                // FINALIZE requires validity_lower > lock_time + waitTime; lock_time is now-60s
                // and waitTime is 60s, so once chain time crosses "now" the check passes.
                Thread.sleep(30_000L);
                waitForScriptUtxo(60);
                TxResult finalizeTx = finalize_();
                System.out.println("FINALIZE result: successful=" + finalizeTx.isSuccessful()
                                + " txHash=" + finalizeTx.getTxHash());

                if (!withdrawTx.isSuccessful() || !finalizeTx.isSuccessful())
                        throw new AssertionError("Vault CCL test failed");
        }

        private static void waitForScriptUtxo(int timeoutSec) throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        if (!utxoSupplier.getAll(scriptAddress.getAddress()).isEmpty()) {
                                System.out.println("Script UTxO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                System.out.println("Timed out waiting for script UTxO after " + timeoutSec + "s");
        }

        private static void lockFunds(int adaAmount, long lockTimeMs) {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                PlutusData datum = ConstrPlutusData.of(0, BigIntPlutusData.of(lockTimeMs));
                Tx tx = new Tx()
                                .payToContract(scriptAddress.getAddress(), Amount.ada(adaAmount), datum)
                                .withChangeAddress(ownerAddress.getAddress())
                                .from(ownerAddress.getAddress());
                TxResult res = quickTxBuilder.compose(tx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .complete();
                System.out.println("Lock submitted. TxHash: " + res.getTxHash());
        }

        private static TxResult withdraw(long newLockTimeMs) throws ApiException {
                Utxo utxo = utxoSupplier.getAll(scriptAddress.getAddress()).getFirst();
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                System.out.println("WITHDRAW at slot " + slot);

                ConstrPlutusData redeemer = ConstrPlutusData.of(0L);
                PlutusData newDatum = ConstrPlutusData.of(0, BigIntPlutusData.of(newLockTimeMs));

                long inputLovelace = utxo.getAmount().stream()
                                .filter(a -> "lovelace".equals(a.getUnit()))
                                .findFirst().orElseThrow().getQuantity().longValue();

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(scriptAddress.getAddress(), Amount.lovelace(java.math.BigInteger.valueOf(inputLovelace)), newDatum)
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 5)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
        }

        private static TxResult finalize_() throws ApiException {
                Utxo utxo = utxoSupplier.getAll(scriptAddress.getAddress()).getFirst();
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                System.out.println("FINALIZE at slot " + slot);

                ConstrPlutusData redeemer = ConstrPlutusData.of(1L);

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToAddress(ownerAddress.getAddress(), utxo.getAmount())
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 5)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(payee1))
                                .withRequiredSigners(ownerAddress)
                                .completeAndWait();
        }

        private static PlutusScript getParametrisedPlutusScript() {
                Path plutusJson = Paths.get(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();

                String parametrised = AikenScriptUtil.applyParamToScript(
                                com.bloxbean.cardano.client.plutus.spec.ListPlutusData.of(
                                                BytesPlutusData.of(ownerAddress.getPaymentCredentialHash().get()),
                                                BigIntPlutusData.of(WAIT_TIME_MS)),
                                compiledCode);

                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }
}

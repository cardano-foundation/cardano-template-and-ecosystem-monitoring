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
 * Vault use-case. Validator parameters: (owner: VerificationKeyHash, waitTime: Int).
 * Datum on locked UTxO: WithdrawDatum { lock_time: Int }.
 * Redeemer: Action { WITHDRAW (0) | FINALIZE (1) | CANCEL (2) }.
 *
 * Happy path covered here:
 *   1. lock(amount)  → pay to script with WithdrawDatum { lock_time = far future }.
 *   2. withdraw()    → consume UTxO, return funds to script with lock_time = now (starts the wait).
 *   3. finalize()    → after waitTime elapses, sweep funds back to owner.
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

        // 60 seconds wait after WITHDRAW before FINALIZE is allowed (matches the
        // contract parameter applied at script-instantiation time).
        static long WAIT_TIME_MS = 60_000L;

        static PlutusScript plutusScript = getParametrisedPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                // 1. Lock 20 ADA with a far-future lock_time so it can't be finalized yet.
                long farFuture = Instant.now().plusSeconds(3_153_600_000L).toEpochMilli();
                lockFunds(20, farFuture);
                waitForScriptUtxo(60);

                // 2. WITHDRAW: re-output to script with lock_time = now (starts the timer).
                long withdrawAt = Instant.now().toEpochMilli();
                TxResult withdrawTx = withdraw(withdrawAt);
                System.out.println("WITHDRAW result: successful=" + withdrawTx.isSuccessful()
                                + " txHash=" + withdrawTx.getTxHash());

                // 3. Wait waitTime + buffer, then FINALIZE.
                System.out.println("Waiting for waitTime to elapse before FINALIZE...");
                Thread.sleep(WAIT_TIME_MS + 30_000L);
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

        // WITHDRAW (Constr 0): consume the script UTxO and re-output to script with
        // new lock_time = now, returning the SAME lovelace amount (validator enforces).
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

        // FINALIZE (Constr 1): claim funds back to owner. Requires validity range
        // lower bound > waitTime + lock_time, i.e. enough wall-clock has passed.
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
                Path plutusJson = Paths.get(System.getProperty("user.dir"),
                                "..", "..", "onchain", "aiken", "plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();

                // Validator params: (owner: VerificationKeyHash, waitTime: Int)
                String parametrised = AikenScriptUtil.applyParamToScript(
                                com.bloxbean.cardano.client.plutus.spec.ListPlutusData.of(
                                                BytesPlutusData.of(ownerAddress.getPaymentCredentialHash().get()),
                                                BigIntPlutusData.of(WAIT_TIME_MS)),
                                compiledCode);

                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }
}

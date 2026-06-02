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
 * Vesting against a single spend validator (no params). Datum carries
 * (lock_until, owner_vkh, beneficiary_vkh); the validator allows the spend
 * when (owner signed) OR (beneficiary signed AND now > lock_until). Exercises
 * lock + beneficiary withdraw after the lock elapses.
 *
 * Single mnemonic plays both owner and beneficiary so the happy path is
 * self-funding on yaci-devkit.
 */
public class Vesting {

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        // Roles: single account plays both owner and beneficiary in this happy-path demo.
        static Account owner = Account.createFromMnemonic(network, mnemonic);
        static Address ownerAddress = owner.getBaseAddress();
        static Address beneficiaryAddress = owner.getBaseAddress();
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript plutusScript = loadPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                long lockUntil = Instant.now().plusSeconds(30).toEpochMilli();
                lockFunds(20, lockUntil);
                waitForScriptUtxo(60);

                System.out.println("Waiting for lock_until to elapse...");
                Thread.sleep(45_000L);
                waitForScriptUtxo(60);
                TxResult withdrawTx = withdrawAsBeneficiary();
                System.out.println("WITHDRAW result: successful=" + withdrawTx.isSuccessful()
                                + " txHash=" + withdrawTx.getTxHash());

                if (!withdrawTx.isSuccessful())
                        throw new AssertionError("Vesting CCL test failed");
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

        private static void lockFunds(int adaAmount, long lockUntilMs) {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                byte[] ownerVkh = ownerAddress.getPaymentCredentialHash().get();
                byte[] beneficiaryVkh = beneficiaryAddress.getPaymentCredentialHash().get();

                PlutusData datum = ConstrPlutusData.of(0,
                                BigIntPlutusData.of(lockUntilMs),
                                BytesPlutusData.of(ownerVkh),
                                BytesPlutusData.of(beneficiaryVkh));

                Tx tx = new Tx()
                                .payToContract(scriptAddress.getAddress(), Amount.ada(adaAmount), datum)
                                .withChangeAddress(ownerAddress.getAddress())
                                .from(ownerAddress.getAddress());
                TxResult res = quickTxBuilder.compose(tx)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .complete();
                System.out.println("Lock submitted. TxHash: " + res.getTxHash());
        }

        private static TxResult withdrawAsBeneficiary() throws ApiException {
                Utxo utxo = utxoSupplier.getAll(scriptAddress.getAddress()).getFirst();
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                System.out.println("WITHDRAW at slot " + slot);

                ConstrPlutusData redeemer = ConstrPlutusData.of(0L);

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToAddress(beneficiaryAddress.getAddress(), utxo.getAmount())
                                .attachSpendingValidator(plutusScript);

                // validFrom(slot - 5) shifts the validity lower bound a few slots into
                // the past so the chain-side strict-greater-than (now > lock_until)
                // check has some clock-drift slack.
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 5)
                                .feePayer(ownerAddress.getAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(beneficiaryAddress)
                                .completeAndWait();
        }

        private static PlutusScript loadPlutusScript() {
                Path plutusJson = Paths.get(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }
}

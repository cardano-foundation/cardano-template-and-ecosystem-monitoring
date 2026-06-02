///usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.math.BigInteger;
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
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

/**
 * Demonstrates Cardano transaction atomicity by combining one always-true spend
 * validator with a password-checking mint policy in the same tx. The spend
 * succeeds unconditionally; the mint's redeemer (Constr 0 [password]) is what
 * gates the whole atomic bundle — so a wrong password rolls back the spend too.
 *
 * CCL quirk: in 0.8 a phase-2 script failure during cost evaluation surfaces as
 * a TxBuildException instead of a TxResult with isSuccessful()=false, so the
 * negative path catches the exception as the success signal.
 */
public class AtomicTransaction {

        static BackendService backendService = new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

        static String secret = "Secret Answer";

        static Network network = Networks.testnet();

        static Account account = Account.createFromMnemonic(network, mnemonic);

        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);
        static PlutusScript plutusScript = getPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {

                Tx tx = new Tx()
                                .payToAddress(scriptAddress.getAddress(), Amount.ada(10))
                                .from(account.baseAddress());
                TxResult scriptTopUp = quickTxBuilder.compose(tx)
                                .withSigner(SignerProviders.signerFrom(account))
                                .feePayer(account.baseAddress())
                                .completeAndWait();
                System.out.println("Script Address Funded in Tx: " + scriptTopUp);

                UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());
                List<Utxo> utxos = utxoSupplier.getAll(scriptAddress.getAddress());
                Utxo utxoToUnlock = utxos.getFirst();
                // ConstrPlutusData.of encodes Aiken sum-type constructors (alt 0 = first variant),
                // ListPlutusData.of holds positional fields, BytesPlutusData encodes ByteArray.
                ScriptTx scriptTxWrongPassword = new ScriptTx()
                                .collectFrom(utxoToUnlock, PlutusData.unit())
                                .payToAddress(account.baseAddress(), Amount.ada(10))
                                .mintAsset(plutusScript,
                                                Asset.builder().name("TestAsset").value(BigInteger.ONE).build(),
                                                ConstrPlutusData.builder().alternative(0)
                                                                .data(ListPlutusData.of(BytesPlutusData
                                                                                .of("wrong_password")))
                                                                .build(),
                                                account.baseAddress())
                                .attachSpendingValidator(plutusScript);

                // CCL 0.8 raises TxBuildException on phase-2 failure during cost evaluation,
                // so the catch IS the assertion that the wrong password was rejected.
                boolean wrongPasswordRejected = false;
                try {
                        TxResult txWrongPassword = quickTxBuilder.compose(scriptTxWrongPassword)
                                        .withSigner(SignerProviders.signerFrom(account))
                                        .feePayer(account.baseAddress())
                                        .completeAndWait();
                        wrongPasswordRejected = !txWrongPassword.isSuccessful();
                } catch (Exception e) {
                        wrongPasswordRejected = true;
                }
                System.out.println("Transaction with wrong password failed as expected: " + wrongPasswordRejected);

                ScriptTx scriptTxCorrectPassword = new ScriptTx()
                                .collectFrom(utxoToUnlock, PlutusData.unit())
                                .payToAddress(account.baseAddress(), Amount.ada(10))
                                .mintAsset(plutusScript,
                                                Asset.builder().name("TestAsset").value(BigInteger.ONE).build(),
                                                ConstrPlutusData.builder().alternative(0)
                                                                .data(ListPlutusData.of(BytesPlutusData
                                                                                .of("super_secret_password")))
                                                                .build(),
                                                account.baseAddress())
                                .attachSpendingValidator(plutusScript);
                TxResult txCorrectPassword = quickTxBuilder.compose(scriptTxCorrectPassword)
                                .withSigner(SignerProviders.signerFrom(account))
                                .feePayer(account.baseAddress())
                                .completeAndWait();
                System.out.println("Transaction with correct password success: " + txCorrectPassword.isSuccessful());

                if (!wrongPasswordRejected)
                        throw new AssertionError("AtomicTransaction CCL test failed: wrong password tx should have failed");
                if (!txCorrectPassword.isSuccessful())
                        throw new AssertionError("AtomicTransaction CCL test failed: correct password tx failed");
        }

        private static PlutusScript getPlutusScript() {
                String workingDir = System.getProperty("user.dir");
                Path plutusJsonPath = Paths.get(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json");

                PlutusContractBlueprint plutusContractBlueprint = PlutusBlueprintLoader
                                .loadBlueprint(plutusJsonPath.toFile());
                String simpleTransferCompiledCode = plutusContractBlueprint.getValidators().getFirst()
                                .getCompiledCode();

                PlutusScript plutusScript = PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(
                                simpleTransferCompiledCode,
                                PlutusVersion.v3);
                return plutusScript;
        }
}

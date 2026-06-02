/// usr/bin/env jbang "$0" "$@" ; exit $?
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
 * Price bet against a single spend validator with no params. Exercises Join
 * (Constr 0) on top of create — Win (Constr 1) and Timeout (Constr 2) require
 * an oracle inline-datum reference, deferred to the other off-chain ports.
 *
 * Option encodes as Constr 0 [value] = Some, Constr 1 [] = None.
 */
public class PriceBet {

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        // Roles: 0 = owner (funder + create), 1 = player (join), 2 = oracle (unused in this run).
        static Account owner = new Account(network, mnemonic, 0);
        static Account player = new Account(network, mnemonic, 1);
        static Account oracle = new Account(network, mnemonic, 2);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript plutusScript = loadPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                fundAccount(player.baseAddress(), 25);
                // Wait until the player's funder-change UTxO is indexed before they
                // attempt to spend in JOIN.
                waitForBalance(player.baseAddress(), 20_000_000L, 60);

                byte[] ownerVkh = owner.getBaseAddress().getPaymentCredentialHash().get();
                byte[] playerVkh = player.getBaseAddress().getPaymentCredentialHash().get();
                byte[] oracleVkh = oracle.getBaseAddress().getPaymentCredentialHash().get();

                long chainTimeMs = backendService.getBlockService()
                                .getLatestBlock().getValue().getTime() * 1000L;
                long deadline = chainTimeMs + 24L * 60L * 60L * 1000L;
                long betLovelace = 5_000_000L;
                long targetRate = 1500L;

                TxResult createRes = create(ownerVkh, oracleVkh, targetRate, deadline, betLovelace);
                System.out.println("CREATE result: successful=" + createRes.isSuccessful()
                                + " txHash=" + createRes.getTxHash());
                if (!createRes.isSuccessful())
                        throw new AssertionError("PriceBet CREATE failed: " + createRes.getResponse());
                waitForScriptUtxoTx(createRes.getTxHash(), 60);

                TxResult joinRes = join(ownerVkh, playerVkh, oracleVkh, targetRate, deadline, betLovelace,
                                createRes.getTxHash());
                System.out.println("JOIN result: successful=" + joinRes.isSuccessful()
                                + " txHash=" + joinRes.getTxHash());
                if (!joinRes.isSuccessful())
                        throw new AssertionError("PriceBet JOIN failed: " + joinRes.getResponse());
        }

        private static PlutusData buildDatum(byte[] ownerVkh, byte[] playerVkh, byte[] oracleVkh,
                        long targetRate, long deadline, long betAmount) {
                // Option<VKH>: Constr 0 [vkh] = Some, Constr 1 [] = None.
                PlutusData playerOption = playerVkh == null
                                ? ConstrPlutusData.of(1)
                                : ConstrPlutusData.of(0, BytesPlutusData.of(playerVkh));
                return ConstrPlutusData.of(0,
                                BytesPlutusData.of(ownerVkh),
                                playerOption,
                                BytesPlutusData.of(oracleVkh),
                                BigIntPlutusData.of(targetRate),
                                BigIntPlutusData.of(deadline),
                                BigIntPlutusData.of(betAmount));
        }

        private static TxResult create(byte[] ownerVkh, byte[] oracleVkh, long targetRate,
                        long deadline, long betLovelace) {
                PlutusData datum = buildDatum(ownerVkh, null, oracleVkh, targetRate, deadline, betLovelace);

                Tx tx = new Tx()
                                .payToContract(scriptAddress.getAddress(),
                                                Amount.lovelace(BigInteger.valueOf(betLovelace)),
                                                datum)
                                .from(owner.baseAddress())
                                .withChangeAddress(owner.baseAddress());

                return quickTxBuilder.compose(tx)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .completeAndWait();
        }

        private static TxResult join(byte[] ownerVkh, byte[] playerVkh, byte[] oracleVkh,
                        long targetRate, long deadline, long betLovelace, String prevTxHash)
                        throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null) throw new AssertionError("Could not find UTxO from " + prevTxHash);

                long inputLovelace = utxo.getAmount().stream()
                                .filter(a -> "lovelace".equals(a.getUnit()))
                                .findFirst().orElseThrow().getQuantity().longValueExact();
                long totalPot = inputLovelace * 2;

                PlutusData newDatum = buildDatum(ownerVkh, playerVkh, oracleVkh,
                                targetRate, deadline, betLovelace);
                PlutusData redeemer = ConstrPlutusData.of(0);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(scriptAddress.getAddress(),
                                                Amount.lovelace(BigInteger.valueOf(totalPot)),
                                                newDatum)
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(player.baseAddress())
                                .withSigner(SignerProviders.signerFrom(player))
                                .withRequiredSigners(player.getBaseAddress())
                                .completeAndWait();
        }

        private static void fundAccount(String address, long ada) {
                if (utxoSupplier.getAll(address).stream()
                                .map(Utxo::getAmount)
                                .flatMap(List::stream)
                                .anyMatch(a -> "lovelace".equals(a.getUnit())
                                                && a.getQuantity().longValueExact() >= ada * 1_000_000L)) {
                        return;
                }
                Tx tx = new Tx()
                                .payToAddress(address, Amount.ada(ada))
                                .from(owner.baseAddress());
                TxResult res = quickTxBuilder.compose(tx)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .completeAndWait();
                System.out.println("Funded " + address + " with " + ada + " ADA. tx=" + res.getTxHash());
        }

        private static void waitForBalance(String address, long minLovelace, int timeoutSec)
                        throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        long bal = utxoSupplier.getAll(address).stream()
                                        .map(Utxo::getAmount)
                                        .flatMap(List::stream)
                                        .filter(a -> "lovelace".equals(a.getUnit()))
                                        .mapToLong(a -> a.getQuantity().longValueExact())
                                        .sum();
                        if (bal >= minLovelace) return;
                        Thread.sleep(1000);
                }
                throw new AssertionError("Timed out waiting for balance at " + address);
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
                        if (txHash.equals(u.getTxHash())) return u;
                }
                return null;
        }

        private static PlutusScript loadPlutusScript() {
                Path plutusJson = Paths.get(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }
}

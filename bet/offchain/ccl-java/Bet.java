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
import com.bloxbean.cardano.client.exception.CborSerializationException;
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
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;

/**
 * Bet — single script provides both mint policy and spend validator.
 * Datum: BetDatum { player1: VKH, player2: VKH (empty until joined), oracle: VKH, expiration: Int }
 * Operations exercised: INIT (player1 mints + locks), JOIN (player2 spends + relocks 2x).
 * ANNOUNCE_WINNER deferred — would need a third account to act as oracle and clean payout.
 */
public class Bet {

        private static final String ASSET_NAME = "LuckyNumberSlevin";

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        static Account player1 = new Account(network, mnemonic, 0);
        static Account player2 = new Account(network, mnemonic, 1);
        static Account oracle = new Account(network, mnemonic, 2);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript plutusScript = loadPlutusScript();
        static String policyId = computePolicyId();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                fundAccount(player2.baseAddress(), 25);
                fundAccount(oracle.baseAddress(), 5); // for collateral if needed later
                waitForBalance(player2.baseAddress(), 25_000_000L, 60);

                byte[] p1Vkh = player1.getBaseAddress().getPaymentCredentialHash().get();
                byte[] p2Vkh = player2.getBaseAddress().getPaymentCredentialHash().get();
                byte[] oVkh = oracle.getBaseAddress().getPaymentCredentialHash().get();

                long chainTimeMs = backendService.getBlockService()
                                .getLatestBlock().getValue().getTime() * 1000L;
                long expiration = chainTimeMs + 24L * 60L * 60L * 1000L; // 24h beyond chain time

                TxResult initRes = init(p1Vkh, oVkh, expiration, 10_000_000L);
                System.out.println("INIT result: successful=" + initRes.isSuccessful()
                                + " txHash=" + initRes.getTxHash());
                if (!initRes.isSuccessful())
                        throw new AssertionError("Bet INIT failed: " + initRes.getResponse());
                waitForScriptUtxoTx(initRes.getTxHash(), 60);

                TxResult joinRes = join(p1Vkh, p2Vkh, oVkh, expiration, initRes.getTxHash());
                System.out.println("JOIN result: successful=" + joinRes.isSuccessful()
                                + " txHash=" + joinRes.getTxHash());
                if (!joinRes.isSuccessful())
                        throw new AssertionError("Bet JOIN failed: " + joinRes.getResponse());
        }

        private static TxResult init(byte[] p1Vkh, byte[] oracleVkh, long expiration, long lovelace)
                        throws ApiException {
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                // BetDatum: Constr 0 [p1, "" /* p2 */, oracle, expiration]
                PlutusData datum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(p1Vkh),
                                BytesPlutusData.of(new byte[0]),
                                BytesPlutusData.of(oracleVkh),
                                BigIntPlutusData.of(expiration));

                // Mint redeemer is unused by the validator; supply unit (Constr 0 []).
                PlutusData mintRedeemer = ConstrPlutusData.of(0);

                Asset asset = new Asset(ASSET_NAME, BigInteger.valueOf(1L));

                // The mint output is the only output to the script. Min-ada is fine — the
                // INIT validator does not check lovelace, only the datum invariants.
                ScriptTx scriptTx = new ScriptTx()
                                .mintAsset(policyId, List.of(asset), mintRedeemer,
                                                scriptAddress.getAddress(), datum)
                                .attachMintValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(player1.baseAddress())
                                .withSigner(SignerProviders.signerFrom(player1))
                                .withRequiredSigners(player1.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult join(byte[] p1Vkh, byte[] p2Vkh, byte[] oracleVkh,
                        long expiration, String prevTxHash) throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null)
                        throw new AssertionError("Could not find script UTxO from tx " + prevTxHash);

                long inputLovelace = utxo.getAmount().stream()
                                .filter(a -> "lovelace".equals(a.getUnit()))
                                .findFirst().orElseThrow().getQuantity().longValueExact();
                long newLovelace = inputLovelace * 2;

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                PlutusData newDatum = ConstrPlutusData.of(0,
                                BytesPlutusData.of(p1Vkh),
                                BytesPlutusData.of(p2Vkh),
                                BytesPlutusData.of(oracleVkh),
                                BigIntPlutusData.of(expiration));

                // JOIN = Constr 0 []
                PlutusData redeemer = ConstrPlutusData.of(0);

                // Build the new output value: refund the marker token + double the lovelace.
                List<Amount> newAmount = List.of(
                                Amount.lovelace(BigInteger.valueOf(newLovelace)),
                                Amount.asset(policyId, ASSET_NAME, BigInteger.ONE));

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(scriptAddress.getAddress(), newAmount, newDatum)
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(player2.baseAddress())
                                .withSigner(SignerProviders.signerFrom(player2))
                                .withRequiredSigners(player2.getBaseAddress())
                                .completeAndWait();
        }

        private static void fundAccount(String address, long ada) {
                // Send `ada` from player1 (the funded mnemonic-0 account) to `address`.
                if (utxoSupplier.getAll(address).stream()
                                .map(Utxo::getAmount)
                                .flatMap(List::stream)
                                .anyMatch(a -> "lovelace".equals(a.getUnit())
                                                && a.getQuantity().longValueExact() >= ada * 1_000_000L)) {
                        return;
                }
                com.bloxbean.cardano.client.quicktx.Tx tx = new com.bloxbean.cardano.client.quicktx.Tx()
                                .payToAddress(address, Amount.ada(ada))
                                .from(player1.baseAddress());
                TxResult res = quickTxBuilder.compose(tx)
                                .feePayer(player1.baseAddress())
                                .withSigner(SignerProviders.signerFrom(player1))
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
                        if (bal >= minLovelace)
                                return;
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
                        if (txHash.equals(u.getTxHash()))
                                return u;
                }
                return null;
        }

        private static PlutusScript loadPlutusScript() {
                Path plutusJson = Paths.get(System.getProperty("user.dir"),
                                "..", "..", "onchain", "aiken", "plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }

        private static String computePolicyId() {
                try {
                        return plutusScript.getPolicyId();
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }
        }
}

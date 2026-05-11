/// usr/bin/env jbang "$0" "$@" ; exit $?
///
// @formatter:off
//JAVA 24+

//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
//DEPS com.bloxbean.cardano:aiken-java-binding:0.1.0
// @formatter:on

import java.io.File;
import java.math.BigInteger;
import java.util.List;

import org.bouncycastle.crypto.digests.Blake2bDigest;

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
import com.bloxbean.cardano.client.exception.CborSerializationException;
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
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;

/**
 * Commit-reveal lottery against two chained validators:
 *   lottery_creator (mint)  param: game_index
 *   lottery         (spend) params: creator_script_hash, game_index
 * Exercises multisigCreate, reveal1, reveal2, settle.
 *
 * Both players sign INIT via two .withSigner calls (CCL handles multi-required
 * signers by chaining), and the funder at index 0 tops up the players first.
 */
public class Lottery {

        private static final String TOKEN_NAME = "LOTTERY_TOKEN";
        private static final long GAME_INDEX = 19L;
        private static final long END_REVEAL = 100L;
        private static final long DELTA = 20L;
        private static final long BET_LOVELACE = 10_000_000L;
        private static final String SECRET1 = "3";
        private static final String SECRET2 = "4";

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        // Roles: index 0 = funder (only used to top up the players), 1 = player1, 2 = player2.
        static Account funder = new Account(network, mnemonic, 0);
        static Account player1 = new Account(network, mnemonic, 1);
        static Account player2 = new Account(network, mnemonic, 2);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript creatorScript = applyParams("lottery_creator.",
                        List.of(BigIntPlutusData.of(GAME_INDEX)));
        static String creatorPolicyId = computePolicyId(creatorScript);
        static PlutusScript lotteryScript = applyParams("lottery.",
                        List.of(BytesPlutusData.of(HexUtil.decodeHexString(creatorPolicyId)),
                                        BigIntPlutusData.of(GAME_INDEX)));
        static Address lotteryAddress = AddressProvider.getEntAddress(lotteryScript, network);

        public static void main(String[] args) throws Exception {
                System.out.println("Lottery address: " + lotteryAddress.getAddress());
                fundAccount(player1.baseAddress(), 25);
                fundAccount(player2.baseAddress(), 25);
                // Wait for the funder's change UTxOs to be indexed at each player wallet
                // before they try to spend.
                waitForBalance(player1.baseAddress(), 20_000_000L, 60);
                waitForBalance(player2.baseAddress(), 20_000_000L, 60);

                byte[] p1 = player1.getBaseAddress().getPaymentCredentialHash().get();
                byte[] p2 = player2.getBaseAddress().getPaymentCredentialHash().get();

                TxResult createRes = create(p1, p2);
                System.out.println("CREATE result: successful=" + createRes.isSuccessful()
                                + " txHash=" + createRes.getTxHash());
                if (!createRes.isSuccessful())
                        throw new AssertionError("Lottery CREATE failed: " + createRes.getResponse());
                waitForScriptUtxoTx(createRes.getTxHash(), 60);

                TxResult r1 = reveal(player1, 0, SECRET1, p1, p2,
                                SECRET1, "", createRes.getTxHash());
                System.out.println("REVEAL1 result: successful=" + r1.isSuccessful()
                                + " txHash=" + r1.getTxHash());
                if (!r1.isSuccessful())
                        throw new AssertionError("Lottery REVEAL1 failed: " + r1.getResponse());
                waitForScriptUtxoTx(r1.getTxHash(), 60);

                TxResult r2 = reveal(player2, 1, SECRET2, p1, p2,
                                SECRET1, SECRET2, r1.getTxHash());
                System.out.println("REVEAL2 result: successful=" + r2.isSuccessful()
                                + " txHash=" + r2.getTxHash());
                if (!r2.isSuccessful())
                        throw new AssertionError("Lottery REVEAL2 failed: " + r2.getResponse());
                waitForScriptUtxoTx(r2.getTxHash(), 60);

                int n1 = Integer.parseInt(SECRET1);
                int n2 = Integer.parseInt(SECRET2);
                Account winner = ((n1 + n2) % 2 == 1) ? player1 : player2;
                TxResult settle = settle(winner, r2.getTxHash());
                System.out.println("SETTLE result: successful=" + settle.isSuccessful()
                                + " txHash=" + settle.getTxHash());
                if (!settle.isSuccessful())
                        throw new AssertionError("Lottery SETTLE failed: " + settle.getResponse());
        }

        private static PlutusData buildDatum(byte[] p1, byte[] p2,
                        String secret1Plain, String secret2Plain,
                        String nonce1Plain, String nonce2Plain) throws Exception {
                byte[] commit1 = blake2b256(secret1Plain.getBytes());
                byte[] commit2 = blake2b256(secret2Plain.getBytes());
                return ConstrPlutusData.of(0,
                                BytesPlutusData.of(p1),
                                BytesPlutusData.of(p2),
                                BytesPlutusData.of(commit1),
                                BytesPlutusData.of(commit2),
                                BytesPlutusData.of(nonce1Plain.getBytes()),
                                BytesPlutusData.of(nonce2Plain.getBytes()),
                                BigIntPlutusData.of(END_REVEAL),
                                BigIntPlutusData.of(DELTA));
        }

        private static TxResult create(byte[] p1, byte[] p2) throws Exception {
                PlutusData datum = buildDatum(p1, p2, SECRET1, SECRET2, "", "");
                PlutusData mintRedeemer = ConstrPlutusData.of(0);
                Asset asset = new Asset(TOKEN_NAME, BigInteger.ONE);

                ScriptTx scriptTx = new ScriptTx()
                                .mintAsset(creatorPolicyId, List.of(asset), mintRedeemer,
                                                lotteryAddress.getAddress(), datum)
                                .attachMintValidator(creatorScript);

                // Both players are required signers (must_be_signed_by p1 && must_be_signed_by p2),
                // so chain two withSigner calls to attach both signing keys and pass both pkhs
                // through withRequiredSigners so they appear in the script context.
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(player1.baseAddress())
                                .withSigner(SignerProviders.signerFrom(player1))
                                .withSigner(SignerProviders.signerFrom(player2))
                                .withRequiredSigners(player1.getBaseAddress(), player2.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult reveal(Account who, int redeemerIndex, String secretPlain,
                        byte[] p1, byte[] p2, String n1Plain, String n2Plain, String prevTxHash)
                        throws Exception {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null) throw new AssertionError("Lottery UTxO not indexed");

                PlutusData newDatum = buildDatum(p1, p2, SECRET1, SECRET2, n1Plain, n2Plain);
                PlutusData redeemer = ConstrPlutusData.of(redeemerIndex,
                                BytesPlutusData.of(secretPlain.getBytes()));

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(lotteryAddress.getAddress(),
                                                utxo.getAmount(), newDatum)
                                .attachSpendingValidator(lotteryScript);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(who.baseAddress())
                                .withSigner(SignerProviders.signerFrom(who))
                                .withRequiredSigners(who.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult settle(Account winner, String prevTxHash) throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null) throw new AssertionError("Lottery UTxO not indexed");

                PlutusData spendRedeemer = ConstrPlutusData.of(4);
                PlutusData burnRedeemer = ConstrPlutusData.of(1);
                Asset burnAsset = new Asset(TOKEN_NAME, BigInteger.valueOf(-1));

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), spendRedeemer)
                                .mintAsset(creatorPolicyId, List.of(burnAsset), burnRedeemer)
                                .payToAddress(winner.baseAddress(), Amount.lovelace(BigInteger.valueOf(BET_LOVELACE)))
                                .attachSpendingValidator(lotteryScript)
                                .attachMintValidator(creatorScript);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(winner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(winner))
                                .withRequiredSigners(winner.getBaseAddress())
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
                com.bloxbean.cardano.client.quicktx.Tx tx = new com.bloxbean.cardano.client.quicktx.Tx()
                                .payToAddress(address, Amount.ada(ada))
                                .from(funder.baseAddress());
                quickTxBuilder.compose(tx)
                                .feePayer(funder.baseAddress())
                                .withSigner(SignerProviders.signerFrom(funder))
                                .completeAndWait();
                System.out.println("Funded " + address + " with " + ada + " ADA");
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
                List<Utxo> all = utxoSupplier.getAll(lotteryAddress.getAddress());
                for (Utxo u : all) if (txHash.equals(u.getTxHash())) return u;
                return null;
        }

        private static byte[] blake2b256(byte[] data) {
                Blake2bDigest digest = new Blake2bDigest(256);
                digest.update(data, 0, data.length);
                byte[] out = new byte[32];
                digest.doFinal(out, 0);
                return out;
        }

        private static String getValidator(String prefix) {
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File("../../onchain/aiken/plutus.json"));
                return blueprint.getValidators().stream()
                                .filter(v -> v.getTitle().startsWith(prefix))
                                .findFirst().orElseThrow().getCompiledCode();
        }

        private static PlutusScript applyParams(String prefix, List<PlutusData> params) {
                String parametrised = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(params.toArray(new PlutusData[0])),
                                getValidator(prefix));
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }

        private static String computePolicyId(PlutusScript script) {
                try {
                        return script.getPolicyId();
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }
        }
}

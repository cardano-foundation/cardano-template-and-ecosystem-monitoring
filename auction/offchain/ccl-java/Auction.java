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
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;

/**
 * Auction against a single validator that doubles as mint policy and spend
 * validator. Exercises INIT (seller mints the auction marker + locks it under
 * an AuctionDatum) and BID (a higher bid that refunds the previous bid).
 *
 * Roles are derived from a single mnemonic via Account indices to keep the test
 * self-funding on yaci-devkit.
 */
public class Auction {

        private static final String ASSET_NAME = "AuctionItem";
        private static final long STARTING_BID = 0L;

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        // Roles: index 0 = seller (funds the demo), index 1 = bidder.
        static Account seller = new Account(network, mnemonic, 0);
        static Account bidder = new Account(network, mnemonic, 1);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript plutusScript = loadPlutusScript();
        static String policyId = computePolicyId();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                fundAccount(bidder.baseAddress(), 25);
                // Wait until the bidder's funding tx is indexed; without this the bid's
                // input-selection step sees an empty wallet and fails the build.
                waitForBalance(bidder.baseAddress(), 20_000_000L, 60);

                byte[] sellerVkh = seller.getBaseAddress().getPaymentCredentialHash().get();
                byte[] bidderVkh = bidder.getBaseAddress().getPaymentCredentialHash().get();

                long chainTimeMs = backendService.getBlockService()
                                .getLatestBlock().getValue().getTime() * 1000L;
                long expiration = chainTimeMs + 24L * 60L * 60L * 1000L;

                TxResult initRes = init(sellerVkh, expiration);
                System.out.println("INIT result: successful=" + initRes.isSuccessful()
                                + " txHash=" + initRes.getTxHash());
                if (!initRes.isSuccessful())
                        throw new AssertionError("Auction INIT failed: " + initRes.getResponse());
                waitForScriptUtxoTx(initRes.getTxHash(), 60);

                long firstBid = 5_000_000L;
                TxResult bidRes = bid(sellerVkh, bidderVkh, expiration, firstBid, initRes.getTxHash());
                System.out.println("BID result: successful=" + bidRes.isSuccessful()
                                + " txHash=" + bidRes.getTxHash());
                if (!bidRes.isSuccessful())
                        throw new AssertionError("Auction BID failed: " + bidRes.getResponse());
        }

        // ConstrPlutusData.of encodes the Aiken record (Constr 0); BytesPlutusData and
        // BigIntPlutusData encode the ByteArray / Int fields respectively.
        private static PlutusData buildDatum(byte[] sellerVkh, byte[] highestBidderVkh,
                        long highestBid, long expiration) {
                return ConstrPlutusData.of(0,
                                BytesPlutusData.of(sellerVkh),
                                BytesPlutusData.of(highestBidderVkh),
                                BigIntPlutusData.of(highestBid),
                                BigIntPlutusData.of(expiration),
                                BytesPlutusData.of(hexToBytes(policyId)),
                                BytesPlutusData.of(ASSET_NAME.getBytes()));
        }

        private static TxResult init(byte[] sellerVkh, long expiration) throws ApiException {
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();
                PlutusData datum = buildDatum(sellerVkh, new byte[0], STARTING_BID, expiration);
                PlutusData mintRedeemer = ConstrPlutusData.of(0);
                Asset asset = new Asset(ASSET_NAME, BigInteger.ONE);

                ScriptTx scriptTx = new ScriptTx()
                                .mintAsset(policyId, List.of(asset), mintRedeemer,
                                                scriptAddress.getAddress(), datum)
                                .attachMintValidator(plutusScript);

                // withSigner attaches a signing key to the tx; withRequiredSigners records
                // the pkh in required_signers so the validator's must_be_signed_by check
                // sees it inside the script context.
                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(seller.baseAddress())
                                .withSigner(SignerProviders.signerFrom(seller))
                                .withRequiredSigners(seller.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult bid(byte[] sellerVkh, byte[] bidderVkh, long expiration,
                        long bidLovelace, String prevTxHash) throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null)
                        throw new AssertionError("Could not find script UTxO from tx " + prevTxHash);
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                List<Amount> newAmount = List.of(
                                Amount.lovelace(BigInteger.valueOf(bidLovelace)),
                                Amount.asset(policyId, ASSET_NAME, BigInteger.ONE));

                PlutusData newDatum = buildDatum(sellerVkh, bidderVkh, bidLovelace, expiration);
                PlutusData redeemer = ConstrPlutusData.of(0);

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(scriptAddress.getAddress(), newAmount, newDatum)
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(bidder.baseAddress())
                                .withSigner(SignerProviders.signerFrom(bidder))
                                .withRequiredSigners(bidder.getBaseAddress())
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
                                .from(seller.baseAddress());
                TxResult res = quickTxBuilder.compose(tx)
                                .feePayer(seller.baseAddress())
                                .withSigner(SignerProviders.signerFrom(seller))
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

        private static byte[] hexToBytes(String hex) {
                byte[] out = new byte[hex.length() / 2];
                for (int i = 0; i < out.length; i++) {
                        out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
                }
                return out;
        }

        private static PlutusScript loadPlutusScript() {
                // PLUTUS_JSON lets the cross-check runner point this same off-chain flow at
                // a different on-chain implementation's blueprint (e.g. scalus) without code
                // edits. Falls back to the local Aiken blueprint for standalone runs.
                String override = System.getenv("PLUTUS_JSON");
                Path plutusJson = (override != null && !override.isBlank())
                                ? Paths.get(override)
                                : Paths.get(System.getProperty("user.dir"),
                                                "..", "..", "onchain", "aiken", "plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                // Look up the validator BY TITLE (fall back to index 0) so a blueprint that
                // orders its validators differently can't silently break the cross-check.
                String compiledCode = blueprint.getValidators().stream()
                                .filter(v -> "auction.auction.mint".equals(v.getTitle()))
                                .findFirst()
                                .orElse(blueprint.getValidators().getFirst())
                                .getCompiledCode();
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

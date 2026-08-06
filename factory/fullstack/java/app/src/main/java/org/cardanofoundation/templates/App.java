package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

import org.cardanofoundation.templates.validator.FactoryMarkerValidator;
import org.cardanofoundation.templates.validator.FactoryValidator;
import org.cardanofoundation.templates.validator.ProductValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
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
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * A factory that authorises products, and can prove which ones it authorised.
 *
 * <p>Three scripts cooperate. A one-shot policy mints a marker NFT that <em>is</em> the factory's
 * identity. The factory script holds that marker and keeps a list of every product policy it has
 * created. The product script refuses to mint unless the factory is spent in the same
 * transaction — which forces the factory to run and record the new product.
 *
 * <p>Neither script trusts the other. The guarantee comes from the fact that a transaction cannot
 * satisfy one without satisfying the other, so "this product was authorised" is checkable by
 * anyone from the chain alone.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    private static final Network NETWORK = Networks.testnet();
    private static final Account OWNER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final String MARKER_NAME = "FACTORY_MARKER";

    /** Enough ada to keep every script output above the minimum and cover fees. */
    private static final BigInteger OUTPUT_ADA = BigInteger.valueOf(3_000_000);

    // All three scripts are fixed once the seed UTxO is known, so they are resolved in main().
    private static PlutusScript markerPolicy;
    private static PlutusScript factory;
    private static PlutusScript product;
    private static String factoryAddress;
    private static String productAddress;
    private static byte[] productId;

    public static void main(String[] args) throws Exception {
        // A product id per run, so repeated runs against a long-lived devnet build distinct
        // product scripts instead of colliding on an already-minted token.
        productId = ("WIDGET-" + System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8);

        Utxo seed = pickSeed();

        // The parameter chain: the marker policy fixes the factory's identity, the factory
        // script is built around that identity, and the product script around both.
        markerPolicy = JulcScriptLoader.load(FactoryMarkerValidator.class,
                BytesPlutusData.of(ownerKeyHash()),
                outputReference(seed));

        factory = JulcScriptLoader.load(FactoryValidator.class,
                BytesPlutusData.of(ownerKeyHash()),
                BytesPlutusData.of(HexUtil.decodeHexString(markerPolicy.getPolicyId())));

        product = JulcScriptLoader.load(ProductValidator.class,
                BytesPlutusData.of(ownerKeyHash()),
                BytesPlutusData.of(HexUtil.decodeHexString(markerPolicy.getPolicyId())),
                BytesPlutusData.of(productId));

        factoryAddress = AddressProvider.getEntAddress(factory, NETWORK).toBech32();
        productAddress = AddressProvider.getEntAddress(product, NETWORK).toBech32();

        System.out.println("Factory address: " + factoryAddress);
        System.out.println("Marker policy:   " + markerPolicy.getPolicyId());
        System.out.println("Product policy:  " + product.getPolicyId());

        // 1. Bootstrap: mint the marker and park it at the factory with an empty product list.
        String openTx = openFactory(seed);
        System.out.println("Factory opened in " + openTx);
        Utxo factoryUtxo = factoryUtxoFrom(openTx);

        // 2. The authorisation chain: minting a product without spending the factory means the
        //    factory never gets a chance to record it, so the product script refuses.
        require(isRejected(() -> mintProductAlone()),
                "minting a product without spending the factory must be rejected");
        System.out.println("Product mint without the factory rejected as expected");

        // 3. The factory must actually remember what it authorised.
        require(isRejected(() -> createProduct(factoryUtxo, false)),
                "a creation that does not record the product must be rejected");
        System.out.println("Creation without recording the product rejected as expected");

        // 4. The real thing.
        TxResult created = createProduct(factoryUtxo, true);
        require(created.isSuccessful(), "creating the product failed: " + created);
        System.out.println("Product created in " + created.getTxHash());

        require(productLandedAtItsScript(created.getTxHash()),
                "the product token must be locked at the product script address");
        require(factoryRecorded(created.getTxHash(), product.getPolicyId()),
                "the factory datum must list the new product policy");

        System.out.println("Verified: the product exists and the factory records authorising it");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    /** Mints the marker against the seed UTxO and locks it at the factory with an empty list. */
    private static String openFactory(Utxo seed) throws Exception {
        Asset marker = Asset.builder().name(MARKER_NAME).value(BigInteger.ONE).build();

        Tx seedTx = new Tx()
                .collectFrom(List.of(seed))
                .from(OWNER.baseAddress());

        ScriptTx openTx = new ScriptTx()
                .mintAsset(markerPolicy, List.of(marker), PlutusData.unit(),
                        factoryAddress, factoryDatum(List.of()));

        TxResult result = TX_BUILDER.compose(seedTx, openTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        OWNER.baseAddress()))
                .completeAndWait();

        require(result.isSuccessful(), "opening the factory failed: " + result);
        return result.getTxHash();
    }

    /**
     * Spends the factory to create a product: the marker carries over to a new factory output,
     * the product token is minted, and the datum grows by one entry.
     *
     * <p>{@code record} is what the third step bends — a creation that mints the product but
     * "forgets" to record it is exactly what the factory script exists to refuse.
     */
    private static TxResult createProduct(Utxo factoryUtxo, boolean record) throws Exception {
        Asset productAsset = Asset.builder()
                .name("0x" + HexUtil.encodeHexString(productId))
                .value(BigInteger.ONE)
                .build();

        List<PlutusData> products = record
                ? List.of(BytesPlutusData.of(HexUtil.decodeHexString(product.getPolicyId())))
                : List.of();

        ScriptTx createTx = new ScriptTx()
                .collectFrom(factoryUtxo, createProductRedeemer())
                .attachSpendingValidator(factory)
                // The marker returns to the factory address, carrying the updated list.
                .payToContract(factoryAddress, markerAmounts(), factoryDatum(products))
                .mintAsset(product, List.of(productAsset), PlutusData.unit(),
                        productAddress, productDatum())
                .withChangeAddress(OWNER.baseAddress());

        return TX_BUILDER.compose(createTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        OWNER.baseAddress()))
                .completeAndWait();
    }

    /** A product mint with no factory input — the case the whole design exists to prevent. */
    private static TxResult mintProductAlone() throws Exception {
        Asset productAsset = Asset.builder()
                .name("0x" + HexUtil.encodeHexString(productId))
                .value(BigInteger.ONE)
                .build();

        ScriptTx mintTx = new ScriptTx()
                .mintAsset(product, List.of(productAsset), PlutusData.unit(),
                        productAddress, productDatum());

        return TX_BUILDER.compose(mintTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        OWNER.baseAddress()))
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code FactoryDatum { products: List<PolicyId> }}. */
    private static PlutusData factoryDatum(List<PlutusData> products) {
        return ConstrPlutusData.of(0, ListPlutusData.of(products.toArray(new PlutusData[0])));
    }

    /** {@code ProductDatum { tag }}. */
    private static PlutusData productDatum() {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of("first batch".getBytes(StandardCharsets.UTF_8)));
    }

    /** {@code CreateProduct { productPolicyId, productId }}. */
    private static PlutusData createProductRedeemer() throws Exception {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(HexUtil.decodeHexString(product.getPolicyId())),
                BytesPlutusData.of(productId));
    }

    /** A Plutus {@code TxOutRef}: the transaction hash and the output index within it. */
    private static PlutusData outputReference(Utxo utxo) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(HexUtil.decodeHexString(utxo.getTxHash())),
                BigIntPlutusData.of(utxo.getOutputIndex()));
    }

    private static List<Amount> markerAmounts() throws Exception {
        return List.of(
                Amount.lovelace(OUTPUT_ADA),
                Amount.asset(markerPolicy.getPolicyId(), MARKER_NAME, BigInteger.ONE));
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /** Fail-closed: the product token must sit at the product script address. */
    private static boolean productLandedAtItsScript(String txHash) throws Exception {
        String unit = product.getPolicyId() + HexUtil.encodeHexString(productId);
        return awaitOutputs(txHash, outputs -> outputs.stream()
                .filter(output -> productAddress.equals(output.getAddress()))
                // The backend model reports quantities as strings, so compare as strings —
                // BigInteger.ONE.equals("1") compiles and is silently always false.
                .anyMatch(output -> output.getAmount().stream()
                        .anyMatch(a -> unit.equals(a.getUnit()) && "1".equals(a.getQuantity()))));
    }

    /** The factory's new datum must name the product policy it just authorised. */
    private static boolean factoryRecorded(String txHash, String productPolicyId)
            throws Exception {
        return awaitOutputs(txHash, outputs -> outputs.stream()
                .filter(output -> factoryAddress.equals(output.getAddress()))
                .anyMatch(output -> output.getInlineDatum() != null
                        && output.getInlineDatum().contains(productPolicyId)));
    }

    /** Polls, because a node confirms a transaction slightly before the indexer serves it. */
    private static boolean awaitOutputs(String txHash, OutputCheck check) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return check.test(response.getValue().getOutputs());
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    @FunctionalInterface
    private interface OutputCheck {
        boolean test(List<com.bloxbean.cardano.client.backend.model.TxContentUtxoOutputs> outputs);
    }

    /**
     * Reports whether the chain refused a transaction.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a failed
     * result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Attempt attempt) {
        try {
            return !attempt.run().isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    // ── Wallet helpers ────────────────────────────────────────────────────────────────

    /** An ada-only UTxO big enough to seed the factory and cover fees. */
    private static Utxo pickSeed() throws Exception {
        return UTXOS.getAll(OWNER.baseAddress()).stream()
                .filter(utxo -> utxo.getAmount().size() == 1)
                .filter(utxo -> utxo.getAmount().get(0).getQuantity()
                        .compareTo(BigInteger.valueOf(10_000_000)) >= 0)
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no ada-only UTxO of at least 10 ada to seed the factory"));
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at the
     * factory address would pick up factories opened by an earlier run.
     */
    private static Utxo factoryUtxoFrom(String txHash) throws Exception {
        return UTXOS.getAll(factoryAddress).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no factory UTxO created by " + txHash));
    }

    private static byte[] ownerKeyHash() {
        return OWNER.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    /** The exit code is the result, so every check throws rather than printing a warning. */
    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }

    private static String envOrDefault(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}

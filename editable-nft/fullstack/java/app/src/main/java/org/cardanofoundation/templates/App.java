package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import org.cardanofoundation.templates.validator.EditableNftValidator;

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
 * A CIP-68 editable NFT.
 *
 * <p>Every NFT is a <b>pair</b> of tokens sharing one token id: a <em>reference</em> token holding
 * the metadata, which lives at the script, and a <em>user</em> token proving ownership, which
 * lives in a wallet.
 *
 * <p>That split is what lets metadata be editable without being forgeable. The data sits where a
 * contract can govern it; ownership stays a plain token that can be held or sold like any other.
 * Editing requires <em>presenting</em> the user token, not spending it — proving ownership costs
 * the owner nothing.
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

    /** CIP-67 labels, as raw bytes: 000643b0 tags the reference token, 000de140 the user token. */
    private static final byte[] REF_LABEL = {0x00, 0x06, 0x43, (byte) 0xb0};
    private static final byte[] USER_LABEL = {0x00, 0x0d, (byte) 0xe1, 0x40};

    private static final BigInteger MIN_ADA = BigInteger.valueOf(2_000_000);

    /**
     * Where the continuing reference output lands among the transaction's outputs.
     *
     * <p>The wallet half of this transaction pays nothing, so everything it collects becomes a
     * change output — and cardano-client-lib emits that before the script output. The reference
     * output is therefore second, not first.
     */
    private static final int REF_OUT_INDEX = 1;

    private static PlutusScript nft;
    private static String nftAddress;
    private static byte[] tokenId;

    public static void main(String[] args) throws Exception {
        // A token id per run, so repeated runs against a long-lived devnet mint distinct pairs.
        tokenId = ("nft-" + System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8);

        Utxo seed = pickSeed();
        nft = JulcScriptLoader.load(EditableNftValidator.class, outputReference(seed));
        nftAddress = AddressProvider.getEntAddress(nft, NETWORK).toBech32();

        System.out.println("NFT script:  " + nftAddress);
        System.out.println("Policy id:   " + nft.getPolicyId());
        System.out.println("Token id:    " + new String(tokenId, StandardCharsets.UTF_8));

        // 1. Mint the pair: reference token to the script, user token to the owner.
        String mintTx = mint(seed);
        System.out.println("Pair minted in " + mintTx);

        Utxo reference = utxoAt(nftAddress, mintTx);
        Utxo user = userTokenUtxo(mintTx);

        // 2. Ownership is proved by presenting the user token. Without it, anyone holding the
        //    reference UTxO's outpoint could rewrite the metadata.
        require(isRejected(() -> edit(reference, null, revised(false))),
                "editing without presenting the user token must be rejected");
        System.out.println("Edit without the user token rejected as expected");

        // 3. Edit the metadata.
        String editTx = succeed(edit(reference, user, revised(false)), "the edit").getTxHash();
        System.out.println("Metadata edited in " + editTx);

        Utxo edited = utxoAt(nftAddress, editTx);
        user = userTokenUtxo(editTx);

        // 4. Seal it — a legitimate edit, and the last one.
        String sealTx = succeed(edit(edited, user, revised(true)), "sealing").getTxHash();
        System.out.println("NFT sealed in " + sealTx);

        Utxo sealed = utxoAt(nftAddress, sealTx);
        Utxo userAfterSeal = userTokenUtxo(sealTx);

        // 5. Sealed means sealed. There is no unseal, and the data is fixed for good.
        require(isRejected(() -> edit(sealed, userAfterSeal, datum(NEW_DATA_AGAIN, true))),
                "editing a sealed NFT must be rejected");
        System.out.println("Edit of a sealed NFT rejected as expected");

        // 6. Immutable is not immortal: the pair can still be destroyed, together.
        String burnTx = succeed(burn(sealed, userAfterSeal), "the burn").getTxHash();
        System.out.println("Pair burned in " + burnTx);

        require(spendsScript(burnTx), "the confirmed transaction must spend the reference UTxO");

        System.out.println("Verified: editable until sealed, then fixed — and always a pair");
    }

    private static final byte[] NEW_DATA_AGAIN =
            "a third revision".getBytes(StandardCharsets.UTF_8);

    // ── Transactions ──────────────────────────────────────────────────────────────────

    /**
     * Mints the pair.
     *
     * <p>The seed UTxO is collected on its own and chosen large enough to cover the whole
     * transaction, so it is the transaction's only input and its index is unambiguously zero.
     */
    private static String mint(Utxo seed) throws Exception {
        // One transaction, collecting only the seed. A composed wallet Tx lets
        // cardano-client-lib add inputs of its own, and any that sort before the seed would push
        // it off the index the redeemer names — which is exactly how this failed intermittently.
        ScriptTx mintTx = new ScriptTx()
                .collectFrom(List.of(seed))
                .mintAsset(nft, List.of(asset(refName(), BigInteger.ONE)),
                        // Mint: seed at input index 0, reference output at index 0.
                        ConstrPlutusData.of(0, BigIntPlutusData.of(0), BigIntPlutusData.of(0)),
                        nftAddress, datum(FIRST_DATA, false))
                .mintAsset(nft, List.of(asset(userName(), BigInteger.ONE)),
                        ConstrPlutusData.of(0, BigIntPlutusData.of(0), BigIntPlutusData.of(0)),
                        OWNER.baseAddress(), PlutusData.unit())
                .withChangeAddress(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(mintTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();

        return succeed(result, "minting the pair").getTxHash();
    }

    /**
     * Edits the reference NFT, presenting the user token as an input and returning it untouched.
     *
     * <p>{@code user} is null in the rejection case — that is the whole point of it.
     */
    private static TxResult edit(Utxo reference, Utxo user, PlutusData newDatum) throws Exception {
        Utxo fees = pickSeed();

        // The fee UTxO and the user-token UTxO can be the same one — change from a previous
        // step often carries both the ada and the token. Collecting it twice would make the
        // input list disagree with what the ledger actually sees.
        List<Utxo> walletInputs = new ArrayList<>();
        walletInputs.add(fees);
        if (user != null && !isSame(user, fees)) {
            walletInputs.add(user);
        }
        // Everything is collected on the ScriptTx rather than a composed wallet Tx. A separate
        // Tx that pays nothing contributes its own change output, which makes the position of
        // the script output depend on cardano-client-lib's internal ordering; keeping it to one
        // transaction leaves the script output unambiguously first.
        int userIndex = user == null ? 0 : indexOf(user, reference, walletInputs);

        ScriptTx editTx = new ScriptTx()
                .collectFrom(walletInputs)
                // Edit: user token at the computed input index, reference output first.
                .collectFrom(reference, ConstrPlutusData.of(0,
                        BigIntPlutusData.of(userIndex), BigIntPlutusData.of(0)))
                .attachSpendingValidator(nft)
                .payToContract(nftAddress,
                        List.of(Amount.lovelace(MIN_ADA),
                                Amount.asset(nft.getPolicyId() + hex(refName()), BigInteger.ONE)),
                        newDatum)
                .withChangeAddress(OWNER.baseAddress());

        return TX_BUILDER.compose(editTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();
    }

    /** Destroys the pair. Both halves go, or the validator refuses. */
    private static TxResult burn(Utxo reference, Utxo user) throws Exception {
        Utxo fees = pickSeed();
        List<Utxo> walletInputs = new ArrayList<>();
        walletInputs.add(fees);
        if (!isSame(user, fees)) {
            walletInputs.add(user);
        }
        int userIndex = indexOf(user, reference, walletInputs);

        // One transaction, as in edit(): a separate wallet Tx would add its own change output
        // and move the script output out from under the index named in the redeemer.
        ScriptTx burnTx = new ScriptTx()
                .collectFrom(walletInputs)
                // BurnBoth is constructor 1, naming the user token's input index.
                .collectFrom(reference, ConstrPlutusData.of(1, BigIntPlutusData.of(userIndex)))
                .attachSpendingValidator(nft)
                .mintAsset(nft, List.of(
                                asset(refName(), BigInteger.valueOf(-1)),
                                asset(userName(), BigInteger.valueOf(-1))),
                        ConstrPlutusData.of(1))
                .payToAddress(OWNER.baseAddress(), Amount.lovelace(MIN_ADA))
                .withChangeAddress(OWNER.baseAddress());

        return TX_BUILDER.compose(burnTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    private static final byte[] FIRST_DATA = "first draft".getBytes(StandardCharsets.UTF_8);
    private static final byte[] REVISED_DATA = "revised".getBytes(StandardCharsets.UTF_8);

    private static PlutusData revised(boolean sealed) {
        return datum(REVISED_DATA, sealed);
    }

    /** {@code ReferenceNftDatum { tokenId, data, isSealed }}. */
    private static PlutusData datum(byte[] data, boolean sealed) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(tokenId),
                BytesPlutusData.of(data),
                // Plutus encodes False as Constr 0 and True as Constr 1.
                ConstrPlutusData.of(sealed ? 1 : 0));
    }

    private static PlutusData outputReference(Utxo utxo) {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(HexUtil.decodeHexString(utxo.getTxHash())),
                BigIntPlutusData.of(utxo.getOutputIndex()));
    }

    private static byte[] refName() {
        return concat(REF_LABEL, tokenId);
    }

    private static byte[] userName() {
        return concat(USER_LABEL, tokenId);
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the script address. Checking that a UTxO merely disappeared would pass by accident whenever
     * the lookup itself failed.
     */
    private static boolean spendsScript(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> nftAddress.equals(input.getAddress()));
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
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
            System.out.println("  rejected: " + shortMessage(rejected));
            return true;
        }
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    private static String shortMessage(Exception e) {
        String message = String.valueOf(e.getMessage());
        return message.length() > 120 ? message.substring(0, 120) + "…" : message;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    /**
     * Where the user token will sit once the ledger has sorted the inputs.
     *
     * <p>Cardano orders inputs by transaction hash then output index, so this reproduces that
     * ordering over the inputs we know the transaction will contain.
     */
    private static int indexOf(Utxo target, Utxo scriptInput, List<Utxo> walletInputs) {
        List<Utxo> all = new ArrayList<>(walletInputs);
        all.add(scriptInput);
        all.sort(Comparator.comparing(Utxo::getTxHash)
                .thenComparingInt(Utxo::getOutputIndex));

        for (int i = 0; i < all.size(); i++) {
            Utxo utxo = all.get(i);
            if (utxo.getTxHash().equals(target.getTxHash())
                    && utxo.getOutputIndex() == target.getOutputIndex()) {
                return i;
            }
        }
        throw new IllegalStateException("input not found among the transaction's inputs");
    }

    private static boolean isSame(Utxo a, Utxo b) {
        return a.getTxHash().equals(b.getTxHash()) && a.getOutputIndex() == b.getOutputIndex();
    }

    /** A large ada-only UTxO, so a transaction that collects it needs no other wallet input. */
    private static Utxo pickSeed() throws Exception {
        return UTXOS.getAll(OWNER.baseAddress()).stream()
                .filter(utxo -> utxo.getAmount().stream()
                        .anyMatch(amount -> "lovelace".equals(amount.getUnit())
                                && amount.getQuantity()
                                        .compareTo(BigInteger.valueOf(20_000_000)) >= 0))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO of at least 20 ada"));
    }

    private static Utxo utxoAt(String address, String txHash) throws Exception {
        return UTXOS.getAll(address).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO created by " + txHash));
    }

    /** The owner's UTxO holding the user token, as created by the given transaction. */
    private static Utxo userTokenUtxo(String txHash) throws Exception {
        String unit = nft.getPolicyId() + hex(userName());
        return UTXOS.getAll(OWNER.baseAddress()).stream()
                .filter(utxo -> utxo.getAmount().stream()
                        .anyMatch(amount -> unit.equals(amount.getUnit())))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("the user token was not found"));
    }

    private static Asset asset(byte[] name, BigInteger quantity) {
        return Asset.builder().name("0x" + hex(name)).value(quantity).build();
    }

    private static String hex(byte[] bytes) {
        return HexUtil.encodeHexString(bytes);
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static TxResult succeed(TxResult result, String what) {
        require(result.isSuccessful(), what + " failed: " + result);
        return result;
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

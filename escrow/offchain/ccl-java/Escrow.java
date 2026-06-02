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
import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.address.CredentialType;
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
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;

/**
 * Two-party escrow against a single spend validator (no params). Datum is
 * Initiation (Constr 0) or ActiveEscrow (Constr 1). Exercises
 * RecipientDeposit (Constr 0), CancelTrade (Constr 1) and CompleteTrade
 * (Constr 2).
 *
 * `initiator_assets` / `recipient_assets` are Aiken Pairs<PolicyId, Pairs<...>>
 * (MValue): encode them with MapPlutusData (outer/inner Maps), since Aiken
 * Pairs serialise as CBOR maps.
 */
public class Escrow {

        private static final long INITIATOR_LOVELACE = 5_000_000L;
        private static final long RECIPIENT_LOVELACE = 4_000_000L;

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        // Roles: index 0 = initiator (funds the demo + locks INITIATOR_LOVELACE),
        //        index 1 = recipient (deposits RECIPIENT_LOVELACE, pays fee on COMPLETE).
        static Account initiator = new Account(network, mnemonic, 0);
        static Account recipient = new Account(network, mnemonic, 1);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        static PlutusScript plutusScript = loadPlutusScript();
        static Address scriptAddress = AddressProvider.getEntAddress(plutusScript, network);

        public static void main(String[] args) throws ApiException, InterruptedException {
                System.out.println("Script Address: " + scriptAddress.getAddress());
                fundAccount(recipient.baseAddress(), 25);
                // Wait for recipient's funder-change UTxO to be indexed before DEPOSIT
                // selects inputs from that wallet.
                waitForBalance(recipient.baseAddress(), 20_000_000L, 60);

                TxResult initRes = initiate();
                System.out.println("INITIATE result: successful=" + initRes.isSuccessful()
                                + " txHash=" + initRes.getTxHash());
                if (!initRes.isSuccessful())
                        throw new AssertionError("Escrow INITIATE failed: " + initRes.getResponse());
                waitForScriptUtxoTx(initRes.getTxHash(), 60);

                TxResult depRes = recipientDeposit(initRes.getTxHash());
                System.out.println("DEPOSIT result: successful=" + depRes.isSuccessful()
                                + " txHash=" + depRes.getTxHash());
                if (!depRes.isSuccessful())
                        throw new AssertionError("Escrow DEPOSIT failed: " + depRes.getResponse());
                waitForScriptUtxoTx(depRes.getTxHash(), 60);

                TxResult compRes = complete(depRes.getTxHash());
                System.out.println("COMPLETE result: successful=" + compRes.isSuccessful()
                                + " txHash=" + compRes.getTxHash());
                if (!compRes.isSuccessful())
                        throw new AssertionError("Escrow COMPLETE failed: " + compRes.getResponse());
        }

        private static TxResult initiate() throws ApiException {
                PlutusData initiatorAddrData = encodeAddress(initiator.getBaseAddress());
                PlutusData initiatorAssets = mvalueLovelaceOnly(INITIATOR_LOVELACE);

                PlutusData datum = ConstrPlutusData.of(0, initiatorAddrData, initiatorAssets);

                Tx tx = new Tx()
                                .payToContract(scriptAddress.getAddress(),
                                                Amount.lovelace(BigInteger.valueOf(INITIATOR_LOVELACE)),
                                                datum)
                                .from(initiator.baseAddress())
                                .withChangeAddress(initiator.baseAddress());
                return quickTxBuilder.compose(tx)
                                .feePayer(initiator.baseAddress())
                                .withSigner(SignerProviders.signerFrom(initiator))
                                .completeAndWait();
        }

        private static TxResult recipientDeposit(String prevTxHash) throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null) throw new AssertionError("Initiation UTxO not indexed");

                PlutusData initiatorAddrData = encodeAddress(initiator.getBaseAddress());
                PlutusData recipientAddrData = encodeAddress(recipient.getBaseAddress());
                PlutusData initiatorAssets = mvalueLovelaceOnly(INITIATOR_LOVELACE);
                PlutusData recipientAssets = mvalueLovelaceOnly(RECIPIENT_LOVELACE);

                PlutusData newDatum = ConstrPlutusData.of(1,
                                initiatorAddrData,
                                initiatorAssets,
                                recipientAddrData,
                                recipientAssets);

                PlutusData redeemer = ConstrPlutusData.of(0, recipientAddrData, recipientAssets);

                long total = INITIATOR_LOVELACE + RECIPIENT_LOVELACE;
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToContract(scriptAddress.getAddress(),
                                                Amount.lovelace(BigInteger.valueOf(total)), newDatum)
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(recipient.baseAddress())
                                .withSigner(SignerProviders.signerFrom(recipient))
                                .withRequiredSigners(recipient.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult complete(String prevTxHash) throws ApiException {
                Utxo utxo = findScriptUtxoByTx(prevTxHash);
                if (utxo == null) throw new AssertionError("Active escrow UTxO not indexed");

                PlutusData redeemer = ConstrPlutusData.of(2);

                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                // The script UTxO holds INITIATOR_LOVELACE + RECIPIENT_LOVELACE. If the
                // explicit payouts equal that total, CCL deducts the tx fee from the
                // change output (routed back to initiator), pushing the initiator's
                // received amount below `recipient_assets` and failing the validator.
                // Composing a tiny external Tx from the recipient sources the fee from
                // outside the script value so the payouts stay intact.
                Tx feeTx = new Tx()
                                .payToAddress(recipient.baseAddress(), Amount.ada(2))
                                .from(recipient.baseAddress());

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(utxo), redeemer)
                                .payToAddress(initiator.baseAddress(),
                                                Amount.lovelace(BigInteger.valueOf(RECIPIENT_LOVELACE)))
                                .payToAddress(recipient.baseAddress(),
                                                Amount.lovelace(BigInteger.valueOf(INITIATOR_LOVELACE)))
                                .attachSpendingValidator(plutusScript);

                return quickTxBuilder.compose(feeTx, scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(recipient.baseAddress())
                                .withSigner(SignerProviders.signerFrom(initiator))
                                .withSigner(SignerProviders.signerFrom(recipient))
                                .withRequiredSigners(initiator.getBaseAddress(), recipient.getBaseAddress())
                                .completeAndWait();
        }

        // MValue is Aiken Pairs<PolicyId, Pairs<AssetName, Int>>; Aiken `Pairs` serialise
        // as CBOR Maps, so use nested MapPlutusData. Lovelace-only encodes with
        // empty-bytes policy and asset name.
        private static PlutusData mvalueLovelaceOnly(long lovelace) {
                MapPlutusData inner = MapPlutusData.builder().build();
                inner.put(BytesPlutusData.of(new byte[0]), BigIntPlutusData.of(lovelace));

                MapPlutusData outer = MapPlutusData.builder().build();
                outer.put(BytesPlutusData.of(new byte[0]), inner);
                return outer;
        }

        // Aiken Address: Constr 0 [PaymentCred, Option<StakeCred>].
        // PaymentCred  = Constr 0 [vkh] | Constr 1 [scriptHash].
        // Some(Inline(Cred)) is two nested Constr 0 wrappers around Cred.
        private static PlutusData encodeAddress(Address addr) {
                PlutusData paymentCred;
                if (addr.getPaymentCredential().isPresent()) {
                        Credential pc = addr.getPaymentCredential().get();
                        int idx = pc.getType() == CredentialType.Key ? 0 : 1;
                        paymentCred = ConstrPlutusData.of(idx, BytesPlutusData.of(pc.getBytes()));
                } else {
                        throw new IllegalStateException("Address has no payment credential");
                }
                PlutusData stakeOption;
                if (addr.getDelegationCredential().isPresent()) {
                        Credential sc = addr.getDelegationCredential().get();
                        int idx = sc.getType() == CredentialType.Key ? 0 : 1;
                        PlutusData inner = ConstrPlutusData.of(idx, BytesPlutusData.of(sc.getBytes()));
                        stakeOption = ConstrPlutusData.of(0, ConstrPlutusData.of(0, inner));
                } else {
                        stakeOption = ConstrPlutusData.of(1);
                }
                return ConstrPlutusData.of(0, paymentCred, stakeOption);
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
                                .from(initiator.baseAddress());
                quickTxBuilder.compose(tx)
                                .feePayer(initiator.baseAddress())
                                .withSigner(SignerProviders.signerFrom(initiator))
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
                throw new AssertionError("Timed out waiting for balance");
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
                for (Utxo u : all) if (txHash.equals(u.getTxHash())) return u;
                return null;
        }

        private static PlutusScript loadPlutusScript() {
                Path plutusJson = Paths.get(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json");
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader.loadBlueprint(plutusJson.toFile());
                String compiledCode = blueprint.getValidators().getFirst().getCompiledCode();
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(compiledCode, PlutusVersion.v3);
        }
}

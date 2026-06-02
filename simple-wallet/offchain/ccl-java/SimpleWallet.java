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

import com.bloxbean.cardano.aiken.AikenScriptUtil;
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
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;

/**
 * Smart-wallet pattern with three chained validators:
 *   intent (spend) param: owner_pkh
 *   wallet (mint)  params: owner_pkh, intent_script_hash
 *   funds  (spend) params: owner_pkh, wallet_script_hash
 * Exercises createIntent (mint INTENT_MARKER + lock at intent script), addFunds
 * (lock lovelace at funds script), executeIntent (spend both + burn marker +
 * pay recipient).
 *
 * Hard-coded validator indices come from plutus.json's emitted order; if the
 * Aiken module is renamed, re-verify them.
 */
public class SimpleWallet {

        private static final String INTENT_MARKER = "INTENT_MARKER";
        private static final long INTENT_LOVELACE = 5_000_000L;
        private static final long FUNDS_LOVELACE = 10_000_000L;
        private static final long PAYMENT_LOVELACE = 3_000_000L;

        private static final int IDX_FUNDS = 0;
        private static final int IDX_INTENT = 2;
        private static final int IDX_WALLET = 4;

        static BackendService backendService =
                        new BFBackendService("http://localhost:8080/api/v1/", "Dummy Key");
        static UtxoSupplier utxoSupplier = new DefaultUtxoSupplier(backendService.getUtxoService());

        static String mnemonic = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
        static Network network = Networks.testnet();
        // Roles: index 0 = owner (signs intents, pays fees), index 1 = recipient.
        static Account owner = new Account(network, mnemonic, 0);
        static Account recipient = new Account(network, mnemonic, 1);
        static QuickTxBuilder quickTxBuilder = new QuickTxBuilder(backendService);

        public static void main(String[] args) throws Exception {
                byte[] ownerVkh = owner.getBaseAddress().getPaymentCredentialHash().get();

                PlutusScript intentScript = applyParams(IDX_INTENT,
                                List.of(BytesPlutusData.of(ownerVkh)));
                String intentHash = scriptHashHex(intentScript);
                Address intentAddr = AddressProvider.getEntAddress(intentScript, network);

                PlutusScript walletScript = applyParams(IDX_WALLET,
                                List.of(BytesPlutusData.of(ownerVkh),
                                                BytesPlutusData.of(HexUtil.decodeHexString(intentHash))));
                String walletPolicyId = computePolicyId(walletScript);

                PlutusScript fundsScript = applyParams(IDX_FUNDS,
                                List.of(BytesPlutusData.of(ownerVkh),
                                                BytesPlutusData.of(HexUtil.decodeHexString(walletPolicyId))));
                Address fundsAddr = AddressProvider.getEntAddress(fundsScript, network);

                System.out.println("Intent address:  " + intentAddr.getAddress());
                System.out.println("Funds address:   " + fundsAddr.getAddress());
                System.out.println("Wallet policy:   " + walletPolicyId);

                TxResult intentRes = createIntent(intentAddr, walletScript, walletPolicyId);
                System.out.println("CREATE_INTENT result: successful=" + intentRes.isSuccessful()
                                + " txHash=" + intentRes.getTxHash());
                if (!intentRes.isSuccessful())
                        throw new AssertionError("createIntent failed: " + intentRes.getResponse());
                waitForUtxoTx(intentAddr, intentRes.getTxHash(), 60);

                TxResult fundsRes = addFunds(fundsAddr);
                System.out.println("ADD_FUNDS result: successful=" + fundsRes.isSuccessful()
                                + " txHash=" + fundsRes.getTxHash());
                if (!fundsRes.isSuccessful())
                        throw new AssertionError("addFunds failed: " + fundsRes.getResponse());
                waitForUtxoTx(fundsAddr, fundsRes.getTxHash(), 60);

                TxResult execRes = executeIntent(intentScript, intentAddr, intentRes.getTxHash(),
                                fundsScript, fundsAddr, fundsRes.getTxHash(),
                                walletScript, walletPolicyId);
                System.out.println("EXECUTE result: successful=" + execRes.isSuccessful()
                                + " txHash=" + execRes.getTxHash());
                if (!execRes.isSuccessful())
                        throw new AssertionError("executeIntent failed: " + execRes.getResponse());
        }

        private static TxResult createIntent(Address intentAddr, PlutusScript walletScript,
                        String walletPolicyId) {
                PlutusData recipientAddrData = encodeAddress(recipient.getBaseAddress());
                PlutusData intentDatum = ConstrPlutusData.of(0,
                                recipientAddrData,
                                BigIntPlutusData.of(PAYMENT_LOVELACE),
                                BytesPlutusData.of("memo".getBytes()));

                PlutusData mintRedeemer = ConstrPlutusData.of(0);
                Asset asset = new Asset(INTENT_MARKER, BigInteger.ONE);

                ScriptTx scriptTx = new ScriptTx()
                                .mintAsset(walletPolicyId, List.of(asset), mintRedeemer,
                                                intentAddr.getAddress(), intentDatum)
                                .attachMintValidator(walletScript);

                return quickTxBuilder.compose(scriptTx)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(owner.getBaseAddress())
                                .completeAndWait();
        }

        private static TxResult addFunds(Address fundsAddr) {
                PlutusData fundsDatum = ConstrPlutusData.of(0,
                                BigIntPlutusData.of(0),
                                ListPlutusData.of());

                Tx tx = new Tx()
                                .payToContract(fundsAddr.getAddress(),
                                                Amount.lovelace(BigInteger.valueOf(FUNDS_LOVELACE)),
                                                fundsDatum)
                                .from(owner.baseAddress())
                                .withChangeAddress(owner.baseAddress());

                return quickTxBuilder.compose(tx)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .completeAndWait();
        }

        private static TxResult executeIntent(PlutusScript intentScript, Address intentAddr,
                        String intentTxHash, PlutusScript fundsScript, Address fundsAddr,
                        String fundsTxHash, PlutusScript walletScript, String walletPolicyId)
                        throws ApiException {
                Utxo intentUtxo = findUtxoByTx(intentAddr, intentTxHash);
                Utxo fundsUtxo = findUtxoByTx(fundsAddr, fundsTxHash);
                if (intentUtxo == null || fundsUtxo == null)
                        throw new AssertionError("Intent/Funds UTxO not indexed");

                PlutusData fundsRedeemer = ConstrPlutusData.of(0);
                PlutusData intentRedeemer = ConstrPlutusData.of(0);
                PlutusData burnRedeemer = ConstrPlutusData.of(1);

                Asset burnAsset = new Asset(INTENT_MARKER, BigInteger.valueOf(-1));
                long slot = backendService.getBlockService().getLatestBlock().getValue().getSlot();

                ScriptTx scriptTx = new ScriptTx()
                                .collectFrom(List.of(fundsUtxo), fundsRedeemer)
                                .collectFrom(List.of(intentUtxo), intentRedeemer)
                                .mintAsset(walletPolicyId, List.of(burnAsset), burnRedeemer)
                                .payToAddress(recipient.baseAddress(),
                                                Amount.lovelace(BigInteger.valueOf(PAYMENT_LOVELACE)))
                                .attachSpendingValidator(fundsScript)
                                .attachSpendingValidator(intentScript)
                                .attachMintValidator(walletScript);

                return quickTxBuilder.compose(scriptTx)
                                .validFrom(slot - 5)
                                .validTo(slot + 50)
                                .feePayer(owner.baseAddress())
                                .withSigner(SignerProviders.signerFrom(owner))
                                .withRequiredSigners(owner.getBaseAddress())
                                .completeAndWait();
        }

        // Aiken Address: Constr 0 [PaymentCred, Option<StakeCred>].
        // PaymentCred = Constr 0 [vkh] | Constr 1 [scriptHash].
        // Some(Inline(Cred)) wraps Cred with two nested Constr 0.
        private static PlutusData encodeAddress(Address addr) {
                PlutusData paymentCred;
                if (addr.getPaymentCredential().isPresent()) {
                        Credential pc = addr.getPaymentCredential().get();
                        int idx = pc.getType() == CredentialType.Key ? 0 : 1;
                        paymentCred = ConstrPlutusData.of(idx,
                                        BytesPlutusData.of(pc.getBytes()));
                } else {
                        throw new IllegalStateException("Address has no payment credential");
                }

                PlutusData stakeOption;
                if (addr.getDelegationCredential().isPresent()) {
                        Credential sc = addr.getDelegationCredential().get();
                        int idx = sc.getType() == CredentialType.Key ? 0 : 1;
                        PlutusData inner = ConstrPlutusData.of(idx, BytesPlutusData.of(sc.getBytes()));
                        stakeOption = ConstrPlutusData.of(0,
                                        ConstrPlutusData.of(0, inner));
                } else {
                        stakeOption = ConstrPlutusData.of(1);
                }

                return ConstrPlutusData.of(0, paymentCred, stakeOption);
        }

        private static String getValidator(int index) {
                PlutusContractBlueprint blueprint = PlutusBlueprintLoader
                                .loadBlueprint(new File(System.getenv("PLUTUS_JSON") != null && !System.getenv("PLUTUS_JSON").isBlank() ? System.getenv("PLUTUS_JSON") : "../../onchain/aiken/plutus.json"));
                return blueprint.getValidators().get(index).getCompiledCode();
        }

        private static PlutusScript applyParams(int validatorIndex, List<PlutusData> params) {
                String parametrised = AikenScriptUtil.applyParamToScript(
                                ListPlutusData.of(params.toArray(new PlutusData[0])),
                                getValidator(validatorIndex));
                return PlutusBlueprintUtil.getPlutusScriptFromCompiledCode(parametrised, PlutusVersion.v3);
        }

        private static String scriptHashHex(PlutusScript script) {
                try {
                        return HexUtil.encodeHexString(script.getScriptHash());
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }
        }

        private static String computePolicyId(PlutusScript script) {
                try {
                        return script.getPolicyId();
                } catch (CborSerializationException e) {
                        throw new RuntimeException(e);
                }
        }

        private static void waitForUtxoTx(Address address, String txHash, int timeoutSec)
                        throws InterruptedException {
                for (int i = 0; i < timeoutSec; i++) {
                        if (findUtxoByTx(address, txHash) != null) {
                                System.out.println("UTxO indexed after " + i + "s");
                                return;
                        }
                        Thread.sleep(1000);
                }
                throw new AssertionError("Timed out waiting for UTxO from tx " + txHash);
        }

        private static Utxo findUtxoByTx(Address address, String txHash) {
                List<Utxo> all = utxoSupplier.getAll(address.getAddress());
                for (Utxo u : all) if (txHash.equals(u.getTxHash())) return u;
                return null;
        }
}

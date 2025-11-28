import { Lucid, Koios, assetsToValue, generateSeedPhrase, validatorToAddress, fromText, getAddressDetails, Data, LucidEvolution, applyParamsToScript, Constr, validatorToScriptHash, Script, Redeemer, toUnit } from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };
import { encodeHex } from "@std/encoding/hex";
import { sha3_256 } from "@noble/hashes/sha3.js";

const ProxyDatumSchema = Data.Object({
  script_pointer: Data.Bytes(),
  script_owner: Data.Bytes(),
});
type ProxyDatum = Data.Static<typeof ProxyDatumSchema>;
const ProxyDatum = ProxyDatumSchema as unknown as ProxyDatum;

async function prepare () {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );

  const mnemonic = generateSeedPhrase();
  lucid.selectWallet.fromSeed(mnemonic);
  const address = await lucid.wallet().address();

  Deno.writeTextFileSync(`wallet.txt`, mnemonic);
  
  console.log(`Successfully prepared wallet (seed phrase).`);
  console.log(`Make sure to send some tADA to the wallet ${address} 
  as this wallet will be used in this example, to submit the transaction. 
  Therefore enough tAda for covering fees and to provide a collateral will be needed.`);
}

function selectWallet (lucid: LucidEvolution) {
  const mnemonic = Deno.readTextFileSync(`wallet.txt`);
  lucid.selectWallet.fromSeed(mnemonic);
}

async function initProxy() {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);

  const allUTxOs = await lucid.utxosAt(address);
  const userUtxo = allUTxOs.find(utxo => {
    const value = assetsToValue(utxo.assets);
    return value.coin() > 2_000_000n;
  });

  if (!userUtxo) {
    console.error("No UTxO with enough funds found in the selected wallet. Please fund the wallet and try again.");
    Deno.exit(1);
  }

  const transactionHash = String(userUtxo.txHash);
  const outputIndex = BigInt(userUtxo.outputIndex);
  const outputReference = new Constr(0, [transactionHash, outputIndex]);

  // apply parameters (utxo) to script 
  const proxyValidator: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find(validator => validator.title.startsWith("proxy"))!.compiledCode,
      [outputReference]
    ),
  };

  const proxyPolicyId = validatorToScriptHash(proxyValidator);

  // apply parameters script hash of the first script to the logic script
  const upgradableLogicValidator: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find(validator => validator.title.startsWith("script_logic_v_1"))!.compiledCode,
      [new Constr(0, [String(proxyPolicyId)])]
    ),
  };

  const datum = Data.to({
    script_pointer: String(validatorToScriptHash(upgradableLogicValidator)),
    script_owner: String(paymentCredential?.hash!),
  }, ProxyDatum)

  const txHashBytes = new Uint8Array(
    userUtxo.txHash.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );

  const outputIndexString = userUtxo.outputIndex.toString();
  const outputIndexBytes = new TextEncoder().encode(outputIndexString);

  const messageBuffer = new Uint8Array(txHashBytes.length + outputIndexBytes.length);
  messageBuffer.set(txHashBytes, 0);
  messageBuffer.set(outputIndexBytes, txHashBytes.length);

  const hash = sha3_256(messageBuffer);
  const state_token_name = encodeHex(new Uint8Array(hash));

  const redeemer: Redeemer = Data.to(new Constr(1, []));

  const tx = await lucid.newTx()
      .attach.MintingPolicy(proxyValidator)
      .collectFrom([userUtxo!], Data.void())
      .mintAssets({ [toUnit(proxyPolicyId, state_token_name)]: 1n }, redeemer)
      .pay.ToContract(validatorToAddress('Preprod', proxyValidator), { kind: 'inline', value: datum }, { [toUnit(proxyPolicyId, state_token_name)]: 1n })
      .addSigner(address);

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully setup a proxy contract pointing to ${address}.\n
    See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
};

if (Deno.args.length > 0) {
  if (Deno.args[0] === 'init') {
      await initProxy();
  } else if (Deno.args[0] === 'prepare') {
    const files = Deno.readDirSync('.');
    if (!files.find(file => file.name === 'wallet.txt')) {
      console.log('Seed phrase (file wallet.txt) already exist. Please remove it before preparing a new one.');
    } else {
      await prepare();
    } 
  } else {
    console.log('Invalid argument. Allowed arguments are "init" or "prepare".');
    console.log('Example usage: node proxy.js prepare');
  }
} else {
  console.log('Expected an argument. Allowed arguments are "init" or "prepare".');
  console.log('Example usage: node proxy.js prepare');
}


import { Lucid, Koios, assetsToValue, generateSeedPhrase, validatorToAddress, getAddressDetails, Data, LucidEvolution, applyParamsToScript, Constr, validatorToScriptHash, Script, Redeemer, toUnit, validatorToRewardAddress } from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };
import { encodeHex } from "@std/encoding/hex";
import { sha3_256 } from "@noble/hashes/sha3.js";

const ProxyDatumSchema = Data.Object({
  script_pointer: Data.Bytes(),
  script_owner: Data.Bytes(),
});

type ProxyDatum = Data.Static<typeof ProxyDatumSchema>;
const ProxyDatum = ProxyDatumSchema as unknown as ProxyDatum;

const WithdrawalRedeemerV1Schema = Data.Object({
  token_name: Data.Bytes(),
  password: Data.Bytes(),
});

type WithdrawalRedeemerV1 = Data.Static<typeof WithdrawalRedeemerV1Schema>;
const WithdrawalRedeemerV1 = WithdrawalRedeemerV1Schema as unknown as WithdrawalRedeemerV1;

const WithdrawalRedeemerV2Schema = Data.Object({
  invalid_token_name: Data.Bytes(),
});

type WithdrawalRedeemerV2 = Data.Static<typeof WithdrawalRedeemerV2Schema>;
const WithdrawalRedeemerV2 = WithdrawalRedeemerV2Schema as unknown as WithdrawalRedeemerV2;

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
      [proxyPolicyId]
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
      .attach.CertificateValidator(upgradableLogicValidator)
      .collectFrom([userUtxo!], Data.void())
      .mintAssets({ [toUnit(proxyPolicyId, state_token_name)]: 1n }, redeemer)
      .register.Stake(validatorToRewardAddress('Preprod', upgradableLogicValidator))
      .pay.ToContract(validatorToAddress('Preprod', proxyValidator), { kind: 'inline', value: datum }, { [toUnit(proxyPolicyId, state_token_name)]: 1n })
      .addSigner(address);

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully setup a proxy contract pointing to ${address}.\n
    See: https://preprod.cexplorer.io/tx/${txHash}`);
    console.log(`Proxy Script Address: ${validatorToAddress('Preprod', proxyValidator)}`);
    console.log(`The utxo reference for this parameterized script is: ${transactionHash}#${outputIndex}`);
    console.log(`You can now use this utxo reference to mint new tokens via the proxy contract.`);
    console.log(`Example usage: deno run -A proxy.ts mint ${transactionHash} ${outputIndex} 1`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
};

async function mint(txHash: string, outputIndex: number, version: number) {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
  selectWallet(lucid);
  const address = await lucid.wallet().address();

  if (version === 1 || version === 2) {
    const outputReference = new Constr(0, [txHash, BigInt(outputIndex)]);

    // apply parameters (utxo) to script 
    const proxyValidator: Script = {
      type: "PlutusV3",
      script: applyParamsToScript(
        blueprint.validators.find(validator => validator.title.startsWith("proxy"))!.compiledCode,
        [outputReference]
      ),
    };

    const proxyPolicyId = validatorToScriptHash(proxyValidator);
    console.log(`Using proxy policy ID: ${proxyPolicyId}`);

    // apply parameters script hash of the first script to the logic script
    const upgradableLogicValidator: Script = {
      type: "PlutusV3",
      script: applyParamsToScript(
        blueprint.validators.find(validator => validator.title.startsWith(`script_logic_v_${version}`))!.compiledCode,
        [proxyPolicyId]
      ),
    };

    const txHashBytes = new Uint8Array(
      txHash.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
    );

    const outputIndexString = outputIndex.toString();
    const outputIndexBytes = new TextEncoder().encode(outputIndexString);

    const messageBuffer = new Uint8Array(txHashBytes.length + outputIndexBytes.length);
    messageBuffer.set(txHashBytes, 0);
    messageBuffer.set(outputIndexBytes, txHashBytes.length);

    const hash = sha3_256(messageBuffer);
    const state_token_name = encodeHex(new Uint8Array(hash));

    const redeemer: Redeemer = Data.to(new Constr(0, []));
    const withdrawRedeemer: Redeemer = version === 1 ? Data.to({
      token_name: encodeHex("ProxyMintToken"),
      password: encodeHex("NoPassword"),
    }, WithdrawalRedeemerV1) : Data.to({
      invalid_token_name: encodeHex("InvalidToken"),
    }, WithdrawalRedeemerV2);

    const utxos = await lucid.utxosAtWithUnit(validatorToAddress('Preprod', proxyValidator), toUnit(proxyPolicyId, state_token_name));
    const stateUtxo = utxos[0];

    const tx = await lucid.newTx()
        .readFrom([stateUtxo!])
        .attach.MintingPolicy(proxyValidator)
        .attach.WithdrawalValidator(upgradableLogicValidator)
        .mintAssets({ [toUnit(proxyPolicyId, encodeHex("ProxyMintToken"))]: 1n }, redeemer)
        .withdraw(validatorToRewardAddress('Preprod', upgradableLogicValidator), 0n, withdrawRedeemer)
        .addSigner(address);

    try {
      const unsignedTx = await tx.complete();
      const signedTx = await unsignedTx.sign.withWallet();
      const txHash = await (await signedTx.complete()).submit();
      console.log(`Successfully minted a token under policy ${proxyPolicyId} using minting logic version ${version}.\n
      See: https://preprod.cexplorer.io/tx/${txHash}`);
    } catch (error) {
      console.error("Error while submitting transaction:", error);
      Deno.exit(1);
    }
  } else {
    console.log("Unsupported version. Only version 1 and 2 are supported.");
    return;
  }
}

async function upgrade(txHash: string, outputIndex: number, version: number) {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);

  if (version === 1 || version === 2) {
    const outputReference = new Constr(0, [txHash, BigInt(outputIndex)]);

    // apply parameters (utxo) to script 
    const proxyValidator: Script = {
      type: "PlutusV3",
      script: applyParamsToScript(
        blueprint.validators.find(validator => validator.title.startsWith("proxy"))!.compiledCode,
        [outputReference]
      ),
    };

    const proxyPolicyId = validatorToScriptHash(proxyValidator);
    const currentVersion = version === 1 ? "v_2" : "v_1";
    const nextVersion = version === 1 ? "v_1" : "v_2";

    // apply parameters script hash of the first script to the logic script
    const upgradableLogicValidator_current: Script = {
      type: "PlutusV3",
      script: applyParamsToScript(
        blueprint.validators.find(validator => validator.title.startsWith(`script_logic_${currentVersion}`))!.compiledCode,
        [proxyPolicyId]
      ),
    };

    const upgradableLogicValidator_next: Script = {
      type: "PlutusV3",
      script: applyParamsToScript(
        blueprint.validators.find(validator => validator.title.startsWith(`script_logic_${nextVersion}`))!.compiledCode,
        [proxyPolicyId]
      ),
    };

    const txHashBytes = new Uint8Array(
      txHash.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
    );

    const outputIndexString = outputIndex.toString();
    const outputIndexBytes = new TextEncoder().encode(outputIndexString);

    const messageBuffer = new Uint8Array(txHashBytes.length + outputIndexBytes.length);
    messageBuffer.set(txHashBytes, 0);
    messageBuffer.set(outputIndexBytes, txHashBytes.length);

    const hash = sha3_256(messageBuffer);
    const state_token_name = encodeHex(new Uint8Array(hash));

    const redeemer: Redeemer = Data.to(new Constr(1, []));
    const withdrawRedeemer: Redeemer = version === 2 ? Data.to({
      token_name: encodeHex("ProxyMintToken"),
      password: encodeHex("Hello, World!"),
    }, WithdrawalRedeemerV1) : Data.to({
      invalid_token_name: encodeHex("InvalidToken"),
    }, WithdrawalRedeemerV2);

    const utxos = await lucid.utxosAtWithUnit(validatorToAddress('Preprod', proxyValidator), toUnit(proxyPolicyId, state_token_name));
    const stateUtxo = utxos[0];

    const datum = Data.to({
      script_pointer: String(validatorToScriptHash(upgradableLogicValidator_next)),
      script_owner: String(paymentCredential?.hash!),
    }, ProxyDatum)

    const tx = await lucid.newTx()
        .collectFrom([stateUtxo!], redeemer)
        .pay.ToContract(validatorToAddress('Preprod', proxyValidator), { kind: 'inline', value: datum }, { [toUnit(proxyPolicyId, state_token_name)]: 1n })
        .attach.SpendingValidator(proxyValidator)
        .attach.WithdrawalValidator(upgradableLogicValidator_current)
        .register.Stake(validatorToRewardAddress('Preprod', upgradableLogicValidator_next))
        .withdraw(validatorToRewardAddress('Preprod', upgradableLogicValidator_current), 0n, withdrawRedeemer)
        .addSigner(address);

    try {
      const unsignedTx = await tx.complete();
      const signedTx = await unsignedTx.sign.withWallet();
      const txHash = await (await signedTx.complete()).submit();
      console.log(`Successfully upgraded the minting logic of ${proxyPolicyId} to logic version ${nextVersion}.\n
      See: https://preprod.cexplorer.io/tx/${txHash}`);
    } catch (error) {
      console.error("Error while submitting transaction:", error);
      Deno.exit(1);
    }
  } else {
    console.log("Unsupported version. Only version 1 and 2 are supported.");
    return;
  }  
}

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
  } else if (Deno.args[0] === 'mint') {
    const txHash = Deno.args[1];
    const outputIndex = Number(Deno.args[2]);
    const version = Number(Deno.args[3]);
    if (!txHash || isNaN(outputIndex) || isNaN(version)) {
      console.log('For minting, please provide the transaction hash, output index, and version number.');
      console.log('Example usage: deno run -A proxy.ts mint <txHash> <outputIndex> <version>');
    } else {
      await mint(txHash, outputIndex, version);
    }
  } else if (Deno.args[0] === 'upgrade') {
    const txHash = Deno.args[1];
    const outputIndex = Number(Deno.args[2]);
    const version = Number(Deno.args[3]);
    if (!txHash || isNaN(outputIndex) || isNaN(version)) {
      console.log('For upgrading, please provide the transaction hash, output index, and version number.');
      console.log('Example usage: deno run -A proxy.ts upgrade <txHash> <outputIndex> <version>');
    } else {
      await upgrade(txHash, outputIndex, version);
    }
  } else {
    console.log('Invalid argument. Allowed arguments are "init", "prepare", "mint", or "upgrade".');
    console.log('Example usage: deno run -A proxy.ts prepare');
  }
} else {
  console.log('Expected an argument. Allowed arguments are "init", "prepare", "mint", or "upgrade".');
  console.log('Example usage: deno run -A proxy.ts prepare');
}


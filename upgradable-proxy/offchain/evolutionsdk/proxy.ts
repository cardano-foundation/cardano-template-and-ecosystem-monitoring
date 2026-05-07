import { Lucid, Koios, generateSeedPhrase, validatorToAddress, Data, applyParamsToScript, Constr, validatorToScriptHash, Script, Redeemer, toUnit, validatorToRewardAddress } from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };
import { encodeHex } from "@std/encoding/hex";
import { ProxyDatum, WithdrawalRedeemerV1, WithdrawalRedeemerV2 } from "./types.ts";
import { getStateTokenName, getUserUtxo, prepareProvider, resolveVersion } from "./helper.ts";

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

async function initProxy() {
  const { lucid, address, paymentCredential } = await prepareProvider();

  const userUtxo = await getUserUtxo(lucid, address);

  if (!userUtxo) {
    console.error("No UTxO with enough funds found in the selected wallet. Please fund the wallet and try again.");
    Deno.exit(1);
  }

  const outputReference = new Constr(0, [userUtxo.txHash, BigInt(userUtxo.outputIndex)]);

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

  const redeemer: Redeemer = Data.to(new Constr(1, []));
  const stateTokenName = getStateTokenName(userUtxo.txHash, userUtxo.outputIndex);
  const tokenUnit = toUnit(proxyPolicyId, stateTokenName)

  const tx = await lucid.newTx()
      .collectFrom([userUtxo!], Data.void())
      .mintAssets({ [tokenUnit]: 1n }, redeemer)
      .register.Stake(validatorToRewardAddress('Preprod', upgradableLogicValidator))
      .pay.ToContract(validatorToAddress('Preprod', proxyValidator), { kind: 'inline', value: datum }, { [tokenUnit]: 1n }, proxyValidator)
      .attach.MintingPolicy(proxyValidator)
      .attach.CertificateValidator(upgradableLogicValidator)
      .addSigner(address);

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully setup a proxy contract pointing to ${address}.\n
    See: https://preprod.cexplorer.io/tx/${txHash}`);
    console.log(`Proxy Script Address: ${validatorToAddress('Preprod', proxyValidator)}`);
    console.log(`The utxo reference for this parameterized script is: ${userUtxo.txHash}#${userUtxo.outputIndex}`);
    console.log(`You can now use this utxo reference to mint new tokens via the proxy contract.`);
    console.log(`Example usage: deno run -A proxy.ts mint ${tokenUnit}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
};

async function mint(tokenUnit: string) {
  const { lucid, address } = await prepareProvider();

  const utxo = await lucid.utxoByUnit(tokenUnit);

  if (!utxo) {
    console.error("No UTxO found for the provided token unit. Sometimes you need to wait (around 20 seconds) until the transaction is on the blockchain.");
    Deno.exit(1);
  }

  const proxyValidator: Script = utxo.scriptRef!;
  const upgradableLogicScriptHash = Data.from(utxo.datum!, ProxyDatum).script_pointer;

  const proxyPolicyId = validatorToScriptHash(proxyValidator);
  
  console.log(`Using proxy policy ID: ${proxyPolicyId}`);

  // apply parameters script hash of the first script to the logic script
  const { version, script: upgradableLogicValidator } = resolveVersion(upgradableLogicScriptHash, proxyPolicyId);

  const redeemer: Redeemer = Data.to(new Constr(0, []));
  const withdrawRedeemer: Redeemer = version === 1 ? Data.to({
    token_name: encodeHex("ProxyMintToken"),
    password: encodeHex("NoPassword"),
  }, WithdrawalRedeemerV1) : Data.to({
    invalid_token_name: encodeHex("InvalidToken"),
  }, WithdrawalRedeemerV2);

  const tx = await lucid.newTx()
      .readFrom([utxo])
      .mintAssets({ [toUnit(proxyPolicyId, encodeHex("ProxyMintToken"))]: 1n }, redeemer)
      .withdraw(validatorToRewardAddress('Preprod', upgradableLogicValidator), 0n, withdrawRedeemer)
      .attach.MintingPolicy(proxyValidator)
      .attach.WithdrawalValidator(upgradableLogicValidator)
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
}

async function changeVersion(tokenUnit: string) {
  const { lucid, address, paymentCredential } = await prepareProvider();

  const utxo = await lucid.utxoByUnit(tokenUnit);

  if (!utxo) {
    console.error("No UTxO found for the provided token unit. Sometimes you need to wait (around 20 seconds) until the transaction is on the blockchain.");
    Deno.exit(1);
  }

  const proxyValidator: Script = utxo.scriptRef!;
  const upgradableLogicScriptHash = Data.from(utxo.datum!, ProxyDatum).script_pointer;

  const proxyPolicyId = validatorToScriptHash(proxyValidator);
  
  console.log(`Using proxy policy ID: ${proxyPolicyId}`);

  // apply parameters script hash of the first script to the logic script
  const { version: currentVersion } = resolveVersion(upgradableLogicScriptHash, proxyPolicyId);
  const nextVersion = currentVersion === 1 ? 2 : 1;

  if (currentVersion === 2) {
    console.log(`The upgradable logic is already version (v2) and will now be downgraded to version (v1).`);
  } else {
    console.log(`The upgradable logic is currently version (v1) and will now be upgraded to version (v2).`);
  }

  // apply parameters script hash of the first script to the logic script
  const upgradableLogicValidator_current: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find(validator => validator.title.startsWith(`script_logic_v_${currentVersion}`))!.compiledCode,
      [proxyPolicyId]
    ),
  };

  const upgradableLogicValidator_next: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find(validator => validator.title.startsWith(`script_logic_v_${nextVersion}`))!.compiledCode,
      [proxyPolicyId]
    ),
  };

  const redeemer: Redeemer = Data.to(new Constr(1, []));
  const withdrawRedeemer: Redeemer = currentVersion === 1 ? Data.to({
    token_name: encodeHex("ProxyMintToken"),
    password: encodeHex("Hello, World!"),
  }, WithdrawalRedeemerV1) : Data.to({
    invalid_token_name: encodeHex("InvalidToken"),
  }, WithdrawalRedeemerV2);

  const utxos = await lucid.utxosAtWithUnit(validatorToAddress('Preprod', proxyValidator), tokenUnit);
  const stateUtxo = utxos[0];

  const datum = Data.to({
    script_pointer: String(validatorToScriptHash(upgradableLogicValidator_next)),
    script_owner: String(paymentCredential?.hash!),
  }, ProxyDatum)

  let tx = await lucid.newTx()
      .collectFrom([stateUtxo!], redeemer)
      .pay.ToContract(validatorToAddress('Preprod', proxyValidator), { kind: 'inline', value: datum }, { [tokenUnit]: 1n }, proxyValidator)
      .attach.SpendingValidator(proxyValidator)
      .attach.WithdrawalValidator(upgradableLogicValidator_current)
      .withdraw(validatorToRewardAddress('Preprod', upgradableLogicValidator_current), 0n, withdrawRedeemer)
      .addSigner(address);

  if (currentVersion === 1) {
    tx = tx.register.Stake(validatorToRewardAddress('Preprod', upgradableLogicValidator_next));
  }

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    if (currentVersion === 1) {
      console.log(`Successfully upgraded the minting logic of ${proxyPolicyId} to logic version ${nextVersion}.\n
      See: https://preprod.cexplorer.io/tx/${txHash}`);
    } else {
      console.log(`Successfully downgraded the minting logic of ${proxyPolicyId} to logic version ${nextVersion}.\n
      See: https://preprod.cexplorer.io/tx/${txHash}.\n
      Note that the stake registration remains on-chain and a re-registration might cause an issue.`);
    }
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
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
    const tokenUnit = Deno.args[1];
    if (!tokenUnit) {
      console.log('For minting, please provide the token unit.');
      console.log('Example usage: deno run -A proxy.ts mint <tokenUnit>');
    } else {
      await mint(tokenUnit);
    }
  } else if (Deno.args[0] === 'change-version') {
    const tokenUnit = Deno.args[1];
    if (!tokenUnit) {
      console.log('For upgrading, please provide the token unit.');
      console.log('Example usage: deno run -A proxy.ts change-version <tokenUnit>');
    } else {
      await changeVersion(tokenUnit);
    }
  } else {
    console.log('Invalid argument. Allowed arguments are "init", "prepare", "mint", or "change-version".');
    console.log('Example usage: deno run -A proxy.ts prepare');
  }
} else {
  console.log('Expected an argument. Allowed arguments are "init", "prepare", "mint", or "change-version".');
  console.log('Example usage: deno run -A proxy.ts prepare');
}


import { MeshWallet, KoiosProvider, 
  serializePlutusScript, resolvePaymentKeyHash, Transaction, largestFirst, 
  Asset} from 'npm:@meshsdk/core';
import { applyParamsToScript, deserializeAddress } from 'npm:@meshsdk/core-cst';
import { builtinByteString, list, PlutusScript } from "npm:@meshsdk/common";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

function createWallet () {
  const mnemonic = MeshWallet.brew();
  if (typeof mnemonic === 'string') {
    return mnemonic.split(' ');
  }
  return mnemonic
}

async function prepare (payeeAmount: number) {
  let mnemonic = createWallet();
  const koiosProvider = new KoiosProvider('preprod');
  
  const addresses = [];
  for (let i = 0; i < payeeAmount; i++) {
    const wallet = new MeshWallet({
        networkId: 0,
        fetcher: koiosProvider,
        submitter: koiosProvider,
        key: {
            type: 'mnemonic',
            words: mnemonic,
        },
    });
    await wallet.init();
    const address = await wallet.getChangeAddress();
    addresses.push(address);
    Deno.writeTextFileSync(`payee_${i}.txt`, JSON.stringify(mnemonic));
    mnemonic = createWallet();
  }
  console.log(`Successfully prepared ${payeeAmount} payees (seed phrases).`);
  console.log(`Make sure to send some tADA to the payee ${addresses[0]} 
  as this payee will be used in this example, to submit the transaction. 
  Therefore enough tAda for covering fees and to provide a collateral will be needed.`);
}

async function setup () {
  const koiosProvider = new KoiosProvider('preprod');
  const mnemonic = JSON.parse(Deno.readTextFileSync("payee_0.txt"));

  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: koiosProvider,
    submitter: koiosProvider,
    key: {
      type: 'mnemonic',
      words: mnemonic,
    },
  });
  await wallet.init();
  const files = Deno.readDirSync('.')

  const payeeSeeds = [];
  for (const file of files) {
    if (file.name.match(/payee_[0-9]+.txt/) !== null) {
      payeeSeeds.push(file.name);
    }
  }

  const payees = [];
  for (const payeeSeed of payeeSeeds) {
    const seed = JSON.parse(Deno.readTextFileSync(payeeSeed));
    const payee = new MeshWallet({
      networkId: 0,
      fetcher: koiosProvider,
      submitter: koiosProvider,
      key: {
        type: 'mnemonic',
        words: seed,
      },
    });
    await payee.init();
    payees.push(await payee.getChangeAddress());
  }

  const plutusData = list(
    payees.map((payee) => {
      const paymentCredential = deserializeAddress(payee).asBase()?.getPaymentCredential().hash
      if (paymentCredential) {
        return builtinByteString(paymentCredential)
      }
  }));
  
  const parameterizedScript = applyParamsToScript(
          blueprint.validators[0].compiledCode,
          [plutusData],
          "JSON",
        );

  const script: PlutusScript = {
    code: parameterizedScript,
    version: "V3",
  };
  const scriptAddress = serializePlutusScript(script, undefined, 0);

  return {
    koiosProvider,
    wallet,
    scriptAddress,
    script,
    payees
  }
}

async function lockAda(lovelaceAmount: string) {
  const { wallet, scriptAddress } = await setup();
  const paymentAddress = await wallet.getChangeAddress();

  const hash = resolvePaymentKeyHash(paymentAddress);
  const datum = {
      alternative: 0,
      fields: [hash],
  };

  const tx = new Transaction({ initiator: wallet }).sendLovelace(
      {
      address: scriptAddress.address,
      datum: { value: datum }
      },
      lovelaceAmount
  );

  const unsignedTx = await tx.build();
  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);
  console.log(`Successfully locked ${lovelaceAmount} lovelace to the script address ${scriptAddress}.\n
  See: https://preprod.cexplorer.io/tx/${txHash}`);
};

async function unlockAda () {
  const { koiosProvider, wallet, scriptAddress, script, payees } = await setup();
  const utxos = await koiosProvider.fetchAddressUTxOs(scriptAddress.address);
  const paymentAddress = await wallet.getChangeAddress();

  const lovelaceForCollateral = "6000000";
  const collateralUtxos = largestFirst(lovelaceForCollateral, await koiosProvider.fetchAddressUTxOs(paymentAddress));
  const pubKeyHash = deserializeAddress(await wallet.getChangeAddress()).asBase()?.getPaymentCredential().hash || '';
  const datum = {
    alternative: 0,
    fields: [pubKeyHash],
  };

  const redeemerData = "Hello, World!";
  const redeemer = { data: { alternative: 0, fields: [redeemerData] } };

  let tx = new Transaction({ initiator: wallet, fetcher: koiosProvider, verbose: true });
  let split = 0;
  for (const utxo of utxos) {
    const amount: Asset[] = utxo.output?.amount;
    if (amount) {
      const lovelace = amount.find((asset) => asset.unit === 'lovelace');
      if (lovelace) {
        split += Math.floor(Number(lovelace.quantity) / payees.length);
      }

      tx = tx.redeemValue({
        value: utxo,
        script: script,
        datum: datum,
        redeemer: redeemer,
      })
    }
  }

  tx = tx.setCollateral(collateralUtxos);
  for (const payee of payees) {   
      tx = tx.sendLovelace(
          payee,
          split.toString()
      )
  }

  tx = tx.setRequiredSigners([paymentAddress]);
  const unsignedTx = await tx.build();
  try {
    const signedTx = await wallet.signTx(unsignedTx, true);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`Successfully unlocked the lovelace from the script address ${scriptAddress} and split it equally (${split} Lovelace) to all payees.\n
    See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.warn(error);
  }
};

const isPositiveNumber = (s: string) => Number.isInteger(Number(s)) && Number(s) > 0

if (Deno.args.length > 0) {
  if (Deno.args[0] === 'lock') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      await lockAda(Deno.args[1]);
    } else {
      console.log('Expected a positive number (lovelace amount) as the second argument.');
      console.log('Example usage: node use-payment-splitter.js lock 10000000');
    } 
  } else if (Deno.args[0] === 'unlock') {
    await unlockAda();
  } else if (Deno.args[0] === 'prepare') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      const files = Deno.readDirSync('.')
      const payeeSeeds = [];
      for (const file of files) {
        if (file.name.match(/payee_[0-9]+.txt/) !== null) {
          payeeSeeds.push(file.name);
        }
      }

      if (payeeSeeds.length > 0) {
        console.log('Seed phrases (files with format payee_[0-9]+.txt) already exist. Please remove them before preparing new ones.');
      } else {
        await prepare(parseInt(Deno.args[1]));
      }
    } else {
      console.log('Expected a positive number (of seed phrases to prepare) as the second argument.');
      console.log('Example usage: node use-payment-splitter.js prepare 5');
    }    
  } else {
    console.log('Invalid argument. Allowed arguments are "lock", "unlock" or "prepare".');
    console.log('Example usage: node use-payment-splitter.js prepare');
  }
} else {
  console.log('Expected an argument. Allowed arguments are "lock", "unlock" or "prepare".');
  console.log('Example usage: node use-payment-splitter.js prepare 5');
}


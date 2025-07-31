import { Lucid, Koios, assetsToValue, generateSeedPhrase, validatorToAddress, validatorToScriptHash, Validator, toUnit, fromText, getAddressDetails, Data, LucidEvolution } from "@evolution-sdk/lucid";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const BetDatumSchema = Data.Object({
  player1: Data.Bytes(),
  player2: Data.Bytes(),
  oracle: Data.Bytes(),
  expiration: Data.Integer(),
});
type BetDatum = Data.Static<typeof BetDatumSchema>;
const BetDatum = BetDatumSchema as unknown as BetDatum;

async function prepare (amount: number) {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );

  const addresses = [];
  for (let i = 0; i < amount; i++) {
    const mnemonic = generateSeedPhrase();
    lucid.selectWallet.fromSeed(mnemonic);
    const address = await lucid.wallet().address();
    addresses.push(address);
    Deno.writeTextFileSync(`wallet_${i}.txt`, mnemonic);
  }
  console.log(`Successfully prepared ${amount} wallet (seed phrases).`);
  console.log(`Make sure to send some tADA to the wallet ${addresses[0]} 
  as this wallet will be used in this example, to submit the transaction. 
  Therefore enough tAda for covering fees and to provide a collateral will be needed.`);
}

function selectWallet (lucid: LucidEvolution, index: number) {
  const mnemonic = Deno.readTextFileSync(`wallet_${index}.txt`);
  lucid.selectWallet.fromSeed(mnemonic);
}

async function setup () {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
  selectWallet(lucid, 0);
  const files = Deno.readDirSync('.')

  const seeds = [];
  for (const file of files) {
    if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
      seeds.push(file.name);
    }
  }
  
  const validator: Validator = {
    type: "PlutusV3",
    script: blueprint.validators[0].compiledCode,
  };

  const scriptAddress = validatorToAddress("Preprod", validator);

  return {
    lucid,
    scriptAddress,
    validator,
  }
}

async function initBet(lovelaceAmount: string) {
  const { lucid, scriptAddress, validator } = await setup();

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);

  selectWallet(lucid, 2);
  const oracleAddress = await lucid.wallet().address();
  const { paymentCredential: oraclePaymentCredential } = getAddressDetails(oracleAddress);

  const datum = Data.to({
    player1: paymentCredential?.hash || '',
    player2: "",
    oracle: oraclePaymentCredential?.hash || '',
    expiration: BigInt(Date.now() + 60 * 60 * 24 * 5 * 1000),
  }, BetDatum)

  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, fromText("LuckyNumberSlevin"));

  selectWallet(lucid, 0);
  const tx = await lucid.newTx()
      .attach.MintingPolicy(validator)
      .mintAssets({
        [unit]: 1n
      }, Data.void())
      .pay.ToContract(
        scriptAddress,
        { kind: "inline", value: datum },
        { 
          lovelace: BigInt(lovelaceAmount),
          [unit]: 1n,
        },
      )
      .addSigner(address)
      .validFrom(Date.now() - 60_000) // 1 minute ago
      .validTo(Date.now() + 600_000); // 10 minutes from now

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully locked ${lovelaceAmount} lovelace to the script address ${scriptAddress}.\n
    See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
};

async function joinBet(transactionId: string) {
  const { lucid, scriptAddress, validator } = await setup();

  selectWallet(lucid, 2);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);

  const utxos = await lucid.utxosByOutRef([{ txHash: transactionId, outputIndex: 0 }]);
  if (utxos.length === 0) {
    console.error(`No UTXOs found for transaction ID: ${transactionId}`);
    return;
  }

  const utxo = utxos[0];
  if (!utxo.datum) {
    console.error(`UTXO with transaction ID ${transactionId} does not have a datum.`);
    return;
  }

  const bet = Data.from(utxo.datum, BetDatum);
  bet.player2 = paymentCredential?.hash || '';
  const datum = Data.to(bet, BetDatum)

  const values = assetsToValue(utxo.assets);
  const lovelaceAmount = values.coin() * BigInt(2);

  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, fromText("LuckyNumberSlevin"));

  const tx = await lucid.newTx()
      .attach.SpendingValidator(validator)
      .collectFrom([utxo], Data.void())
      .pay.ToContract(
        scriptAddress,
        { kind: "inline", value: datum },
        { 
          lovelace: lovelaceAmount,
          [unit]: 1n,
        },
      )
      .addSigner(address)
      .validFrom(Date.now() - 60_000) // 1 minute ago
      .validTo(Date.now() + 600_000); // 10 minutes from now

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully joined the bet with transaction ID ${transactionId}.\n
    See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}


const isPositiveNumber = (s: string) => Number.isInteger(Number(s)) && Number(s) > 0

if (Deno.args.length > 0) {
  if (Deno.args[0] === 'init') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      await initBet(Deno.args[1]);
    } else {
      console.log('Expected a positive number (lovelace amount) as the second argument.');
      console.log('Example usage: node use-payment-splitter.js lock 10000000');
    } 
  } else if (Deno.args[0] === 'join') {
    if (Deno.args.length > 1 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      await joinBet(Deno.args[1]);
    } else {
      console.log('Expected a valid transaction ID as the second argument.');
      console.log('Example usage: node use-payment-splitter.js join 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5');
    }
  } else if (Deno.args[0] === 'prepare') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      const files = Deno.readDirSync('.');
      const seeds = [];
      for (const file of files) {
        if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
          seeds.push(file.name);
        }
      }

      if (seeds.length > 0) {
        console.log('Seed phrases (files with format wallet_[0-9]+.txt) already exist. Please remove them before preparing new ones.');
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


import {
  Lucid,
  Koios,
  assetsToValue,
  generateSeedPhrase,
  validatorToAddress,
  validatorToScriptHash,
  Validator,
  toUnit,
  fromText,
  getAddressDetails,
  Data,
  LucidEvolution,
} from '@evolution-sdk/lucid';

// Blueprint is loaded lazily inside setup() to allow running commands
// like `prepare` without requiring the compiled Aiken artifact.

const AuctionDatumSchema = Data.Object({
  seller: Data.Bytes(),
  highest_bidder: Data.Bytes(),
  highest_bid: Data.Integer(),
  expiration: Data.Integer(),
  asset_policy: Data.Bytes(),
  asset_name: Data.Bytes(),
});
type AuctionDatum = Data.Static<typeof AuctionDatumSchema>;
const AuctionDatum = AuctionDatumSchema as unknown as AuctionDatum;

async function prepare(amount: number) {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod'
  );

  const addresses: string[] = [];
  for (let i = 0; i < amount; i++) {
    const mnemonic = generateSeedPhrase();
    lucid.selectWallet.fromSeed(mnemonic);
    const address = await lucid.wallet().address();
    addresses.push(address);
    Deno.writeTextFileSync(`wallet_${i}.txt`, mnemonic);
  }
  console.log(`Successfully prepared ${amount} wallet (seed phrases).`);
  console.log(`Fund wallet ${addresses[0]} with tADA for fees and collateral.`);
}

function selectWallet(lucid: LucidEvolution, index: number) {
  const mnemonic = Deno.readTextFileSync(`wallet_${index}.txt`);
  lucid.selectWallet.fromSeed(mnemonic);
}

async function setup() {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod'
  );
  selectWallet(lucid, 0);
  let compiledCode: string;
  try {
    const jsonUrl = new URL('../../onchain/aiken/plutus.json', import.meta.url);
    await Deno.stat(jsonUrl); // ensure file exists

    // Read and parse JSON directly instead of using dynamic import with assertions
    const blueprintText = await Deno.readTextFile(jsonUrl);
    const blueprint = JSON.parse(blueprintText);
    const validators =
      (blueprint as any).default?.validators ?? (blueprint as any).validators;
    compiledCode = validators[0].compiledCode;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error(
        'Missing Aiken blueprint (plutus.json). Please compile the auction Aiken project:'
      );
      console.error(
        '1) Install Aiken, 2) cd auction/onchain/aiken, 3) aiken build'
      );
      throw e;
    }
    console.error('Failed to load Aiken blueprint (plutus.json):', e);
    throw e;
  }
  const validator: Validator = {
    type: 'PlutusV3',
    script: compiledCode,
  };

  const scriptAddress = validatorToAddress('Preprod', validator);

  return {
    lucid,
    scriptAddress,
    validator,
  };
}

async function initAuction(startingBidLovelace: string) {
  const { lucid, scriptAddress, validator } = await setup();

  const sellerAddress = await lucid.wallet().address();
  const { paymentCredential: sellerPc } = getAddressDetails(sellerAddress);

  const policy = validatorToScriptHash(validator);
  const assetNameText = 'auction_nft';
  const unit = toUnit(policy, fromText(assetNameText));

  const datum = Data.to(
    {
      seller: sellerPc?.hash || '',
      highest_bidder: '',
      highest_bid: BigInt(startingBidLovelace),
      expiration: BigInt(Date.now() + 3 * 24 * 60 * 60 * 1000), // +3 days
      asset_policy: policy,
      asset_name: fromText(assetNameText),
    },
    AuctionDatum
  );

  const tx = await lucid
    .newTx()
    .attach.MintingPolicy(validator)
    .mintAssets({ [unit]: 1n }, Data.void())
    .pay.ToContract(
      scriptAddress,
      { kind: 'inline', value: datum },
      {
        lovelace: BigInt(startingBidLovelace),
        [unit]: 1n,
      }
    )
    .addSigner(sellerAddress)
    .validFrom(Date.now() - 60_000)
    .validTo(Date.now() + 600_000);

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(
      `Auction initialized at ${scriptAddress} with starting bid ${startingBidLovelace} lovelace.\nSee: https://preprod.cexplorer.io/tx/${txHash}`
    );
    console.log(
      `To bid: deno run -A auction.ts bid ${txHash} <newBidLovelace>`
    );
  } catch (error) {
    console.error('Error while submitting init transaction:', error);
    Deno.exit(1);
  }
}

async function bidAuction(auctionTxId: string, newBidLovelace: string) {
  console.log(`Placing bid on auction UTXO from tx: ${auctionTxId}`);
  const { lucid, scriptAddress, validator } = await setup();

  // Use bidder wallet index 1
  selectWallet(lucid, 1);
  const bidderAddress = await lucid.wallet().address();
  const { paymentCredential: bidderPc } = getAddressDetails(bidderAddress);
  console.log(`Using bidder address: ${bidderAddress}`);

  let utxos: any[] = [];
  try {
    utxos = await lucid.utxosByOutRef([
      { txHash: auctionTxId, outputIndex: 0 },
    ]);
  } catch (error) {
    console.error(
      `Error fetching UTXOs for transaction ID ${auctionTxId}:`,
      error
    );
    return;
  }

  if (utxos.length === 0) {
    console.error(`No UTXOs found for transaction ID: ${auctionTxId}`);
    return;
  }

  const utxo = utxos[0];
  if (!utxo.datum) {
    console.error(`UTXO ${auctionTxId} has no inline datum.`);
    return;
  }

  const auction = Data.from(utxo.datum, AuctionDatum) as any;

  const currentBid: bigint = BigInt(auction.highest_bid);
  const nextBid: bigint = BigInt(newBidLovelace);
  if (nextBid <= currentBid) {
    console.error(
      `New bid must be greater than current highest bid (${currentBid}).`
    );
    return;
  }

  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, auction.asset_name);

  auction.highest_bidder = bidderPc?.hash || '';
  auction.highest_bid = nextBid;

  const datum = Data.to(auction, AuctionDatum);

  const tx = await lucid
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], Data.void())
    .pay.ToContract(
      scriptAddress,
      { kind: 'inline', value: datum },
      {
        lovelace: nextBid,
        [unit]: 1n,
      }
    )
    .addSigner(bidderAddress)
    .validFrom(Date.now() - 60_000)
    .validTo(Date.now() + 600_000);

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(
      `Successfully placed bid of ${nextBid} lovelace.\nSee: https://preprod.cexplorer.io/tx/${txHash}`
    );
  } catch (error) {
    console.error('Error while submitting bid transaction:', error);
    Deno.exit(1);
  }
}

const isPositiveNumber = (s: string) =>
  Number.isInteger(Number(s)) && Number(s) > 0;
const isTxId = (s: string) => /^[0-9a-fA-F]{64}$/.test(s);

if (Deno.args.length > 0) {
  if (Deno.args[0] === 'prepare') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      const files = Deno.readDirSync('.');
      const seeds: string[] = [];
      for (const file of files) {
        if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
          seeds.push(file.name);
        }
      }
      if (seeds.length > 0) {
        console.log(
          'Seed phrases already exist. Remove wallet_*.txt before preparing new ones.'
        );
      } else {
        await prepare(parseInt(Deno.args[1]));
      }
    } else {
      console.log(
        'Expected a positive number (seed phrases to prepare). Example: deno run -A auction.ts prepare 3'
      );
    }
  } else if (Deno.args[0] === 'init') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      await initAuction(Deno.args[1]);
    } else {
      console.log(
        'Expected a positive number (starting bid in lovelace). Example: deno run -A auction.ts init 3000000'
      );
    }
  } else if (Deno.args[0] === 'bid') {
    if (
      Deno.args.length > 2 &&
      isTxId(Deno.args[1]) &&
      isPositiveNumber(Deno.args[2])
    ) {
      await bidAuction(Deno.args[1], Deno.args[2]);
    } else {
      console.log(
        'Usage: deno run -A auction.ts bid <TX_ID> <NEW_BID_LOVELACE>'
      );
    }
  } else {
    console.log('Invalid argument. Allowed arguments: prepare, init, bid.');
  }
} else {
  console.log('Expected an argument. Allowed: prepare, init, bid.');
}

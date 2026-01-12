import {
  MeshWallet,
  MeshTxBuilder,
  KoiosProvider,
  deserializeAddress,
  mConStr0,
  mConStr2,
  resolvePlutusScriptAddress,
  deserializeDatum,
  stringToHex,
} from "@meshsdk/core";
import { bech32 } from "npm:bech32";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const PREPROD_SYSTEM_START = 1655683200000;
const SLOT_LENGTH = 1000;

function getSlotFromTime(timeVal: number): number {
    return Math.floor((timeVal - PREPROD_SYSTEM_START) / SLOT_LENGTH);
}

function getTimeFromSlot(slot: number): number {
    return (slot * SLOT_LENGTH) + PREPROD_SYSTEM_START;
}

export const setup = async (walletName: string | number = 0) => {
  const provider = new KoiosProvider("preprod");
  
  let prefix = "";
  try {
    await Deno.stat("auction/offchain/meshjs");
    prefix = "auction/offchain/meshjs/";
  } catch {
    prefix = "";
  }

  const fileName = typeof walletName === 'number' 
      ? `${prefix}wallet_${walletName}.txt`
      : `${prefix}${walletName}`;
  let wallet;
  try {
    const mnemonic = await Deno.readTextFile(fileName);
    wallet = new MeshWallet({
      networkId: 0,
      fetcher: provider,
      submitter: provider,
      key: {
        type: "mnemonic",
        words: mnemonic.trim().split(" "),
      },
    });
  } catch (_e) {
    console.log("No wallet found, generating new one...");
    const mnemonic = MeshWallet.brew();
    await Deno.writeTextFile(fileName, Array.isArray(mnemonic) ? mnemonic.join(" ") : mnemonic);
    wallet = new MeshWallet({
    networkId: 0,
    fetcher: provider,
    submitter: provider,
    key: {
        type: "mnemonic",
        words: Array.isArray(mnemonic) ? mnemonic : mnemonic.split(" "),
    },
    });
    console.log(`Generated ${fileName}. Send some tADA to: ` + (await wallet.getUnusedAddresses())[0]);
  }
  return { provider, wallet };
};

export class AuctionContract {
  provider: KoiosProvider;
  wallet: MeshWallet;
  scriptCbor!: string;
  scriptAddress!: string;
  policyId!: string;
  
  constructor(provider: KoiosProvider, wallet: MeshWallet) {
    this.provider = provider;
    this.wallet = wallet;
    
    // @ts-ignore blueprint structure
    const validator = blueprint.validators[0];
    const originalCode = validator.compiledCode;
    const len = originalCode.length / 2;
    const lenHex = len.toString(16).padStart(4, '0');
    // Double encoding: CBOR(Bytes( CBOR(Bytes(Flat)) ))? Or CBOR(Bytes(Flat))
    // Assuming Aiken gives CBOR(Bytes(Flat)). Node wants Single Wrapped.
    // If Trace said "CBOR deserialisation failed at offset 0 ... bytes malformed".
    // It might be conflicting.
    this.scriptCbor = "59" + lenHex + originalCode;
    
    this.scriptAddress = resolvePlutusScriptAddress({
        code: this.scriptCbor,
        version: "V3"
    }, 0);
    
    this.policyId = deserializeAddress(this.scriptAddress).scriptHash;
  }

  async getCurrentSlot(): Promise<number> {
    try {
        const response = await fetch('https://preprod.koios.rest/api/v1/tip');
        const data = await response.json();
        return Number(data[0].abs_slot);
    } catch (error) {
        console.error("Failed to fetch tip, fallback to local clock", error);
        return getSlotFromTime(Date.now());
    }
  }

  /**
   * Initialize a new auction.
   * Mints an auction token and sends it to the script address with the initial datum.
   */
  async init(startingBid: string) {
    const address = (await this.wallet.getUnusedAddresses())[0];
    const { pubKeyHash } = deserializeAddress(address);
    const assetName = "auction_nft";
    const assetNameHex = stringToHex(assetName);

    const currentSlot = await this.getCurrentSlot();
    const expirationSlot = currentSlot + 1000;
    const expirationTime = getTimeFromSlot(expirationSlot);
    
    console.log(`\n🎰 Starting a New Auction!`);
    console.log(`🕒 Closing time: ${new Date(expirationTime).toLocaleString()} (Slot: ${expirationSlot})`);

    // Construct Datum
    // AuctionDatum { seller, highest_bidder, highest_bid, expiration, asset_policy, asset_name }
    const datum = mConStr0([
        pubKeyHash,
        "",
        parseInt(startingBid),
        expirationTime,
        this.policyId,
        assetNameHex
    ]);

    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, submitter: this.provider, evaluator: this.provider });
    
    const collateral = (await this.wallet.getCollateral())[0];
    if (collateral) {
        txBuilder.txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address
        );
    } else {
        console.warn("No Collateral found! Transaction might fail.");
    }

    const utxos = await this.wallet.getUtxos();
    const freshUtxos = await this.provider.fetchAddressUTxOs(address);
    txBuilder.selectUtxosFrom(freshUtxos);

    txBuilder.mintPlutusScriptV3()
        .mint("1", this.policyId, assetNameHex)
        .mintingScript(this.scriptCbor)
        .mintRedeemerValue(mConStr0([]));
    
    txBuilder.txOut(this.scriptAddress, [
        { unit: "lovelace", quantity: startingBid },
        { unit: this.policyId + assetNameHex, quantity: "1" }
    ])
    .txOutInlineDatumValue(datum);

    txBuilder
        .changeAddress(address)
        .requiredSignerHash(pubKeyHash)
        .invalidHereafter(expirationSlot);

    const unsignedTx = await txBuilder.complete();
    //console.log("Unsigned Tx:", JSON.stringify(unsignedTx, null, 2));
    const signedTx = await this.wallet.signTx(unsignedTx);
    
    console.log(`🚀 Sending transaction to the blockchain...`);
    const txHash = await this.wallet.submitTx(signedTx);
    
    console.log(`✨ Auction Initialized!`);
    console.log(`📜 Transaction ID: ${txHash}`);
    console.log(`🏠 Auction House Address: ${this.scriptAddress}\n`);
    return txHash;
  }

  /**
   * Place a bid on an existing auction.
   */
  async bid(auctionTxHash: string, newBidAmount: string) {
    const address = (await this.wallet.getUnusedAddresses())[0];
    const { pubKeyHash } = deserializeAddress(address);

    const utxos = await this.provider.fetchAddressUTxOs(this.scriptAddress);
    const scriptUtxo = utxos.find(u => u.input.txHash === auctionTxHash && u.input.outputIndex === 0);
    
    if (!scriptUtxo) {
        throw new Error("❌ Auction not found! Are you sure the Transction ID is correct and the auction hasn't ended?");
    }

    if (!scriptUtxo.output.plutusData) {
        throw new Error("❌ Fatal: The auction data seems corrupted (missing datum).");
    }

    const oldDatum = deserializeDatum(scriptUtxo.output.plutusData);
    const fields = oldDatum.fields;
    
    // @ts-ignore type check
    const seller = fields[0].bytes;
    
    // @ts-ignore type check
    const rawBidder = fields[1];
    const currentHighestBidder = (typeof rawBidder === 'object' && 'bytes' in rawBidder) ? rawBidder.bytes : rawBidder;

    // @ts-ignore type check
    const currentHighestBid = Number(fields[2].int);
    // @ts-ignore type check
    const expiration = Number(fields[3].int);
    
    // @ts-ignore type check
    const rawPolicy = fields[4];
    const assetPolicy = (typeof rawPolicy === 'object' && 'bytes' in rawPolicy) ? rawPolicy.bytes : rawPolicy;

    // @ts-ignore type check
    const rawName = fields[5];
    const assetName = (typeof rawName === 'object' && 'bytes' in rawName) ? rawName.bytes : rawName;
    const assetNameHex = assetName; 

    const newBid = parseInt(newBidAmount);
    if (newBid <= currentHighestBid) {
        throw new Error(`⚠️ Bid too low! You need to beat ${currentHighestBid} ADA.`);
    }

    const newDatumData = mConStr0([
        seller,
        pubKeyHash,
        parseInt(newBidAmount),
        expiration,
        assetPolicy,
        assetNameHex
    ]);

    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, submitter: this.provider, evaluator: this.provider });
    
    const collateral = (await this.wallet.getCollateral())[0];
    let walletUtxos = await this.wallet.getUtxos();

    if (collateral) {
        txBuilder.txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address
        );
        walletUtxos = walletUtxos.filter(u => u.input.txHash !== collateral.input.txHash || u.input.outputIndex !== collateral.input.outputIndex);
    }
    
    console.log(`\n💰 Placing Bid: ${newBidAmount} ADA`);
    //console.log(`Wallet UTXOs Available (filtered): ${walletUtxos.length}`);
    //walletUtxos.forEach(u => console.log(`W:`, JSON.stringify(u.output.amount)));

    txBuilder
      .selectUtxosFrom(walletUtxos)
      .spendingPlutusScriptV3()
      .txIn(
          scriptUtxo.input.txHash, 
          scriptUtxo.input.outputIndex,
          scriptUtxo.output.amount,
          scriptUtxo.output.address
      )
      .txInScript(this.scriptCbor)
      .txInRedeemerValue(mConStr0([]))
      .txInInlineDatumPresent();
        
    //console.log(`Bid Output: ${newBidAmount}, Asset: ${assetPolicy}${assetNameHex}`);
    
    txBuilder.txOut(this.scriptAddress, [
        { unit: "lovelace", quantity: newBidAmount },
        { unit: assetPolicy + assetNameHex, quantity: "1" }
    ])
    .txOutInlineDatumValue(newDatumData);

    if (typeof currentHighestBidder === 'string' && currentHighestBidder.length > 0 && currentHighestBid > 0) {
        const fullHex = "60" + currentHighestBidder;
        const pkhBytes = new Uint8Array(fullHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
        const pkhWords = bech32.toWords(pkhBytes);
        const refundAddress = bech32.encode("addr_test", pkhWords);
        
        console.log(`💸 Refunding ${currentHighestBid} ADA to previous bidder...`);
        
        txBuilder.txOut(refundAddress, [
            { unit: "lovelace", quantity: currentHighestBid.toString() }
        ]);
    }
    
    const currentSlot = await this.getCurrentSlot();
    const expirationSlot = getSlotFromTime(expiration);

    txBuilder
        .changeAddress(address)
        .requiredSignerHash(pubKeyHash)
        .invalidHereafter(expirationSlot);

    const unsignedTx = await txBuilder.complete();
    const signedTx = await this.wallet.signTx(unsignedTx);
    
    console.log(`🚀 Sending Bid Transaction...`);
    const txHash = await this.wallet.submitTx(signedTx);
    console.log(`✅ Bid Placed Successfully!`);
    console.log(`📜 Transaction ID: ${txHash}\n`);
    return txHash;
  }

  async close(auctionTxHash: string) {
    const address = (await this.wallet.getUnusedAddresses())[0];
    const { pubKeyHash } = deserializeAddress(address);

    const utxos = await this.provider.fetchAddressUTxOs(this.scriptAddress);
    const scriptUtxo = utxos.find(u => u.input.txHash === auctionTxHash && u.input.outputIndex === 0);
    
    if (!scriptUtxo) throw new Error("❌ Auction not found! Is the Tx Hash correct?");
    if (!scriptUtxo.output.plutusData) throw new Error("❌ Fatal: Missing auction datum.");

    const oldDatum = deserializeDatum(scriptUtxo.output.plutusData);
    const fields = oldDatum.fields;
    
    // @ts-ignore type check
    const seller = fields[0].bytes;
    // @ts-ignore type check
    const highestBidder = fields[1].bytes;
    // @ts-ignore type check
    const highestBid = Number(fields[2].int);
    // @ts-ignore type check
    const expiration = Number(fields[3].int);
    console.log(`\n🛑 Closing Auction...`);

    const currentSlot = await this.getCurrentSlot();
    const expirationSlot = getSlotFromTime(expiration);
    
    if (currentSlot < expirationSlot) {
        throw new Error(`⏳ Auction is still running! Please wait until ${new Date(expiration).toLocaleString()} (Slot: ${expirationSlot})`);
    }

    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, submitter: this.provider, evaluator: this.provider });
    
    const collateral = (await this.wallet.getCollateral())[0];
    let walletUtxos = await this.wallet.getUtxos();

    if (collateral) {
        txBuilder.txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address
        );
        walletUtxos = walletUtxos.filter(u => u.input.txHash !== collateral.input.txHash || u.input.outputIndex !== collateral.input.outputIndex);
    }
    
    //console.log(`Script Input:`, JSON.stringify(scriptUtxo.output.amount));
    //console.log(`Wallet Filtered: ${walletUtxos.length}`);
    //walletUtxos.forEach(u => console.log(`W:`, JSON.stringify(u.output.amount)));
    
    txBuilder.selectUtxosFrom(walletUtxos);

    txBuilder
        .spendingPlutusScriptV3()
        .txIn(
            scriptUtxo.input.txHash, 
            scriptUtxo.input.outputIndex,
            scriptUtxo.output.amount,
            scriptUtxo.output.address
        )
        .txInScript(this.scriptCbor)
        .txInRedeemerValue(mConStr2([]))
        .txInInlineDatumPresent();

    const sellerFullHex = "60" + seller;
    const sellerBytes = new Uint8Array(sellerFullHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    const sellerAddr = bech32.encode("addr_test", bech32.toWords(sellerBytes));

    if (highestBidder && highestBidder !== "") {
        const bidderFullHex = "60" + highestBidder;
        const bidderBytes = new Uint8Array(bidderFullHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
        const bidderAddr = bech32.encode("addr_test", bech32.toWords(bidderBytes));
        
        console.log(`🏆 Winner found! Sending NFT to winner and ${highestBid} ADA to seller.`);
        
        txBuilder.txOut(sellerAddr, [
            { unit: "lovelace", quantity: highestBid.toString() }
        ]);
        
        txBuilder.txOut(bidderAddr, [
            { unit: this.policyId + stringToHex("auction_nft"), quantity: "1" }
        ]);
    } else {
        console.log(`😢 No bids placed. Returning NFT to Seller.`);
        
        txBuilder.txOut(sellerAddr, [
            { unit: this.policyId + stringToHex("auction_nft"), quantity: "1" }
        ]);
    }

    txBuilder
        .changeAddress(address)
        .requiredSignerHash(pubKeyHash)
        .invalidBefore(expirationSlot + 1)
        .invalidHereafter(currentSlot + 1000);

    const unsignedTx = await txBuilder.complete();
    const signedTx = await this.wallet.signTx(unsignedTx);
    
    console.log(`🚀 Finalizing Auction...`);
    const txHash = await this.wallet.submitTx(signedTx);
    console.log(`✅ Auction Closed Successfully!`);
    console.log(`📜 Transaction ID: ${txHash}\n`);
    return txHash;
  }
}

if (import.meta.main) {
  const args = Deno.args;
  if (args.length < 1) {
    console.error("Please provide a command: prepare, init, bid <tx> <amount>, close <tx>");
    Deno.exit(1);
  }

  const command = args[0];
  
  if (command === "prepare") {
      const amount = args[1] ? parseInt(args[1]) : 1;
      console.log(`\n⚙️  Preparing ${amount} wallet(s)...`);
      for (let i=0; i<amount; i++) {
        await setup(i);
      }
      console.log("✅ Wallets ready.\n");
  } else if (command === "init") {
      const { provider, wallet } = await setup(0);
      const contract = new AuctionContract(provider, wallet);
      await contract.init(args[1] || "5000000");
  } else if (command === "bid") {
      const { provider, wallet } = await setup(1);
      const contract = new AuctionContract(provider, wallet);
      await contract.bid(args[1], args[2]);
  } else if (command === "close") {
      const { provider, wallet } = await setup(0);
      const contract = new AuctionContract(provider, wallet);
      await contract.close(args[1]);
  }
}


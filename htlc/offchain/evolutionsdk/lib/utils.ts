import { Lucid, Koios, LucidEvolution, generateSeedPhrase, validatorToAddress, Validator, applyParamsToScript } from "@evolution-sdk/lucid";
import blueprint from "../../../onchain/aiken/plutus.json" with { type: "json" };

export async function getLucid() {
  return await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
}

export async function getWallet(lucid: LucidEvolution, index: number) {
  const walletPath = `wallet_${index}.txt`;
  try {
    await Deno.stat(walletPath);
  } catch {
    throw new Error(`Wallet file ${walletPath} not found. Run 'prepare' first.`);
  }
  const mnemonic = await Deno.readTextFile(walletPath);
  lucid.selectWallet.fromSeed(mnemonic);
  return lucid.wallet();
}

export async function getAllWallets() {
  const files = Deno.readDirSync(".");
  const walletFiles = [];
  for (const file of files) {
    if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
      walletFiles.push(file.name);
    }
  }
  walletFiles.sort();

  const wallets = [];
  const lucid = await getLucid();
  for (const file of walletFiles) {
    const index = parseInt(file.match(/[0-9]+/)![0]);
    const mnemonic = await Deno.readTextFile(file);
    lucid.selectWallet.fromSeed(mnemonic);
    const address = await lucid.wallet().address();
    wallets.push({ index, address, mnemonic });
  }
  return wallets;
}

export async function sha256(input: string) {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

export const STORE_FILE = "htlc_store.json";

export type StoredHtlc = {
  txHash: string;
  amount: string;
  secretHash: string;
  expiration: string;
  ownerPkh: string;
};

export async function loadStore(): Promise<StoredHtlc[]> {
  try {
    const data = await Deno.readTextFile(STORE_FILE);
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function saveStore(store: StoredHtlc[]) {
  await Deno.writeTextFile(STORE_FILE, JSON.stringify(store, null, 2));
}

export async function showAddresses() {
  const wallets = await getAllWallets();
  for (const { index, address } of wallets) {
    console.log(`Wallet ${index} address: ${address}`);
  }
}

export async function checkBalances() {
  const lucid = await getLucid();
  const wallets = await getAllWallets();
  for (const { index, address, mnemonic } of wallets) {
    lucid.selectWallet.fromSeed(mnemonic);
    const utxos = await lucid.utxosAt(address);
    const balance = utxos.reduce((acc, utxo) => acc + utxo.assets.lovelace, 0n);
    console.log(`Wallet ${index} address: ${address}`);
    console.log(`Balance: ${balance} lovelace (${Number(balance) / 1_000_000} ADA)`);
  }
}

export async function transfer(fromIndex: number, toIndex: number, amountLovelace: string) {
  const lucid = await getLucid();
  
  const fromMnemonic = await Deno.readTextFile(`wallet_${fromIndex}.txt`);
  lucid.selectWallet.fromSeed(fromMnemonic);
  const fromAddr = await lucid.wallet().address();

  const toMnemonic = await Deno.readTextFile(`wallet_${toIndex}.txt`);
  // We just need the address, we can use the same instance temporarily or a helper
  const toLucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
  toLucid.selectWallet.fromSeed(toMnemonic);
  const toAddr = await toLucid.wallet().address();

  console.log(`Sending ${amountLovelace} lovelace from Wallet ${fromIndex} (${fromAddr}) to Wallet ${toIndex} (${toAddr})...`);

  const tx = await lucid
    .newTx()
    .pay.ToAddress(toAddr, { lovelace: BigInt(amountLovelace) })
    .complete();

  const signedTx = await tx.sign.withWallet();
  const txHash = await (await signedTx.complete()).submit();

  console.log(`Transaction submitted: ${txHash}`);
}

export async function listUtxos() {
  const lucid = await getLucid();
  const store = await loadStore();
  
  if (store.length === 0) {
    console.log("No HTLCs found in store.");
    return;
  }

  for (const htlc of store) {
    console.log(`--- HTLC ${htlc.txHash} ---`);
    const params = [htlc.secretHash, BigInt(htlc.expiration), htlc.ownerPkh];
    
    let script = blueprint.validators[0].compiledCode;
    script = applyParamsToScript(script, params);

    const validator: Validator = {
      type: "PlutusV3",
      script: script,
    };

    const scriptAddress = validatorToAddress("Preprod", validator);
    console.log(`Script Address: ${scriptAddress}`);

    const utxos = await lucid.utxosAt(scriptAddress);
    const utxo = utxos.find((u) => u.txHash === htlc.txHash);

    if (utxo) {
      console.log(`Status: ACTIVE`);
      console.log(`Amount: ${JSON.stringify(utxo.assets, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    } else {
      console.log(`Status: SPENT or NOT FOUND`);
    }
    console.log("");
  }
}

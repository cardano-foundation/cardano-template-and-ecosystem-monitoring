import { MeshWallet, KoiosProvider, serializePlutusScript, Transaction } from '@meshsdk/core';
import { applyParamsToScript } from '@meshsdk/core-cst';
import blueprint from '../../../onchain/aiken/plutus.json' with { type: 'json' };

export const koiosProvider = new KoiosProvider('preprod');

export async function getWallet(index: number) {
  const walletPath = `wallet_${index}.txt`;
  try {
    await Deno.stat(walletPath);
  } catch {
    throw new Error(
      `Wallet file ${walletPath} not found. Run 'prepare' first.`
    );
  }
  const mnemonic = (await Deno.readTextFile(walletPath)).split(' ');
  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: koiosProvider,
    submitter: koiosProvider,
    key: {
      type: 'mnemonic',
      words: mnemonic,
    },
  });
  return wallet;
}

export async function getAllWallets() {
  const files = Deno.readDirSync('.');
  const walletFiles = [];
  for (const file of files) {
    if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
      walletFiles.push(file.name);
    }
  }
  walletFiles.sort();

  const wallets = [];
  for (const file of walletFiles) {
    const index = parseInt(file.match(/[0-9]+/)![0]);
    const wallet = await getWallet(index);
    wallets.push({ index, wallet });
  }
  return wallets;
}

export function stringToHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256(input: string) {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

export const STORE_FILE = 'htlc_store.json';

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

  for (const { index, wallet } of wallets) {
    try {
      const address = await wallet.getChangeAddress();
      console.log(`Wallet ${index} address: ${address}`);
    } catch (e: any) {
      console.log(`Error showing wallet ${index}: ${e.message}`);
    }
  }
}

export async function checkBalances() {
  const wallets = await getAllWallets();

  for (const { index, wallet } of wallets) {
    try {
      const addr = await wallet.getChangeAddress();
      const utxos = await koiosProvider.fetchAddressUTxOs(addr);
      const balance = utxos.reduce(
        (acc, utxo) =>
          acc +
          BigInt(
            utxo.output.amount.find((a) => a.unit === 'lovelace')?.quantity ||
              '0'
          ),
        0n
      );
      console.log(`Wallet ${index} address: ${addr}`);
      console.log(
        `Balance: ${balance} lovelace (${Number(balance) / 1_000_000} ADA)`
      );
    } catch (e: any) {
      console.log(`Error checking wallet ${index}: ${e.message}`);
    }
  }
}

export async function listUtxos() {
  let store = [];
  try {
    const data = await Deno.readTextFile(STORE_FILE);
    store = JSON.parse(data);
  } catch {
    console.log('No HTLCs found in store.');
    return;
  }

  for (const htlc of store) {
    console.log(`--- HTLC ${htlc.txHash} ---`);
    const params = [htlc.secretHash, BigInt(htlc.expiration), htlc.ownerPkh];
    let scriptCode = blueprint.validators[0].compiledCode;
    scriptCode = applyParamsToScript(scriptCode, params);

    const script = {
      code: scriptCode,
      version: 'V3',
    };

    const scriptAddress = serializePlutusScript(script as any, undefined, 0)
      .address;
    console.log(`Script Address: ${scriptAddress}`);

    const utxos = await koiosProvider.fetchAddressUTxOs(scriptAddress);
    const utxo = utxos.find((u) => u.input.txHash === htlc.txHash);

    if (utxo) {
      console.log(`Status: ACTIVE`);
      console.log(`Amount: ${JSON.stringify(utxo.output.amount)}`);
    } else {
      console.log(`Status: SPENT or NOT FOUND`);
    }
    console.log('');
  }
}

export async function transfer(
  fromIndex: number,
  toIndex: number,
  amountLovelace: string
) {
  const walletFrom = await getWallet(fromIndex);
  const addrFrom = await walletFrom.getChangeAddress();

  const walletTo = await getWallet(toIndex);
  const addrTo = await walletTo.getChangeAddress();

  console.log(
    `Sending ${amountLovelace} lovelace from Wallet ${fromIndex} (${addrFrom}) to Wallet ${toIndex} (${addrTo})...`
  );

  const tx = new Transaction({ initiator: walletFrom }).sendLovelace(
    addrTo,
    amountLovelace
  );

  try {
    const unsignedTx = await tx.build();
    const signedTx = await walletFrom.signTx(unsignedTx);
    const txHash = await walletFrom.submitTx(signedTx);
    console.log(`Transaction submitted: ${txHash}`);
  } catch (error) {
    console.error('Error while submitting transaction:', error);
  }
}

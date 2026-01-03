import {
  Lucid,
  Koios,
  LucidEvolution,
  generateSeedPhrase,
  Assets,
  getAddressDetails,
} from '@evolution-sdk/lucid';
import { StoredEscrow } from '../types.ts';

export const STORE_FILE = 'escrow_store.json';

export async function loadStore(): Promise<StoredEscrow[]> {
  try {
    const data = await Deno.readTextFile(STORE_FILE);
    const parsed = JSON.parse(data, (key, value) => {
      if (
        typeof value === 'string' &&
        /^\d+n?$/.test(value) &&
        key !== 'txHash' &&
        key !== 'initiator' &&
        key !== 'recipient' &&
        key !== 'state'
      ) {
        return BigInt(value.replace('n', ''));
      }
      return value;
    });
    return parsed;
  } catch (_e) {
    return [];
  }
}

export async function saveStore(store: StoredEscrow[]) {
  await Deno.writeTextFile(
    STORE_FILE,
    JSON.stringify(
      store,
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    )
  );
}

export async function getLucid() {
  return await Lucid(new Koios('https://preprod.koios.rest/api/v1'), 'Preprod');
}

export async function getWallet(lucid: LucidEvolution, index: number) {
  const walletPath = `wallet_${index}.txt`;
  try {
    await Deno.stat(walletPath);
  } catch {
    throw new Error(
      `Wallet file ${walletPath} not found. Run 'prepare' first.`
    );
  }
  const mnemonic = await Deno.readTextFile(walletPath);
  lucid.selectWallet.fromSeed(mnemonic);
  return lucid.wallet();
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
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
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
    console.log(
      `Balance: ${balance} lovelace (${Number(balance) / 1_000_000} ADA)`
    );
  }
}

export async function transfer(
  fromIndex: number,
  toIndex: number,
  amountLovelace: string
) {
  const lucid = await getLucid();

  const fromMnemonic = await Deno.readTextFile(`wallet_${fromIndex}.txt`);
  lucid.selectWallet.fromSeed(fromMnemonic);
  const fromAddr = await lucid.wallet().address();

  const toMnemonic = await Deno.readTextFile(`wallet_${toIndex}.txt`);
  // We just need the address, we can use the same instance temporarily or a helper
  const toLucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod'
  );
  toLucid.selectWallet.fromSeed(toMnemonic);
  const toAddr = await toLucid.wallet().address();

  console.log(
    `Sending ${amountLovelace} lovelace from Wallet ${fromIndex} (${fromAddr}) to Wallet ${toIndex} (${toAddr})...`
  );

  const tx = await lucid
    .newTx()
    .pay.ToAddress(toAddr, { lovelace: BigInt(amountLovelace) })
    .complete();

  const signedTx = await tx.sign.withWallet();
  const txHash = await (await signedTx.complete()).submit();

  console.log(`Transaction submitted: ${txHash}`);
}

// --- Helpers ---

export function addressToData(address: string) {
  const details = getAddressDetails(address);
  if (!details.paymentCredential) {
    throw new Error('Address must have a payment credential');
  }
  const paymentCredential =
    details.paymentCredential.type === 'Key'
      ? { VerificationKey: [details.paymentCredential.hash] }
      : { Script: [details.paymentCredential.hash] };

  const stakeCredential = details.stakeCredential
    ? {
        Inline: [
          details.stakeCredential.type === 'Key'
            ? { VerificationKey: [details.stakeCredential.hash] }
            : { Script: [details.stakeCredential.hash] },
        ],
      }
    : null;

  return {
    payment_credential: paymentCredential,
    stake_credential: stakeCredential,
  };
}

export function assetsToMValue(assets: Assets) {
  const mValue = new Map<string, Map<string, bigint>>();
  for (const [asset, amount] of Object.entries(assets)) {
    let policyId: string;
    let assetName: string;
    if (asset === 'lovelace') {
      policyId = '';
      assetName = '';
    } else {
      policyId = asset.slice(0, 56);
      assetName = asset.slice(56);
    }
    if (!mValue.has(policyId)) mValue.set(policyId, new Map());
    mValue.get(policyId)!.set(assetName, BigInt(amount as any));
  }
  return mValue;
}

export function mergeAssets(a: Assets, b: Assets): Assets {
  const res: Assets = { ...a };
  for (const [asset, amount] of Object.entries(b)) {
    res[asset] = (res[asset] ?? 0n) + amount;
  }
  return res;
}

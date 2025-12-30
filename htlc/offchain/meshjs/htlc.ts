import {
  MeshWallet,
  KoiosProvider,
  MeshTxBuilder,
  serializePlutusScript,
  resolvePaymentKeyHash,
} from "@meshsdk/core";
import {
  applyParamsToScript,
  deserializeAddress,
} from "@meshsdk/core-cst";
import {
  builtinByteString,
  conStr0,
  conStr1,
  mConStr1,
  PlutusScript,
  unixTimeToEnclosingSlot,
  SLOT_CONFIG_NETWORK,
} from "@meshsdk/common";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const STORE_FILE = "htlc_store.json";

type StoredHtlc = {
  txHash: string;
  amount: string;
  secretHash: string;
  expiration: number;
  ownerPkh: string;
};

async function sha256(message: string) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

async function loadStore(): Promise<StoredHtlc[]> {
  try {
    const data = await Deno.readTextFile(STORE_FILE);
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveStore(store: StoredHtlc[]) {
  await Deno.writeTextFile(STORE_FILE, JSON.stringify(store, null, 2));
}

export function isPositiveNumber(v: string): boolean {
  return /^[0-9]+$/.test(v) && parseInt(v) > 0;
}

export async function prepare(amount: number) {
  const koiosProvider = new KoiosProvider('preprod');
  const addresses = [];
  for (let i = 0; i < amount; i++) {
    const mnemonic = MeshWallet.brew();
    Deno.writeTextFileSync(`wallet_${i}.txt`, JSON.stringify(mnemonic));
    
    const wallet = new MeshWallet({
      networkId: 0,
      fetcher: koiosProvider,
      submitter: koiosProvider,
      key: {
        type: 'mnemonic',
        words: mnemonic as string[],
      },
    });
    addresses.push(await wallet.getChangeAddress());
  }
  console.log(`Successfully prepared ${amount} wallets.`);
  console.log(`Make sure to send some tADA to ${addresses[0]} for fees and collateral.`);
}

async function setup(walletIndex: number) {
  const koiosProvider = new KoiosProvider('preprod');
  const mnemonic = JSON.parse(Deno.readTextFileSync(`wallet_${walletIndex}.txt`));

  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: koiosProvider,
    submitter: koiosProvider,
    key: {
      type: 'mnemonic',
      words: mnemonic,
    },
  });

  return { wallet, provider: koiosProvider };
}

export async function initHtlc(lovelaceAmount: string, secret: string, recipientIndex = 1, expirationSeconds = 3600) {
  const { wallet, provider } = await setup(0);
  const walletAddress = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(walletAddress);
  
  const secretHash = await sha256(secret);
  const expiration = Date.now() + expirationSeconds * 1000;

  const params = [
    builtinByteString(secretHash),
    { int: expiration },
    builtinByteString(ownerPkh),
  ];

  const scriptCbor = applyParamsToScript(
    blueprint.validators[0].compiledCode,
    params as unknown as object[],
    "JSON"
  );

  const script: PlutusScript = {
    code: scriptCbor,
    version: "V3",
  };
  
  // FIXED: Use serializePlutusScript from @meshsdk/core-cst
  const scriptAddress = serializePlutusScript(script, undefined, 0).address;

  const txBuilder = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
  });

  const utxos = await wallet.getUtxos();
  if (utxos.length === 0) {
    throw new Error("No UTXOs found in wallet. Please fund your wallet.");
  }

  const tx = await txBuilder
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelaceAmount }])
    .txOutInlineDatumValue(mConStr1([]))
    .changeAddress(walletAddress)
    .selectUtxosFrom(utxos)
    .complete();

  const signedTx = await wallet.signTx(tx);
  const txHash = await wallet.submitTx(signedTx);

  const store = await loadStore();
  store.push({
    txHash,
    amount: lovelaceAmount,
    secretHash,
    expiration,
    ownerPkh,
  });
  await saveStore(store);

  console.log(`HTLC initialized. TxHash: ${txHash}`);
  console.log(`Script Address: ${scriptAddress}`);
  console.log(`Expiration: ${new Date(expiration).toLocaleString()}`);
}

export async function claimHtlc(txHash: string, preimage: string, walletIndex = 1) {
  const store = await loadStore();
  const htlc = store.find((h) => h.txHash === txHash);
  if (!htlc) {
    console.error("HTLC not found in local store. Make sure you initialized it from this machine.");
    return;
  }

  const { wallet, provider } = await setup(walletIndex);
  const walletAddress = await wallet.getChangeAddress();

  const params = [
    builtinByteString(htlc.secretHash),
    { int: htlc.expiration },
    builtinByteString(htlc.ownerPkh),
  ];

  const scriptCbor = applyParamsToScript(
    blueprint.validators[0].compiledCode,
    params as unknown as object[],
    "JSON"
  );

  const script: PlutusScript = {
    code: scriptCbor,
    version: "V3",
  };
  
  // FIXED: Use serializePlutusScript
  const scriptAddress = serializePlutusScript(script, undefined, 0).address;

  const utxos = await provider.fetchAddressUTxOs(scriptAddress);
  const utxo = utxos.find((u) => u.input.txHash === txHash);

  if (!utxo) {
    console.error(`UTXO with hash ${txHash} not found at script address ${scriptAddress}.`);
    return;
  }

  const txBuilder = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
  });

  const preimageHex = Array.from(new TextEncoder().encode(preimage)).map(b => b.toString(16).padStart(2, '0')).join('');
  const collateral = await wallet.getCollateral();
  if (collateral.length === 0) {
    throw new Error("No collateral found in wallet. Please fund your wallet.");
  }

  const tx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(scriptCbor)
    .txInRedeemerValue(conStr0([builtinByteString(preimageHex)]))
    .txOut(walletAddress, [])
    .changeAddress(walletAddress)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address
    )
    .invalidHereafter(unixTimeToEnclosingSlot(htlc.expiration, SLOT_CONFIG_NETWORK.preprod))
    .selectUtxosFrom(await wallet.getUtxos())
    .complete();

  const signedTx = await wallet.signTx(tx);
  const claimTxHash = await wallet.submitTx(signedTx);

  console.log(`HTLC claimed. TxHash: ${claimTxHash}`);
}

export async function refundHtlc(txHash: string, walletIndex = 0) {
  const store = await loadStore();
  const htlc = store.find((h) => h.txHash === txHash);
  if (!htlc) {
    console.error("HTLC not found in local store.");
    return;
  }

  const { wallet, provider } = await setup(walletIndex);
  const walletAddress = await wallet.getChangeAddress();

  const params = [
    builtinByteString(htlc.secretHash),
    { int: htlc.expiration },
    builtinByteString(htlc.ownerPkh),
  ];

  const scriptCbor = applyParamsToScript(
    blueprint.validators[0].compiledCode,
    params as unknown as object[],
    "JSON"
  );

  const script: PlutusScript = {
    code: scriptCbor,
    version: "V3",
  };
  
  // FIXED: Use serializePlutusScript
  const scriptAddress = serializePlutusScript(script, undefined, 0).address;

  const utxos = await provider.fetchAddressUTxOs(scriptAddress);
  const utxo = utxos.find((u) => u.input.txHash === txHash);

  if (!utxo) {
    console.error("UTXO not found at script address.");
    return;
  }

  const txBuilder = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
  });

  const collateral = await wallet.getCollateral();
  if (collateral.length === 0) {
    throw new Error("No collateral found in wallet.");
  }

  const tx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(scriptCbor)
    .txInRedeemerValue(conStr1([]))
    .txOut(walletAddress, [])
    .changeAddress(walletAddress)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address
    )
    .invalidBefore(unixTimeToEnclosingSlot(htlc.expiration, SLOT_CONFIG_NETWORK.preprod))
    .requiredSignerHash(htlc.ownerPkh)
    .selectUtxosFrom(await wallet.getUtxos())
    .complete();

  const signedTx = await wallet.signTx(tx);
  const refundTxHash = await wallet.submitTx(signedTx);

  console.log(`HTLC refunded. TxHash: ${refundTxHash}`);
}

if (typeof Deno !== 'undefined' && Deno.args.length > 0) {
  (async () => {
    try {
      if (Deno.args[0] === 'init') {
        if (Deno.args.length > 2 && isPositiveNumber(Deno.args[1])) {
          const amount = Deno.args[1];
          const secret = Deno.args[2];
          const recipientIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 1;
          const expirationSeconds = Deno.args.length > 4 ? parseInt(Deno.args[4]) : 3600;
          await initHtlc(amount, secret, recipientIndex, expirationSeconds);
        } else {
          console.log('Expected lovelace amount and secret as arguments.');
          console.log('Example usage: deno run -A htlc.ts init 10000000 mySecret 1 3600');
        }
      } else if (Deno.args[0] === 'claim') {
        if (Deno.args.length > 2 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
          const txHash = Deno.args[1];
          const preimage = Deno.args[2];
          const walletIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 1;
          await claimHtlc(txHash, preimage, walletIndex);
        } else {
          console.log('Expected a valid transaction ID and preimage as arguments.');
          console.log('Example usage: deno run -A htlc.ts claim 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5 preimage 1');
        }
      } else if (Deno.args[0] === 'refund') {
        if (Deno.args.length > 1 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
          const txHash = Deno.args[1];
          const walletIndex = Deno.args.length > 2 ? parseInt(Deno.args[2]) : 0;
          await refundHtlc(txHash, walletIndex);
        } else {
          console.log('Expected a valid transaction ID as the second argument.');
          console.log('Example usage: deno run -A htlc.ts refund 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5 0');
        }
      } else if (Deno.args[0] === 'prepare') {
        if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
          await prepare(parseInt(Deno.args[1]));
        } else {
          console.log('Expected a positive number (of seed phrases to prepare) as the second argument.');
          console.log('Example usage: deno run -A htlc.ts prepare 5');
        }
      } else {
        console.log('Invalid argument. Allowed arguments are "init", "claim", "refund" or "prepare".');
      }
      Deno.exit(0);
    } catch (error) {
      console.error(error);
      Deno.exit(1);
    }
  })();
}

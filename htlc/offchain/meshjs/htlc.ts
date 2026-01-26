import {
  MeshWallet,
  serializePlutusScript,
  Transaction,
  largestFirst,
} from "@meshsdk/core";
import { applyParamsToScript, deserializeAddress } from "@meshsdk/core-cst";
import {
  PlutusScript,
  unixTimeToEnclosingSlot,
  SLOT_CONFIG_NETWORK,
} from "@meshsdk/common";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };
import {
  koiosProvider,
  getWallet,
  stringToHex,
  sha256,
  loadStore,
  saveStore,
  showAddresses,
  checkBalances,
  listUtxos,
  transfer,
} from "./lib/utils.ts";

async function prepare(amount: number) {
  const addresses = [];
  for (let i = 0; i < amount; i++) {
    const mnemonic = MeshWallet.brew() as string[];
    const wallet = new MeshWallet({
      networkId: 0,
      fetcher: koiosProvider,
      submitter: koiosProvider,
      key: {
        type: "mnemonic",
        words: mnemonic,
      },
    });
    const address = await wallet.getChangeAddress();
    addresses.push(address);
    Deno.writeTextFileSync(`wallet_${i}.txt`, mnemonic.join(" "));
  }
  console.log(`Successfully prepared ${amount} wallet (seed phrases).`);
  console.log(
    `Make sure to send some tADA to the wallet ${addresses[0]} for fees and collateral.`
  );
}

async function setup(wallet: MeshWallet, params?: any[]) {
  let scriptCode = blueprint.validators[0].compiledCode;

  if (params) {
    scriptCode = applyParamsToScript(scriptCode, params);
  }

  const script: PlutusScript = {
    code: scriptCode,
    version: "V3",
  };

  const scriptAddress = serializePlutusScript(script, undefined, 0).address;

  return {
    wallet,
    script,
    scriptAddress,
  };
}

async function initHtlc(
  lovelaceAmount: string,
  secret: string,
  walletIndex = 0,
  expirationSeconds = 3600
) {
  const wallet = await getWallet(walletIndex);
  const address = await wallet.getChangeAddress();
  const ownerPkh =
    deserializeAddress(address).asBase()?.getPaymentCredential().hash || "";

  const secretHash = await sha256(secret);
  const expiration = BigInt(Date.now() + expirationSeconds * 1000);

  const params = [secretHash, expiration, ownerPkh];

  const { scriptAddress } = await setup(wallet, params);

  const utxos = await koiosProvider.fetchAddressUTxOs(address);

  const tx = new Transaction({ initiator: wallet, fetcher: koiosProvider })
    .setTxInputs(utxos)
    .sendLovelace(
    {
      address: scriptAddress,
      datum: {
        value: { alternative: 0, fields: [] },
        inline: true,
      },
    },
    lovelaceAmount
  );

  try {
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);

    const store = await loadStore();
    store.push({
      txHash,
      amount: lovelaceAmount,
      secretHash,
      expiration: expiration.toString(),
      ownerPkh,
    });
    await saveStore(store);

    console.log(`Successfully locked ${lovelaceAmount} lovelace to ${scriptAddress}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
    console.log(`Use the following command to claim:
deno run -A htlc.ts claim ${txHash} <preimage> <walletIndex>`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

async function claimHtlc(
  transactionId: string,
  preimage: string,
  walletIndex = 1
) {
  console.log(`Claiming HTLC with transaction ID: "${transactionId}" using wallet ${walletIndex}`);
  const store = await loadStore();
  const htlc = store.find((h) => h.txHash === transactionId);
  if (!htlc) {
    console.error("HTLC not found in local store.");
    return;
  }

  const params = [htlc.secretHash, BigInt(htlc.expiration), htlc.ownerPkh];

  const wallet = await getWallet(walletIndex);
  const { script, scriptAddress } = await setup(wallet, params);
  const address = await wallet.getChangeAddress();
  console.log(`Using wallet address: ${address}`);
  console.log(`Script address: ${scriptAddress}`);

  const utxos = await koiosProvider.fetchAddressUTxOs(scriptAddress);
  console.log(`Found ${utxos.length} UTXOs at script address.`);
  const utxo = utxos.find((u) => u.input.txHash === transactionId);

  if (!utxo) {
    console.error(`No UTXOs found for transaction ID: ${transactionId}`);
    return;
  }

  const collateralUtxos = largestFirst(
    "5000000",
    await koiosProvider.fetchAddressUTxOs(address)
  );

  const redeemer = {
    alternative: 0, // GUESS
    fields: [stringToHex(preimage)],
  };

  const slot = unixTimeToEnclosingSlot(
    Number(htlc.expiration),
    SLOT_CONFIG_NETWORK.preprod
  );

  const tx = new Transaction({ initiator: wallet, fetcher: koiosProvider })
    .setTimeToExpire(slot.toString())
    .redeemValue({
      value: utxo,
      script: script,
      redeemer: { data: redeemer },
    })
    .setCollateral(collateralUtxos)
    .sendValue(address, utxo);

  try {
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`Successfully claimed HTLC with transaction ID ${transactionId}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

async function refundHtlc(transactionId: string, walletIndex = 0) {
  console.log(`Refunding HTLC with transaction ID: "${transactionId}" using wallet ${walletIndex}`);
  const store = await loadStore();
  const htlc = store.find((h) => h.txHash === transactionId);
  if (!htlc) {
    console.error("HTLC not found in local store.");
    return;
  }

  const params = [htlc.secretHash, BigInt(htlc.expiration), htlc.ownerPkh];

  const wallet = await getWallet(walletIndex);
  const { script, scriptAddress } = await setup(wallet, params);
  const address = await wallet.getChangeAddress();
  console.log(`Using wallet address: ${address}`);

  const utxos = await koiosProvider.fetchAddressUTxOs(address);

  const scriptUtxos = await koiosProvider.fetchAddressUTxOs(scriptAddress);
  const utxo = scriptUtxos.find((u) => u.input.txHash === transactionId);

  if (!utxo) {
    console.error(`No UTXOs found for transaction ID: ${transactionId}`);
    return;
  }

  const collateralUtxos = largestFirst(
    "5000000",
    utxos
  );

  const redeemer = {
    alternative: 1, // WITHDRAW
    fields: [],
  };

  const slot =
    unixTimeToEnclosingSlot(
      Number(htlc.expiration),
      SLOT_CONFIG_NETWORK.preprod
    ) + 1;

  const tx = new Transaction({ initiator: wallet, fetcher: koiosProvider })
    .setTxInputs(utxos)
    .setTimeToStart(slot.toString())
    .redeemValue({
      value: utxo,
      script: script,
      redeemer: { data: redeemer },
    })
    .setRequiredSigners([address])
    .setCollateral(collateralUtxos)
    .sendValue(address, utxo);

  try {
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`Successfully refunded HTLC with transaction ID ${transactionId}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

const isPositiveNumber = (s: string) =>
  Number.isInteger(Number(s)) && Number(s) > 0;

if (Deno.args.length > 0) {
  if (Deno.args[0] === "init") {
    if (Deno.args.length > 2 && isPositiveNumber(Deno.args[1])) {
      const amount = Deno.args[1];
      const secret = Deno.args[2];
      const walletIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 0;
      const expirationSeconds =
        Deno.args.length > 4 ? parseInt(Deno.args[4]) : 3600;
      await initHtlc(amount, secret, walletIndex, expirationSeconds);
    } else {
      console.log("Expected lovelace amount and secret as arguments.");
      console.log(
        "Example usage: deno run -A htlc.ts init 10000000 mySecret 0 3600"
      );
    }
  } else if (Deno.args[0] === "claim") {
    if (Deno.args.length > 2 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      const txHash = Deno.args[1];
      const preimage = Deno.args[2];
      const walletIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 1;
      await claimHtlc(txHash, preimage, walletIndex);
    } else {
      console.log("Expected a valid transaction ID and preimage as arguments.");
      console.log(
        "Example usage: deno run -A htlc.ts claim 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5 preimage 1"
      );
    }
  } else if (Deno.args[0] === "refund") {
    if (Deno.args.length > 1 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      const txHash = Deno.args[1];
      const walletIndex = Deno.args.length > 2 ? parseInt(Deno.args[2]) : 0;
      await refundHtlc(txHash, walletIndex);
    } else {
      console.log("Expected a valid transaction ID as the second argument.");
      console.log(
        "Example usage: deno run -A htlc.ts refund 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5 0"
      );
    }
  } else if (Deno.args[0] === "prepare") {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      const files = Deno.readDirSync(".");
      const seeds = [];
      for (const file of files) {
        if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
          seeds.push(file.name);
        }
      }

      if (seeds.length > 0) {
        console.log(
          "Seed phrases already exist. Remove them before preparing new ones."
        );
      } else {
        await prepare(parseInt(Deno.args[1]));
      }
    } else {
      console.log(
        "Expected a positive number (of seed phrases to prepare) as the second argument."
      );
      console.log("Example usage: deno run -A htlc.ts prepare 5");
    }
  } else if (Deno.args[0] === "show-addresses") {
    await showAddresses();
  } else if (Deno.args[0] === "balances") {
    await checkBalances();
  } else if (Deno.args[0] === "list-utxos") {
    await listUtxos();
  } else if (Deno.args[0] === "transfer") {
    if (Deno.args.length >= 4) {
      const from = parseInt(Deno.args[1]);
      const to = parseInt(Deno.args[2]);
      const amount = Deno.args[3];
      await transfer(from, to, amount);
    } else {
      console.log(
        "Usage: deno run -A htlc.ts transfer <fromIndex> <toIndex> <amountLovelace>"
      );
    }
  } else {
    console.log(
      'Invalid argument. Allowed arguments are "init", "claim", "refund", "prepare", "show-addresses", "balances", "list-utxos", or "transfer".'
    );
  }
} else {
  console.log(
    'Expected an argument. Allowed arguments are "init", "claim", "refund", "prepare", "show-addresses", "balances", "list-utxos", or "transfer".'
  );
}

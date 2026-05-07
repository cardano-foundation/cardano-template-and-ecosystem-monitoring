import {
  Constr,
  Data,
  getAddressDetails,
  Koios,
  Lucid,
  LucidEvolution,
  validatorToAddress,
  Validator,
  generateSeedPhrase,
} from "@evolution-sdk/lucid";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const DelegateSchema = Data.Object({
  key: Data.Bytes(),
  expires: Data.Integer(),
});

type Delegate = Data.Static<typeof DelegateSchema>;
const Delegate = DelegateSchema as unknown as Delegate;

const IdentityDatumSchema = Data.Object({
  owner: Data.Bytes(),
  delegates: Data.Array(DelegateSchema),
});

type IdentityDatum = Data.Static<typeof IdentityDatumSchema>;
const IdentityDatum = IdentityDatumSchema as unknown as IdentityDatum;

const NETWORK = "Preprod" as const;
const KOIOS_URL = "https://preprod.koios.rest/api/v1";

function selectWallet(lucid: LucidEvolution, filename: string) {
  const mnemonic = Deno.readTextFileSync(filename);
  lucid.selectWallet.fromSeed(mnemonic);
}

function getPaymentKeyHash(address: string) {
  const details = getAddressDetails(address);
  if (!details.paymentCredential) {
    throw new Error("Address has no payment credential.");
  }
  return details.paymentCredential.hash;
}

async function setup() {
  const lucid = await Lucid(new Koios(KOIOS_URL), NETWORK);
  const validatorEntry = blueprint.validators.find((v) => v.title === "identity");
  if (!validatorEntry) {
    throw new Error("Could not find identity validator in plutus.json.");
  }

  const validator: Validator = {
    type: "PlutusV3",
    script: validatorEntry.compiledCode,
  };

  const scriptAddress = validatorToAddress(NETWORK, validator);

  return { lucid, validator, scriptAddress };
}

async function prepare() {
  const lucid = await Lucid(new Koios(KOIOS_URL), NETWORK);

  const ownerMnemonic = generateSeedPhrase();
  lucid.selectWallet.fromSeed(ownerMnemonic);
  const ownerAddress = await lucid.wallet().address();
  Deno.writeTextFileSync("wallet_owner.txt", ownerMnemonic);

  const delegateMnemonic = generateSeedPhrase();
  lucid.selectWallet.fromSeed(delegateMnemonic);
  const delegateAddress = await lucid.wallet().address();
  Deno.writeTextFileSync("wallet_delegate.txt", delegateMnemonic);

  console.log("Created owner and delegate wallets.");
  console.log(`Owner address: ${ownerAddress}`);
  console.log(`Delegate address: ${delegateAddress}`);
  console.log("Fund the owner address with tADA before running init.");
}

async function initIdentity(lovelaceAmount: string) {
  const { lucid, scriptAddress } = await setup();
  selectWallet(lucid, "wallet_owner.txt");

  const ownerAddress = await lucid.wallet().address();
  const ownerKeyHash = getPaymentKeyHash(ownerAddress);

  const datum = Data.to(
    {
      owner: ownerKeyHash,
      delegates: [],
    },
    IdentityDatum,
  );

  const tx = await lucid
    .newTx()
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      { lovelace: BigInt(lovelaceAmount) },
    )
    .addSigner(ownerAddress);

  const unsignedTx = await tx.complete();
  const signedTx = await unsignedTx.sign.withWallet();
  const txHash = await (await signedTx.complete()).submit();

  console.log(`Identity created at ${scriptAddress}`);
  console.log(`Tx: ${txHash}`);
}

async function loadIdentity(txHash: string, outputIndex: number) {
  const { lucid, validator, scriptAddress } = await setup();
  const utxos = await lucid.utxosByOutRef([{ txHash, outputIndex }]);
  if (utxos.length === 0) {
    throw new Error("No UTxO found for the provided reference.");
  }

  const utxo = utxos[0];
  if (!utxo.datum) {
    throw new Error("UTxO has no datum.");
  }

  const state = Data.from(utxo.datum, IdentityDatum);
  return { lucid, validator, scriptAddress, utxo, state };
}

async function addDelegate(txHash: string, outputIndex: number, expiresMs: string) {
  const { lucid, validator, scriptAddress, utxo, state } = await loadIdentity(
    txHash,
    outputIndex,
  );

  selectWallet(lucid, "wallet_owner.txt");
  const ownerAddress = await lucid.wallet().address();

  selectWallet(lucid, "wallet_delegate.txt");
  const delegateAddress = await lucid.wallet().address();
  const delegateKeyHash = getPaymentKeyHash(delegateAddress);

  selectWallet(lucid, "wallet_owner.txt");
  const expires = BigInt(expiresMs);
  if (expires <= BigInt(Date.now())) {
    throw new Error("Expiry must be a future unix timestamp in milliseconds.");
  }

  if (state.delegates.some((d) => d.key === delegateKeyHash)) {
    throw new Error("Delegate already exists in the datum.");
  }

  const updated: IdentityDatum = {
    owner: state.owner,
    delegates: [...state.delegates, { key: delegateKeyHash, expires }],
  };

  const redeemer = Data.to(new Constr(1, [delegateKeyHash, expires]));

  const tx = await lucid
    .newTx()
    .attachSpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.to(updated, IdentityDatum) },
      utxo.assets,
    )
    .addSigner(ownerAddress)
    .validTo(Number(expires - 1_000n));

  const unsignedTx = await tx.complete();
  const signedTx = await unsignedTx.sign.withWallet();
  const submitHash = await (await signedTx.complete()).submit();

  console.log(`Delegate added. Tx: ${submitHash}`);
}

async function removeDelegate(txHash: string, outputIndex: number) {
  const { lucid, validator, scriptAddress, utxo, state } = await loadIdentity(
    txHash,
    outputIndex,
  );

  selectWallet(lucid, "wallet_owner.txt");
  const ownerAddress = await lucid.wallet().address();

  selectWallet(lucid, "wallet_delegate.txt");
  const delegateAddress = await lucid.wallet().address();
  const delegateKeyHash = getPaymentKeyHash(delegateAddress);

  selectWallet(lucid, "wallet_owner.txt");

  if (!state.delegates.some((d) => d.key === delegateKeyHash)) {
    throw new Error("Delegate not present in the datum.");
  }

  const updated: IdentityDatum = {
    owner: state.owner,
    delegates: state.delegates.filter((d) => d.key !== delegateKeyHash),
  };

  const redeemer = Data.to(new Constr(2, [delegateKeyHash]));

  const tx = await lucid
    .newTx()
    .attachSpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.to(updated, IdentityDatum) },
      utxo.assets,
    )
    .addSigner(ownerAddress);

  const unsignedTx = await tx.complete();
  const signedTx = await unsignedTx.sign.withWallet();
  const submitHash = await (await signedTx.complete()).submit();

  console.log(`Delegate removed. Tx: ${submitHash}`);
}

async function transferOwner(
  txHash: string,
  outputIndex: number,
  newOwnerAddress: string,
) {
  const { lucid, validator, scriptAddress, utxo, state } = await loadIdentity(
    txHash,
    outputIndex,
  );

  selectWallet(lucid, "wallet_owner.txt");
  const ownerAddress = await lucid.wallet().address();

  const newOwnerKeyHash = getPaymentKeyHash(newOwnerAddress);

  const updated: IdentityDatum = {
    owner: newOwnerKeyHash,
    delegates: state.delegates,
  };

  const redeemer = Data.to(new Constr(0, [newOwnerKeyHash]));

  const tx = await lucid
    .newTx()
    .attachSpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.to(updated, IdentityDatum) },
      utxo.assets,
    )
    .addSigner(ownerAddress);

  const unsignedTx = await tx.complete();
  const signedTx = await unsignedTx.sign.withWallet();
  const submitHash = await (await signedTx.complete()).submit();

  console.log(`Owner transferred. Tx: ${submitHash}`);
}

async function showIdentity(txHash: string, outputIndex: number) {
  const { state } = await loadIdentity(txHash, outputIndex);
  console.log(JSON.stringify(state, null, 2));
}

const [command, ...args] = Deno.args;

try {
  if (command === "prepare") {
    await prepare();
  } else if (command === "init") {
    const [lovelaceAmount] = args;
    if (!lovelaceAmount) throw new Error("Provide lovelace amount.");
    await initIdentity(lovelaceAmount);
  } else if (command === "add-delegate") {
    const [txHash, outputIndex, expiresMs] = args;
    if (!txHash || !outputIndex || !expiresMs) {
      throw new Error("Usage: add-delegate <txHash> <outputIndex> <expiresMs>");
    }
    await addDelegate(txHash, Number(outputIndex), expiresMs);
  } else if (command === "remove-delegate") {
    const [txHash, outputIndex] = args;
    if (!txHash || !outputIndex) {
      throw new Error("Usage: remove-delegate <txHash> <outputIndex>");
    }
    await removeDelegate(txHash, Number(outputIndex));
  } else if (command === "transfer-owner") {
    const [txHash, outputIndex, newOwnerAddress] = args;
    if (!txHash || !outputIndex || !newOwnerAddress) {
      throw new Error(
        "Usage: transfer-owner <txHash> <outputIndex> <newOwnerAddress>",
      );
    }
    await transferOwner(txHash, Number(outputIndex), newOwnerAddress);
  } else if (command === "show") {
    const [txHash, outputIndex] = args;
    if (!txHash || !outputIndex) {
      throw new Error("Usage: show <txHash> <outputIndex>");
    }
    await showIdentity(txHash, Number(outputIndex));
  } else {
    console.log("Commands:");
    console.log("  prepare");
    console.log("  init <lovelaceAmount>");
    console.log("  add-delegate <txHash> <outputIndex> <expiresMs>");
    console.log("  remove-delegate <txHash> <outputIndex>");
    console.log("  transfer-owner <txHash> <outputIndex> <newOwnerAddress>");
    console.log("  show <txHash> <outputIndex>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  Deno.exit(1);
}

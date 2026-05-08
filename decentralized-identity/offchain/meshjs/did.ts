import {
  KoiosProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeDatum,
  mConStr,
  mConStr0,
  resolvePaymentKeyHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Decentralized identity — Mesh.js port.
//
// Validator: no parameters.
// Datum: IdentityDatum { owner: VKH, delegates: List<{ key: VKH, expires: Int }> }
// Redeemer:
//   TransferOwner   = Constr 0 [new_owner: VKH]
//   AddDelegate     = Constr 1 [key: VKH, expires: Int]
//   RemoveDelegate  = Constr 2 [key: VKH]
// ----------------------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;

function loadWallet(walletFile: string): MeshWallet {
  const mnemonic = Deno.readTextFileSync(walletFile).trim();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: new KoiosProvider(NETWORK),
    submitter: new KoiosProvider(NETWORK),
    key: { type: "mnemonic", words: mnemonic.split(" ") },
  });
}

function getScriptInfo() {
  const compiled = blueprint.validators[0].compiledCode;
  const { address: scriptAddress } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script: compiled, scriptAddress };
}

interface DelegateEntry {
  key: string; // VKH hex
  expires: bigint;
}
interface IdentityState {
  owner: string;
  delegates: DelegateEntry[];
}

function decodeDatum(datumHex: string): IdentityState {
  // Constr 0 [bytes, list[Constr 0 [bytes, int]]]
  const decoded = deserializeDatum(datumHex) as {
    fields: Array<
      | { bytes?: string }
      | { list?: Array<{ fields: Array<{ bytes?: string; int?: bigint }> }> }
    >;
  };
  const owner = (decoded.fields[0] as { bytes: string }).bytes;
  const list = (decoded.fields[1] as { list: Array<{ fields: Array<{ bytes?: string; int?: bigint }> }> }).list ?? [];
  const delegates: DelegateEntry[] = list.map((entry) => ({
    key: (entry.fields[0].bytes ?? ""),
    expires: BigInt(entry.fields[1].int ?? 0),
  }));
  return { owner, delegates };
}

function encodeDatum(state: IdentityState): unknown {
  // Mesh: build a Constr-shaped JSON-Data object via mConStr0([...]).
  const delegateList = state.delegates.map((d) =>
    mConStr0([d.key, d.expires]),
  );
  return mConStr0([state.owner, delegateList]);
}

async function findIdentityUtxo(walletFile: string, txHash: string, outputIndex: number) {
  const provider = new KoiosProvider(NETWORK);
  void walletFile;
  const utxos = await provider.fetchUTxOs(txHash);
  const utxo = utxos.find((u) => u.input.outputIndex === outputIndex);
  if (!utxo) throw new Error(`No UTxO at ${txHash}#${outputIndex}`);
  if (!utxo.output.plutusData) throw new Error("UTxO has no inline datum");
  return utxo;
}

export async function init(ownerWalletFile: string, lovelace: string) {
  const wallet = loadWallet(ownerWalletFile);
  const provider = new KoiosProvider(NETWORK);
  const { scriptAddress } = getScriptInfo();
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const datum = encodeDatum({ owner: ownerVkh, delegates: [] });

  const utxos = await provider.fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelace }])
    .txOutInlineDatumValue(datum, "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Identity created at ${scriptAddress}`);
  console.log(`Tx: ${txHash}`);
}

async function rebuildAtScript(
  walletFile: string,
  txHash: string,
  outputIndex: number,
  redeemer: unknown,
  newState: IdentityState,
  validToMs?: number,
) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const { script, scriptAddress } = getScriptInfo();
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const utxo = await findIdentityUtxo(walletFile, txHash, outputIndex);

  const ownUtxos = await provider.fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  let chain = tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(redeemer, "JSON")
    .txInInlineDatumPresent()
    .txOut(scriptAddress, utxo.output.amount)
    .txOutInlineDatumValue(encodeDatum(newState), "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos);

  if (validToMs !== undefined) {
    chain = chain.invalidHereafter(Math.floor(validToMs / 1000));
  }

  await chain.complete();

  const signed = await wallet.signTx(tx.txHex);
  const submitted = await wallet.submitTx(signed);
  return submitted;
}

export async function addDelegate(
  ownerWalletFile: string,
  delegateWalletFile: string,
  txHash: string,
  outputIndex: number,
  expiresMs: string,
) {
  const utxo = await findIdentityUtxo(ownerWalletFile, txHash, outputIndex);
  const state = decodeDatum(utxo.output.plutusData!);

  // Read delegate VKH from the delegate wallet file.
  const delegateWallet = loadWallet(delegateWalletFile);
  const delegateVkh = resolvePaymentKeyHash(await delegateWallet.getChangeAddress());

  if (state.delegates.some((d) => d.key === delegateVkh)) {
    throw new Error("Delegate already exists in the datum.");
  }

  const expires = BigInt(expiresMs);
  if (expires <= BigInt(Date.now())) {
    throw new Error("Expiry must be a future unix timestamp in milliseconds.");
  }

  const newState: IdentityState = {
    owner: state.owner,
    delegates: [...state.delegates, { key: delegateVkh, expires }],
  };
  // AddDelegate = Constr 1 [key, expires]
  const redeemer = mConStr(1, [delegateVkh, expires]);

  const tx = await rebuildAtScript(
    ownerWalletFile,
    txHash,
    outputIndex,
    redeemer,
    newState,
    Number(expires - 1_000n),
  );
  console.log(`Delegate added. Tx: ${tx}`);
}

export async function removeDelegate(
  ownerWalletFile: string,
  delegateWalletFile: string,
  txHash: string,
  outputIndex: number,
) {
  const utxo = await findIdentityUtxo(ownerWalletFile, txHash, outputIndex);
  const state = decodeDatum(utxo.output.plutusData!);

  const delegateWallet = loadWallet(delegateWalletFile);
  const delegateVkh = resolvePaymentKeyHash(await delegateWallet.getChangeAddress());

  if (!state.delegates.some((d) => d.key === delegateVkh)) {
    throw new Error("Delegate not present in the datum.");
  }

  const newState: IdentityState = {
    owner: state.owner,
    delegates: state.delegates.filter((d) => d.key !== delegateVkh),
  };
  // RemoveDelegate = Constr 2 [key]
  const redeemer = mConStr(2, [delegateVkh]);

  const tx = await rebuildAtScript(ownerWalletFile, txHash, outputIndex, redeemer, newState);
  console.log(`Delegate removed. Tx: ${tx}`);
}

export async function transferOwner(
  ownerWalletFile: string,
  txHash: string,
  outputIndex: number,
  newOwnerAddress: string,
) {
  const utxo = await findIdentityUtxo(ownerWalletFile, txHash, outputIndex);
  const state = decodeDatum(utxo.output.plutusData!);

  const newOwnerVkh = resolvePaymentKeyHash(newOwnerAddress);
  const newState: IdentityState = { owner: newOwnerVkh, delegates: state.delegates };
  // TransferOwner = Constr 0 [new_owner]
  const redeemer = mConStr0([newOwnerVkh]);

  const tx = await rebuildAtScript(ownerWalletFile, txHash, outputIndex, redeemer, newState);
  console.log(`Owner transferred. Tx: ${tx}`);
}

export async function show(txHash: string, outputIndex: number) {
  const provider = new KoiosProvider(NETWORK);
  const utxos = await provider.fetchUTxOs(txHash);
  const utxo = utxos.find((u) => u.input.outputIndex === outputIndex);
  if (!utxo?.output.plutusData) throw new Error("No datum at provided UTxO");
  const state = decodeDatum(utxo.output.plutusData);
  console.log(JSON.stringify(
    { owner: state.owner, delegates: state.delegates.map((d) => ({ key: d.key, expires: d.expires.toString() })) },
    null,
    2,
  ));
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "init") {
      if (args.length !== 2) throw new Error("Usage: init <owner_wallet> <lovelace>");
      await init(args[0], args[1]);
    } else if (cmd === "add-delegate") {
      if (args.length !== 5) {
        throw new Error(
          "Usage: add-delegate <owner_wallet> <delegate_wallet> <txHash> <outputIndex> <expiresMs>",
        );
      }
      await addDelegate(args[0], args[1], args[2], Number(args[3]), args[4]);
    } else if (cmd === "remove-delegate") {
      if (args.length !== 4) {
        throw new Error(
          "Usage: remove-delegate <owner_wallet> <delegate_wallet> <txHash> <outputIndex>",
        );
      }
      await removeDelegate(args[0], args[1], args[2], Number(args[3]));
    } else if (cmd === "transfer-owner") {
      if (args.length !== 4) {
        throw new Error(
          "Usage: transfer-owner <owner_wallet> <txHash> <outputIndex> <newOwnerAddress>",
        );
      }
      await transferOwner(args[0], args[1], Number(args[2]), args[3]);
    } else if (cmd === "show") {
      if (args.length !== 2) throw new Error("Usage: show <txHash> <outputIndex>");
      await show(args[0], Number(args[1]));
    } else {
      console.log("Commands:");
      console.log("  init <owner_wallet> <lovelace>");
      console.log("  add-delegate <owner_wallet> <delegate_wallet> <txHash> <outputIndex> <expiresMs>");
      console.log("  remove-delegate <owner_wallet> <delegate_wallet> <txHash> <outputIndex>");
      console.log("  transfer-owner <owner_wallet> <txHash> <outputIndex> <newOwnerAddress>");
      console.log("  show <txHash> <outputIndex>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}

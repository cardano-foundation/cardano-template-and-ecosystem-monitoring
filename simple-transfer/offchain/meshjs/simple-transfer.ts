import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  mConStr0,
  resolvePaymentKeyHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Simple transfer: parameterized validator (receiver_vkh); only the recipient may claim.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const FUNDER_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

function provider(): BlockfrostProvider {
  return new BlockfrostProvider(YACI_URL);
}

function makeWallet(words: string[]): MeshWallet {
  const p = provider();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: p,
    submitter: p,
    key: { type: "mnemonic", words },
  });
}

function funder(): MeshWallet {
  return makeWallet(FUNDER_MNEMONIC.split(/\s+/));
}

async function waitForUtxoAt(addr: string, minCount = 1, timeoutSec = 60): Promise<void> {
  const p = provider();
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const utxos = await p.fetchAddressUTxOs(addr);
      if (utxos.length >= minCount) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${addr}`);
}

async function fundFromFunder(targetAddr: string, lovelace: bigint): Promise<void> {
  const wallet = funder();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(targetAddr, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .changeAddress(myAddr)
    .selectUtxosFrom(myUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targetAddr} with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxoAt(targetAddr, 1);
}

function buildScript(receiverVkh: string) {
  const validator = blueprint.validators.find(
    (v) => v.title === "simple_transfer.simpleTransfer.spend",
  );
  if (!validator) throw new Error("Validator not found");
  const script = applyParamsToScript(
    validator.compiledCode,
    [builtinByteString(receiverVkh)],
    "JSON",
  );
  const { address } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress: address };
}

async function lock(senderWallet: MeshWallet, receiverAddr: string, lovelace: bigint) {
  const senderAddr = await senderWallet.getChangeAddress();
  const receiverVkh = resolvePaymentKeyHash(receiverAddr);
  const { scriptAddress } = buildScript(receiverVkh);

  const utxos = await provider().fetchAddressUTxOs(senderAddr);
  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelace.toString() }])
    // Mesh-shape {alternative,fields}: default encoder here is "Mesh", not "JSON" —
    // a JSON-shape {constructor,fields} value would silently produce the wrong CBOR.
    .txOutInlineDatumValue({ alternative: 0, fields: [] })
    .changeAddress(senderAddr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await senderWallet.signTx(tx.txHex);
  const txHash = await senderWallet.submitTx(signed);
  console.log(`LOCK ok. ${lovelace} lovelace to ${scriptAddress}. tx=${txHash}`);
  await waitForUtxoAt(scriptAddress, 1);
  return scriptAddress;
}

async function claim(receiverWallet: MeshWallet) {
  const receiverAddr = await receiverWallet.getChangeAddress();
  const receiverVkh = resolvePaymentKeyHash(receiverAddr);
  const { script, scriptAddress } = buildScript(receiverVkh);

  const scriptUtxos = await provider().fetchAddressUTxOs(scriptAddress);
  if (scriptUtxos.length === 0) throw new Error("No script UTxOs to claim");
  const target = scriptUtxos[0];

  const ownUtxos = await provider().fetchAddressUTxOs(receiverAddr);
  const collateral: UTxO[] = await receiverWallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider(),
    submitter: provider(),
  }).setNetwork(NETWORK);

  await tx
    .spendingPlutusScriptV3()
    .txIn(target.input.txHash, target.input.outputIndex, target.output.amount, target.output.address)
    .txInScript(script)
    .txInRedeemerValue("")
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(receiverVkh)
    .changeAddress(receiverAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await receiverWallet.signTx(tx.txHex);
  const txHash = await receiverWallet.submitTx(signed);
  console.log(`CLAIM ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== simple-transfer scenario: lock → claim ===");

  // Brewed recipient: gives a pure-ADA wallet (no leftover assets) for clean collateral on yaci.
  const recipient = makeWallet(MeshWallet.brew(false) as string[]);
  const recipientAddr = await recipient.getChangeAddress();
  await fundFromFunder(recipientAddr, 25_000_000n);

  await lock(funder(), recipientAddr, 10_000_000n);
  await claim(recipient);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}

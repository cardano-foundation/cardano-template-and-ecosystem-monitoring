import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  list,
  mConStr0,
  resolvePaymentKeyHash,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Payment splitter — Mesh.js targeting yaci-devkit.
// Validator parameter: list of payee VKHs. Spend rule: split locked lovelace
// equally to all payees. The PAYER must also be a payee (otherwise its change
// output's credential would be flagged as "additional payee").
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const FUNDER_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const PAYEE_COUNT = 5;

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
function funderWallet(): MeshWallet {
  return makeWallet(FUNDER_MNEMONIC.split(/\s+/));
}

async function waitForUtxoAt(addr: string, minCount = 1, timeoutSec = 60) {
  const p = provider();
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await p.fetchAddressUTxOs(addr);
      if (u.length >= minCount) return;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${addr}`);
}

async function fundFromFunder(targets: Array<{ addr: string; lovelace: bigint }>) {
  const wallet = funderWallet();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx as unknown as MeshTxBuilder;
  for (const t of targets) {
    b = b.txOut(t.addr, [{ unit: "lovelace", quantity: t.lovelace.toString() }]);
  }
  await b.changeAddress(myAddr).selectUtxosFrom(myUtxos).complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targets.length} addr(s). tx=${txHash}`);
  for (const t of targets) await waitForUtxoAt(t.addr, 1);
}

function getScriptInfo(payeeVkhs: string[]) {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(
    compiled,
    [list(payeeVkhs.map((vkh) => builtinByteString(vkh)))],
    "JSON",
  );
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress };
}

async function lockAda(payer: MeshWallet, payeeVkhs: string[], lovelace: bigint) {
  const myAddr = await payer.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(myAddr);
  const { scriptAddress } = getScriptInfo(payeeVkhs);

  const utxos = await provider().fetchAddressUTxOs(myAddr);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .txOutInlineDatumValue(mConStr0([ownerVkh]))
    .changeAddress(myAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await payer.signTx(tx.txHex);
  const txHash = await payer.submitTx(signed);
  console.log(`LOCK ok. ${lovelace} lovelace. tx=${txHash}`);
}

async function payout(
  payer: MeshWallet,
  payeeAddrs: string[],
  payeeVkhs: string[],
) {
  const myAddr = await payer.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(myAddr);
  const { script, scriptAddress } = getScriptInfo(payeeVkhs);

  let scriptUtxos: UTxO[] = [];
  for (let i = 0; i < 60; i++) {
    scriptUtxos = await provider().fetchAddressUTxOs(scriptAddress);
    if (scriptUtxos.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (scriptUtxos.length === 0) throw new Error("No script UTxOs to spend");
  const utxo = scriptUtxos[0];
  const totalLovelace = BigInt(
    utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity,
  );
  const share = totalLovelace / BigInt(PAYEE_COUNT);

  const ownUtxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await payer.getCollateral();
  const redeemer = mConStr0([stringToHex("payout")]);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(redeemer)
    .txInInlineDatumPresent();
  for (const addr of payeeAddrs) {
    b = b.txOut(addr, [{ unit: "lovelace", quantity: share.toString() }]);
  }
  await b
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .changeAddress(myAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await payer.signTx(tx.txHex, true);
  const txHash = await payer.submitTx(signed);
  console.log(`PAYOUT ok. share=${share} tx=${txHash}`);
}

async function runScenario() {
  console.log("=== payment-splitter scenario: lock → payout ===");
  // Generate 5 brewed payees; payee[0] is the payer (must be one of the
  // payees so its change output doesn't introduce a non-payee credential).
  const payeeWallets: MeshWallet[] = [];
  const payeeAddrs: string[] = [];
  const payeeVkhs: string[] = [];
  for (let i = 0; i < PAYEE_COUNT; i++) {
    const w = makeWallet(MeshWallet.brew(false) as string[]);
    payeeWallets.push(w);
    const a = await w.getChangeAddress();
    payeeAddrs.push(a);
    payeeVkhs.push(resolvePaymentKeyHash(a));
  }
  // Fund payer (account 0 here = payee[0]) with enough to cover lock + fees.
  await fundFromFunder([{ addr: payeeAddrs[0], lovelace: 80_000_000n }]);

  await lockAda(payeeWallets[0], payeeVkhs, 50_000_000n);
  await new Promise((r) => setTimeout(r, 3000));
  await payout(payeeWallets[0], payeeAddrs, payeeVkhs);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}

import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeDatum,
  mConStr0,
  resolvePaymentKeyHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Vesting: spend if owner signs OR (beneficiary signs AND now > lock_until). Scenario runs both.
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

function funderWallet(): MeshWallet {
  return makeWallet(FUNDER_MNEMONIC.split(/\s+/));
}

async function yaciTipSlot(): Promise<number> {
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  return block.slot;
}

async function yaciSystemStartSec(): Promise<number> {
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  // ERA_OFFSET = 600s: TxInfo POSIX is computed from systemStart + 600 in yaci/Babbage devnet.
  return block.time - block.slot + 600;
}

function slotToMs(slot: number, systemStartSec: number): number {
  return (systemStartSec + slot) * 1000;
}

async function waitForUtxoAt(addr: string, minCount = 1, timeoutSec = 60) {
  const p = provider();
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await p.fetchAddressUTxOs(addr);
      if (u.length >= minCount) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${addr}`);
}

async function waitForTx(txHash: string, outputIndex = 0, timeoutSec = 60): Promise<UTxO> {
  const p = provider();
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const utxos = await p.fetchUTxOs(txHash);
      const u = utxos.find((x) => x.input.outputIndex === outputIndex);
      if (u) return u;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${txHash}#${outputIndex}`);
}

async function fundFromFunder(targetAddr: string, lovelace: bigint) {
  const wallet = funderWallet();
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
  console.log(`Funded ${targetAddr.slice(0, 20)}… with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxoAt(targetAddr, 1);
}

function loadValidator() {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(compiled, [], "JSON");
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress };
}

async function deposit(
  owner: MeshWallet,
  ownerVkh: string,
  beneficiaryVkh: string,
  lovelace: bigint,
  lockUntilMs: number,
): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const { scriptAddress } = loadValidator();
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .txOutInlineDatumValue(mConStr0([lockUntilMs, ownerVkh, beneficiaryVkh]))
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`DEPOSIT ok. lockUntilMs=${lockUntilMs} tx=${txHash}`);
  return txHash;
}

async function withdraw(
  wallet: MeshWallet,
  utxo: UTxO,
  options: { invalidBeforeSlot?: number } = {},
) {
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const { script, scriptAddress } = loadValidator();
  const ownUtxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let builder = tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue("")
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(myVkh)
    .changeAddress(myAddr)
    .selectUtxosFrom(ownUtxos);
  if (options.invalidBeforeSlot !== undefined) {
    builder = builder.invalidBefore(options.invalidBeforeSlot);
  }
  await builder.complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`WITHDRAW ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== vesting scenario: deposit×2 → owner-withdraw / beneficiary-withdraw ===");
  // Roles: owner deposits + may always withdraw; beneficiary may only withdraw past lock_until.
  const owner = makeWallet(MeshWallet.brew(false) as string[]);
  const beneficiary = makeWallet(MeshWallet.brew(false) as string[]);
  const ownerAddr = await owner.getChangeAddress();
  const benAddr = await beneficiary.getChangeAddress();
  await fundFromFunder(ownerAddr, 30_000_000n);
  await fundFromFunder(benAddr, 20_000_000n);

  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const benVkh = resolvePaymentKeyHash(benAddr);

  const lockUntilFar = Date.now() + 60 * 60 * 1000;
  const tx1 = await deposit(owner, ownerVkh, benVkh, 5_000_000n, lockUntilFar);
  // Wait for the owner's change UTxO (deposit output #1) to be indexed before the next deposit —
  // otherwise mesh may re-select the still-spent input and the second tx fails UTxO selection.
  await waitForTx(tx1, 1, 60);
  await new Promise((r) => setTimeout(r, 2000));

  const systemStartSec = await yaciSystemStartSec();
  const tipSlot = await yaciTipSlot();
  const lockShortSlot = tipSlot + 10;
  const lockUntilShort = slotToMs(lockShortSlot, systemStartSec);
  const tx2 = await deposit(owner, ownerVkh, benVkh, 5_000_000n, lockUntilShort);
  await new Promise((r) => setTimeout(r, 2000));

  const u1 = await waitForTx(tx1, 0);
  await withdraw(owner, u1);

  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > lockShortSlot) {
      console.log(`tipSlot ${tip} > lockShortSlot ${lockShortSlot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${lockShortSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Beneficiary path needs `valid_after(lock_until)` — invalidBefore strictly after lockShortSlot.
  const u2 = await waitForTx(tx2, 0);
  await withdraw(beneficiary, u2, { invalidBeforeSlot: lockShortSlot + 1 });

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}

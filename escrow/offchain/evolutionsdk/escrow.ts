import {
  Lucid,
  Blockfrost,
  Data,
  type Assets,
  type LucidEvolution,
  validatorToAddress,
  type Validator,
  getAddressDetails,
} from "@evolution-sdk/lucid";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };
import { EscrowDatum, EscrowRedeemer } from "./types.ts";

// ----------------------------------------------------------------------------
// Two-party escrow. Single PlutusV3 spend validator threading the
// Initiation -> ActiveEscrow datum machine via RecipientDeposit /
// CompleteTrade / CancelTrade redeemers. CompleteTrade requires both
// parties' signatures, hence the partialSign + assemble dance.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

async function lucidAt(accountIndex: number): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(TEST_MNEMONIC, { accountIndex });
  return lucid;
}

async function waitForUtxosAt(
  lucid: LucidEvolution,
  address: string,
  minCount: number,
  timeoutSec = 60,
) {
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await lucid.utxosAt(address);
      if (u.length >= minCount) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${address}`);
}

async function waitForOutRef(
  lucid: LucidEvolution,
  txHash: string,
  outputIndex = 0,
  timeoutSec = 60,
) {
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await lucid.utxosByOutRef([{ txHash, outputIndex }]);
      if (u.length > 0) return u[0];
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${txHash}#${outputIndex}`);
}

async function fundFromIndex0(targets: Array<{ address: string; lovelace: bigint }>) {
  const lucid = await lucidAt(0);
  let txb = lucid.newTx();
  for (const t of targets) txb = txb.pay.ToAddress(t.address, { lovelace: t.lovelace });
  const tx = await txb.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Funded ${targets.length} target(s). tx=${txHash}`);
  for (const t of targets) await waitForUtxosAt(lucid, t.address, 1, 60);
  await new Promise((r) => setTimeout(r, 2000));
}

function setup() {
  const validator: Validator = {
    type: "PlutusV3",
    script: blueprint.validators[0].compiledCode,
  };
  return { validator, scriptAddress: validatorToAddress(NETWORK, validator) };
}

function addressToData(addr: string) {
  const d = getAddressDetails(addr);
  const pc = d.paymentCredential!;
  const sc = d.stakeCredential;
  return {
    payment_credential: pc.type === "Key"
      ? { VerificationKey: [pc.hash] as [string] }
      : { Script: [pc.hash] as [string] },
    stake_credential: sc
      ? {
        Inline: [
          sc.type === "Key"
            ? { VerificationKey: [sc.hash] as [string] }
            : { Script: [sc.hash] as [string] },
        ] as [unknown],
      }
      : null,
  };
}

function assetsToMValue(assets: Assets): Map<string, Map<string, bigint>> {
  const m = new Map<string, Map<string, bigint>>();
  for (const [unit, q] of Object.entries(assets)) {
    const policy = unit === "lovelace" ? "" : unit.slice(0, 56);
    const name = unit === "lovelace" ? "" : unit.slice(56);
    const inner = m.get(policy) ?? new Map<string, bigint>();
    inner.set(name, q);
    m.set(policy, inner);
  }
  return m;
}

function mergeAssets(a: Assets, b: Assets): Assets {
  const out: Assets = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0n) + v;
  return out;
}

async function initiate(initiator: LucidEvolution, assets: Assets): Promise<string> {
  const { scriptAddress } = setup();
  const initAddr = await initiator.wallet().address();
  const datum = Data.to(
    {
      Initiation: {
        initiator: addressToData(initAddr),
        initiator_assets: assetsToMValue(assets),
      },
    } as never,
    EscrowDatum as never,
  );
  const tx = await initiator
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, assets)
    .addSigner(initAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`INITIATE ok. tx=${txHash}`);
  return txHash;
}

async function deposit(
  recipient: LucidEvolution,
  initTxHash: string,
  recipientAssets: Assets,
): Promise<string> {
  const { validator, scriptAddress } = setup();
  const recipientAddr = await recipient.wallet().address();
  const utxo = await waitForOutRef(recipient, initTxHash, 0);
  if (!utxo.datum) throw new Error("UTxO missing datum");
  const inputDatum = Data.from(utxo.datum, EscrowDatum as never) as {
    Initiation: { initiator: unknown; initiator_assets: unknown };
  };
  if (!("Initiation" in inputDatum)) throw new Error("Not in Initiation state");
  const { initiator, initiator_assets } = inputDatum.Initiation;

  const redeemer = Data.to(
    {
      RecipientDeposit: {
        recipient: addressToData(recipientAddr),
        recipient_assets: assetsToMValue(recipientAssets),
      },
    } as never,
    EscrowRedeemer as never,
  );
  const outputDatum = Data.to(
    {
      ActiveEscrow: {
        initiator,
        recipient: addressToData(recipientAddr),
        initiator_assets,
        recipient_assets: assetsToMValue(recipientAssets),
      },
    } as never,
    EscrowDatum as never,
  );
  const totalValue = mergeAssets(utxo.assets, recipientAssets);
  const tx = await recipient
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToContract(scriptAddress, { kind: "inline", value: outputDatum }, totalValue)
    .addSigner(recipientAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`DEPOSIT ok. tx=${txHash}`);
  return txHash;
}

async function completeTrade(
  initiator: LucidEvolution,
  recipient: LucidEvolution,
  activeTx: string,
  initiatorAddr: string,
  recipientAddr: string,
  initiatorAssets: Assets,
  recipientAssets: Assets,
) {
  const { validator } = setup();
  const utxo = await waitForOutRef(initiator, activeTx, 0);
  const redeemer = Data.to("CompleteTrade", EscrowRedeemer as never);

  const tx = await initiator
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToAddress(initiatorAddr, recipientAssets)
    .pay.ToAddress(recipientAddr, initiatorAssets)
    .addSigner(initiatorAddr)
    .addSigner(recipientAddr)
    .complete();
  const partial1 = await initiator.fromTx(tx.toCBOR()).partialSign.withWallet();
  const partial2 = await recipient.fromTx(tx.toCBOR()).partialSign.withWallet();
  const signed = await tx.sign.withWallet().assemble([partial1, partial2]).complete();
  const txHash = await signed.submit();
  console.log(`COMPLETE ok. tx=${txHash}`);
}

async function cancelInInitiation(
  initiator: LucidEvolution,
  initTxHash: string,
  initiatorAddr: string,
) {
  const { validator } = setup();
  const utxo = await waitForOutRef(initiator, initTxHash, 0);
  const redeemer = Data.to("CancelTrade", EscrowRedeemer as never);
  const tx = await initiator
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToAddress(initiatorAddr, utxo.assets)
    .addSigner(initiatorAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CANCEL (initiation) ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== escrow scenario: initiate → deposit → complete-trade ; initiate → cancel ===");
  // account 0 = funder ; 1 = initiator ; 2 = recipient
  const initiator = await lucidAt(1);
  const recipient = await lucidAt(2);
  const initAddr = await initiator.wallet().address();
  const recipAddr = await recipient.wallet().address();
  await fundFromIndex0([
    { address: initAddr, lovelace: 30_000_000n },
    { address: recipAddr, lovelace: 30_000_000n },
  ]);

  const initiatorAssets: Assets = { lovelace: 5_000_000n };
  const recipientAssets: Assets = { lovelace: 7_000_000n };
  const initTx = await initiate(initiator, initiatorAssets);
  await new Promise((r) => setTimeout(r, 2000));
  const activeTx = await deposit(recipient, initTx, recipientAssets);
  await new Promise((r) => setTimeout(r, 2000));
  await completeTrade(
    initiator,
    recipient,
    activeTx,
    initAddr,
    recipAddr,
    initiatorAssets,
    recipientAssets,
  );
  await new Promise((r) => setTimeout(r, 2000));

  const initTx2 = await initiate(initiator, { lovelace: 4_000_000n });
  await new Promise((r) => setTimeout(r, 2000));
  await cancelInInitiation(initiator, initTx2, initAddr);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}

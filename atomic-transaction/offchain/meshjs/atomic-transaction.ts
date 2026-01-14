import {
  applyParamsToScript,
  conStr0,
  DEFAULT_REDEEMER_BUDGET,
  KoiosProvider,
  MeshTxBuilder,
  MeshWallet,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializePlutusScript,
  stringToHex,
  UTxO
} from '@meshsdk/core';

import blueprint from '../../onchain/aiken/plutus.json' with { type: 'json' };
import { alwaysSucceedCbor, alwaysSucceedHash } from './test-util.ts';

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const NETWORK = 'preprod';
const NETWORK_ID = 0;

// ------------------------------------------------------------
// Wallet helpers
// ------------------------------------------------------------

function loadWalletFromFile(path: string): MeshWallet {
  const mnemonic = JSON.parse(Deno.readTextFileSync(path));
  const provider = new KoiosProvider(NETWORK);

  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: provider,
    submitter: provider,
    key: {
      type: 'mnemonic',
      words: mnemonic
    }
  });
}

// ------------------------------------------------------------
// Script helpers
// ------------------------------------------------------------

function getValidator(name: string) {
  const v = blueprint.validators.find(v =>
    v.title.startsWith(name)
  );
  if (!v) throw new Error(`Validator not found: ${name}`);
  return v.compiledCode;
}

function getScriptAddress(compiled: string) {
  const { address } = serializePlutusScript(
    { code: compiled, version: 'V3' },
    undefined,
    NETWORK_ID
  );
  return address;
}

function getScriptDetails(scriptName: string) {
  const script = applyParamsToScript(
    getValidator(scriptName),
    [],
    'JSON'
  );

  return {
    script,
    address: getScriptAddress(script),
    policyId: resolveScriptHash(script, 'V3')
  };
}

// ------------------------------------------------------------
// Utils
// ------------------------------------------------------------

async function waitForScriptUtxo(
  provider: KoiosProvider,
  address: string,
  retries = 5,
  delayMs = 20_000
): Promise<UTxO> {

  console.log('Polling blockchain ledger to detect script utxo');
  for (let i = 0; i < retries; i++) {
    const utxos = await provider.fetchAddressUTxOs(address);
    if (utxos.length) {
      console.log('Script UTxO found');
      return utxos[0];
    }
    console.log('Waiting for 20 seconds before next check..');
    await new Promise(r => setTimeout(r, delayMs));
  }

  throw new Error('Script UTxO not found');
}

export const atomicMintRedeemer = (password: string) =>
  conStr0([
    { bytes: stringToHex(password) }
  ]);

// ------------------------------------------------------------
// Atomic transaction demo
// ------------------------------------------------------------

export async function atomicTransaction(walletFile: string) {
  const wallet = loadWalletFromFile(walletFile);
  const provider = new KoiosProvider(NETWORK);

  const changeAddr = await wallet.getChangeAddress();
  const signerPkh = resolvePaymentKeyHash(changeAddr);

  const collateral = await wallet.getCollateral();
  if (!collateral.length) throw new Error('No collateral UTxO');

  const walletUtxos = await provider.fetchAddressUTxOs(changeAddr);
  if (!walletUtxos.length) throw new Error('No wallet UTxOs');

  const {
    script: atomicScript,
    address: atomicScriptAddress,
    policyId: atomicPolicyId
  } = getScriptDetails('atomic.placeholder');

  // --------------------------------------------------------
  // STEP 1: Mint using always-success policy, lock at script
  // --------------------------------------------------------

  console.log('Step 1: Minting (using always succeed script) and locking at script');

  const tx1 = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider
  }).setNetwork(NETWORK);

  const scriptUtxoTokenNameHex = stringToHex('ScriptUtxoToken');
  await tx1
    .txIn(
      walletUtxos[0].input.txHash,
      walletUtxos[0].input.outputIndex,
      walletUtxos[0].output.amount,
      walletUtxos[0].output.address
    )

    // Mint via always-success policy
    .mintPlutusScriptV3()
    .mint('1', alwaysSucceedHash, scriptUtxoTokenNameHex)
    .mintingScript(alwaysSucceedCbor)
    .mintRedeemerValue({ alternative: 0, fields: [] })

    // Lock minted token at atomic script
    .txOut(atomicScriptAddress, [
      { unit: 'lovelace', quantity: '3000000' },
      { unit: alwaysSucceedHash + scriptUtxoTokenNameHex, quantity: '1' }
    ])
    .txOutInlineDatumValue({ alternative: 0, fields: [] })

    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address
    )
    .requiredSignerHash(signerPkh)
    .changeAddress(changeAddr)
    .selectUtxosFrom(walletUtxos)
    .complete();

  const signed1 = await wallet.signTx(tx1.txHex);
  const txHash1 = await wallet.submitTx(signed1);
  console.log('Script utxo setup tx submitted: Tx hash: ', txHash1);

  // --------------------------------------------------------
  // STEP 2: Wait for script UTxO to be confirmed on chain
  // --------------------------------------------------------

  const scriptUtxo = await waitForScriptUtxo(
    provider,
    atomicScriptAddress
  );

  // --------------------------------------------------------
  // STEP 3: Atomic transaction : spend + password-gated mint
  // --------------------------------------------------------

  console.log('Step 2: Executing atomic spend + mint');

  const tx2 = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider
  }).setNetwork(NETWORK);


  let superSecretPassword = 'super_secret_password';
  await tx2
    .mintPlutusScriptV3()
    .mint('1', atomicPolicyId, stringToHex('AtomicTxToken'))
    .mintingScript(atomicScript)
    .mintRedeemerValue(
      atomicMintRedeemer(superSecretPassword),
      'JSON',
      DEFAULT_REDEEMER_BUDGET
    )

    // Spend from script (always true)
    .spendingPlutusScriptV3()
    .txIn(
      scriptUtxo.input.txHash,
      scriptUtxo.input.outputIndex,
      scriptUtxo.output.amount,
      atomicScriptAddress
    )
    .txInInlineDatumPresent()
    .txInRedeemerValue('')
    .txInScript(atomicScript)

    // Collect tokens
    .txOut(changeAddr, [
      { unit: 'lovelace', quantity: '2000000' }, // 2 ADA safety floor
      ...scriptUtxo.output.amount.filter(a => a.unit !== 'lovelace')
    ])

    .txOut(changeAddr, [
      { unit: 'lovelace', quantity: '2000000' }, // 2 ADA safety floor
      { unit: atomicPolicyId + stringToHex('AtomicTxToken'), quantity: '1' }
    ])

    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address
    )
    .requiredSignerHash(signerPkh)
    .changeAddress(changeAddr)
    .selectUtxosFrom(walletUtxos)
    .complete();

  const signed2 = await wallet.signTx(tx2.txHex);
  const txHash2 = await wallet.submitTx(signed2);

  console.log('Atomic transaction submitted: Tx hash: ', txHash2);
}

// ------------------------------------------------------------
// CLI
// ------------------------------------------------------------

function printUsage() {
  console.log(
    'Usage:\n\n' +
    '  deno run -A atomic-transaction.ts run <wallet.json>\n'
  );
}

async function main() {
  const [command, ...args] = Deno.args;

  if (command !== 'run' || args.length !== 1) {
    printUsage();
    Deno.exit(1);
  }

  await atomicTransaction(args[0]);
}

if (import.meta.main) {
  main().catch(err => {
    console.error('❌ Error:', err);
    Deno.exit(1);
  });
}

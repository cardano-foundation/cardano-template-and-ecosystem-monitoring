import {
  Lucid,
  LucidEvolution,
  Koios,
  Data,
  fromText,
  Constr,
  generateSeedPhrase,
  MintingPolicy,
  SpendingValidator,
  validatorToAddress,
  validatorToScriptHash,
} from '@evolution-sdk/lucid';
import blueprint from '../../onchain/aiken/plutus.json' with { type: 'json' };

// Helper to get policy ID from a MintingPolicy
function mintingPolicyToId(policy: MintingPolicy): string {
  return validatorToScriptHash(policy);
}

// Helper to select wallet from file
function selectWallet(lucid: LucidEvolution, index: string | number) {
  const fileName = `wallet_${index}.txt`;
  try {
    const mnemonic = Deno.readTextFileSync(fileName).trim();
    lucid.selectWallet.fromSeed(mnemonic);
  } catch {
    console.error(`Error reading ${fileName}. Run 'prepare' first.`);
    Deno.exit(1);
  }
}

async function prepare(amount: number) {
  for (let i = 0; i < amount; i++) {
    const fileName = `wallet_${i}.txt`;
    try {
      await Deno.stat(fileName);
      console.log(`${fileName} already exists, skipping.`);
    } catch {
      const mnemonic = generateSeedPhrase();
      await Deno.writeTextFile(fileName, mnemonic);
      const lucid = await Lucid(
        new Koios('https://preprod.koios.rest/api/v1'),
        'Preprod',
      );
      lucid.selectWallet.fromSeed(mnemonic);
      console.log(
        `Generated ${fileName}. Address: ${await lucid.wallet().address()}`,
      );
    }
  }
}

// Mint and lock the asset atomically using ToContract
async function mintAndLock(walletIndex: string | number = 0) {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod',
  );
  selectWallet(lucid, walletIndex);

  const validator = blueprint.validators.find(
    (v) => v.title === 'atomic.placeholder.mint',
  );
  if (!validator) throw new Error('Minting validator not found');

  const spendValidator: SpendingValidator = {
    type: 'PlutusV3',
    script: validator.compiledCode,
  };

  const mintValidator: MintingPolicy = {
    type: 'PlutusV3',
    script: validator.compiledCode,
  };

  const policyId = mintingPolicyToId(mintValidator);
  const assetName = fromText('AtomicToken');
  const unit = policyId + assetName;

  const redeemer = Data.to(new Constr(0, [fromText('super_secret_password')]));

  const scriptAddress = validatorToAddress('Preprod', spendValidator);

  try {
    const tx = await lucid
      .newTx()
      .mintAssets({ [unit]: 1n }, redeemer)
      .attach.MintingPolicy(mintValidator)
      .pay.ToContract(scriptAddress, { kind: 'inline', value: redeemer }, { [unit]: 1n })
      .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();

    console.log(
      `Minted and locked 1 AtomicToken at script. Tx Hash: ${txHash}`,
    );
    console.log(`Asset ID: ${unit}`);
    console.log(`Script address: ${scriptAddress}`);
  } catch (e) {
    console.error('Minting+locking failed:', e);
  }
}

// Collect the UTXO from the script address (spend script)
async function collect(walletIndex: string | number = 0) {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod',
  );
  selectWallet(lucid, walletIndex);

  const validator = blueprint.validators.find(
    (v) => v.title === 'atomic.placeholder.mint',
  );
  if (!validator) throw new Error('Validator not found');

  const spendValidator: SpendingValidator = {
    type: 'PlutusV3',
    script: validator.compiledCode,
  };

  const mintValidator: MintingPolicy = {
    type: 'PlutusV3',
    script: validator.compiledCode,
  };

  const policyId = mintingPolicyToId(mintValidator);
  const assetName = fromText('AtomicToken');
  const unit = policyId + assetName;

  const redeemer = Data.to(new Constr(0, [fromText('super_secret_password')]));

  const scriptAddress = validatorToAddress('Preprod', spendValidator);

  // Find the UTXO at the script address with the asset
  const utxos = await lucid.utxosAt(scriptAddress);
  const targetUtxo = utxos.find((u) => u.assets[unit] && u.assets[unit] === 1n);
  if (!targetUtxo) {
    console.error('No AtomicToken UTXO found at script address');
    return;
  }

  try {
    const tx = await lucid
      .newTx()
      .collectFrom([targetUtxo], redeemer)
      .mintAssets({ [unit]: 1n }, redeemer) // Atomic: Mint 1 new token while spending
      .attach.SpendingValidator(spendValidator)
      .attach.MintingPolicy(mintValidator)
      .pay.ToAddress(await lucid.wallet().address(), { [unit]: 2n }) // 1 from script + 1 minted
      .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    console.log(`Collected AtomicToken from script. Tx Hash: ${txHash}`);
  } catch (e) {
    console.error('Collecting failed:', e);
  }
}

async function test(walletIndex: string | number = 0) {
  console.log('--- Starting Atomic Transaction Test ---');
  
  console.log('\n1. MINT & LOCK');
  await mintAndLock(walletIndex);
  
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n2. COLLECT (Atomic Spend + Mint)');
  await collect(walletIndex);

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n3. BURN');
  // We expect 2 tokens now (1 from lock, 1 from atomic mint)
  await burn(walletIndex, '2');
  
  console.log('\n--- Test Complete ---');
}

// Burn tokens
async function burn(walletIndex: string | number = 0, amountStr: string = '1') {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod',
  );
  selectWallet(lucid, walletIndex);

  const validator = blueprint.validators.find(
    (v) => v.title === 'atomic.placeholder.mint',
  );
  if (!validator) throw new Error('Minting validator not found');

  const mintValidator: MintingPolicy = {
    type: 'PlutusV3',
    script: validator.compiledCode,
  };

  const policyId = mintingPolicyToId(mintValidator);
  const assetName = fromText('AtomicToken');
  const unit = policyId + assetName;

  const redeemer = Data.to(new Constr(0, [fromText('super_secret_password')]));

  const amount = BigInt(amountStr) * -1n;

  try {
    const tx = await lucid
      .newTx()
      .mintAssets({ [unit]: amount }, redeemer)
      .attach.MintingPolicy(mintValidator)
      .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    console.log(`Burned ${-amount} AtomicToken. Tx Hash: ${txHash}`);
  } catch (e) {
    console.error('Burning failed:', e);
  }
}

if (import.meta.main) {
  const args = Deno.args;
  if (args.length === 0) {
    console.log(
      'Commands: mintAndLock [walletIndex], collect [walletIndex], burn [walletIndex] [amount], prepare <count>, test [walletIndex]',
    );
    Deno.exit(1);
  }

  const cmd = args[0];

  if (cmd === 'mintAndLock') {
    await mintAndLock(args[1] || 0);
  } else if (cmd === 'collect') {
    await collect(args[1] || 0);
  } else if (cmd === 'burn') {
    await burn(args[1] || 0, args[2] || '1');
  } else if (cmd === 'test') {
    await test(args[1] || 0);
  } else if (cmd === 'prepare') {
    if (args[1]) await prepare(parseInt(args[1]));
    else console.log('Provide count');
  } else {
    console.log('Unknown command');
  }
}

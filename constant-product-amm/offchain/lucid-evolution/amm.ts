import {
  Constr,
  Data,
  Koios,
  Lucid,
  LucidEvolution,
  validatorToAddress,
  validatorToScriptHash,
  Validator,
  Script,
  generateSeedPhrase,
  applyParamsToScript,
  Redeemer,
  toUnit,
  fromText,
} from "@evolution-sdk/lucid";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const PoolDatumSchema = Data.Object({
  reserve_a: Data.Integer(),
  reserve_b: Data.Integer(),
  lp_supply: Data.Integer(),
});

type PoolDatum = Data.Static<typeof PoolDatumSchema>;
const PoolDatum = PoolDatumSchema as unknown as PoolDatum;

// Action redeemer: Swap { min_output: Int } | AddLiquidity | RemoveLiquidity
// In Aiken, this is represented as:
// - Swap: Constr(0, [min_output])
// - AddLiquidity: Constr(1, [])
// - RemoveLiquidity: Constr(2, [])

const NETWORK = "Preprod" as const;
const KOIOS_URL = "https://preprod.koios.rest/api/v1";

// Example parameters - in production these would be actual token policies
// For demo purposes, using placeholder hex strings (28 bytes = 56 hex chars for policy IDs)
const TOKEN_A_POLICY = "0000000000000000000000000000000000000000000000000000000000000000";
const TOKEN_A_NAME = fromText("TokenA");
const TOKEN_B_POLICY = "1111111111111111111110000000000000000000000000000000000000000000";
const TOKEN_B_NAME = fromText("TokenB");
const LP_POLICY = "2222222222222222222222222222222222222222222222222222222222222222";
const FEE_BPS = 30n; // 0.3% fee (30 basis points = 0.3%)

function selectWallet(lucid: LucidEvolution, filename: string) {
  const mnemonic = Deno.readTextFileSync(filename);
  lucid.selectWallet.fromSeed(mnemonic);
}

function getParametrizedValidator(): Script {
  const validatorEntry = blueprint.validators.find((v) => v.title === "amm.amm.spend");
  if (!validatorEntry) {
    throw new Error("Could not find amm.amm.spend validator in plutus.json.");
  }

  // Apply parameters to the validator
  // Parameters: token_a_policy, token_a_name, token_b_policy, token_b_name, lp_policy, fee_bps
  const compiledCode = applyParamsToScript(validatorEntry.compiledCode, [
    TOKEN_A_POLICY,
    TOKEN_A_NAME,
    TOKEN_B_POLICY,
    TOKEN_B_NAME,
    LP_POLICY,
    FEE_BPS,
  ]);

  return {
    type: "PlutusV3",
    script: compiledCode,
  };
}

async function setup() {
  const lucid = await Lucid(new Koios(KOIOS_URL), NETWORK);
  const validator = getParametrizedValidator();
  const scriptAddress = validatorToAddress(NETWORK, validator);

  return { lucid, validator, scriptAddress };
}

async function prepare() {
  const lucid = await Lucid(new Koios(KOIOS_URL), NETWORK);

  const userMnemonic = generateSeedPhrase();
  lucid.selectWallet.fromSeed(userMnemonic);
  const userAddress = await lucid.wallet().address();
  Deno.writeTextFileSync("wallet_user.txt", userMnemonic);

  console.log("Created user wallet.");
  console.log(`User address: ${userAddress}`);
  console.log("Fund the user address with tADA before running AMM operations.");
}

async function createPool(reserveA: string, reserveB: string) {
  const { lucid, validator, scriptAddress } = await setup();
  selectWallet(lucid, "wallet_user.txt");

  const reserveAInt = BigInt(reserveA);
  const reserveBInt = BigInt(reserveB);
  const lpSupply = reserveAInt; // Initial LP supply equals reserve_a

  // Create initial pool datum
  const datum = Data.to(
    {
      reserve_a: reserveAInt,
      reserve_b: reserveBInt,
      lp_supply: lpSupply,
    },
    PoolDatum,
  );

  // Create LP policy ID (in production, this would be a real minting policy)
  const lpPolicyId = validatorToScriptHash(validator);
  const lpUnit = toUnit(lpPolicyId, fromText("LP"));

  // Redeemer for AddLiquidity: Constr(1, [])
  const redeemer = Data.to(new Constr(1, []));

  const tx = await lucid
    .newTx()
    .attach.SpendingValidator(validator)
    .mintAssets(
      {
        [lpUnit]: lpSupply,
      },
      Data.void(), // Minting policy redeemer (would need actual minting policy)
    )
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      {
        lovelace: 2_000_000n, // Minimum ADA required
        // In production: add token_a and token_b here
      },
    );

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();

    console.log(`Pool created at ${scriptAddress}`);
    console.log(`Initial reserves: ${reserveA} TokenA, ${reserveB} TokenB`);
    console.log(`LP tokens minted: ${lpSupply}`);
    console.log(`Transaction: ${txHash}`);
    console.log(`See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error creating pool:", error);
    Deno.exit(1);
  }
}

async function swapTokens(
  txHash: string,
  outputIndex: number,
  inputAmount: string,
  minOutput: string,
) {
  const { lucid, validator, scriptAddress } = await setup();
  selectWallet(lucid, "wallet_user.txt");

  const utxos = await lucid.utxosByOutRef([{ txHash, outputIndex }]);
  if (utxos.length === 0) {
    throw new Error(`No UTxO found for transaction ${txHash}, output ${outputIndex}`);
  }

  const poolUtxo = utxos[0];
  if (!poolUtxo.datum) {
    throw new Error("Pool UTxO has no datum");
  }

  const poolState = Data.from(poolUtxo.datum, PoolDatum);
  const inputAmountInt = BigInt(inputAmount);
  const minOutputInt = BigInt(minOutput);

  // Calculate output using constant product formula
  // Output = (input * reserve_out) / (reserve_in + input)
  // With fee: input_after_fee = input * (10000 - 30) / 10000
  const inputAfterFee = (inputAmountInt * 9970n) / 10000n;
  const expectedOutput =
    (inputAfterFee * poolState.reserve_b) / (poolState.reserve_a + inputAfterFee);

  if (expectedOutput < minOutputInt) {
    throw new Error(
      `Expected output ${expectedOutput} is less than minimum ${minOutputInt}`,
    );
  }

  const newReserveA = poolState.reserve_a + inputAmountInt;
  const newReserveB = poolState.reserve_b - expectedOutput;

  // Update pool datum
  const newDatum = Data.to(
    {
      reserve_a: newReserveA,
      reserve_b: newReserveB,
      lp_supply: poolState.lp_supply,
    },
    PoolDatum,
  );

  // Redeemer for Swap: Constr(0, [min_output])
  const redeemer = Data.to(new Constr(0, [minOutputInt]));

  const userAddress = await lucid.wallet().address();

  const tx = await lucid
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([poolUtxo], redeemer)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: newDatum },
      poolUtxo.assets, // In production: update with new token amounts
    )
    .pay.ToAddress(userAddress, {
      lovelace: 0n,
      // In production: add expectedOutput of token_b here
    })
    .addSigner(userAddress);

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const submitHash = await (await signedTx.complete()).submit();

    console.log(`Swap executed: ${inputAmount} TokenA -> ~${expectedOutput} TokenB`);
    console.log(`New pool reserves: ${newReserveA} TokenA, ${newReserveB} TokenB`);
    console.log(`Transaction: ${submitHash}`);
    console.log(`See: https://preprod.cexplorer.io/tx/${submitHash}`);
  } catch (error) {
    console.error("Error executing swap:", error);
    Deno.exit(1);
  }
}

const command = Deno.args[0];

if (command === "prepare") {
  prepare().catch(console.error);
} else if (command === "create-pool") {
  if (Deno.args.length < 3) {
    console.error("Usage: deno run -A amm.ts create-pool <reserveA> <reserveB>");
    Deno.exit(1);
  }
  createPool(Deno.args[1], Deno.args[2]).catch(console.error);
} else if (command === "swap") {
  if (Deno.args.length < 4) {
    console.error(
      "Usage: deno run -A amm.ts swap <txHash> <outputIndex> <inputAmount> <minOutput>",
    );
    Deno.exit(1);
  }
  swapTokens(Deno.args[1], parseInt(Deno.args[2]), Deno.args[3], Deno.args[4]).catch(
    console.error,
  );
} else {
  console.error(`Unknown command: ${command || "(none)"}`);
  console.error("Available commands: prepare, create-pool, swap");
  Deno.exit(1);
}

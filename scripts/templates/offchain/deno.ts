// __EXAMPLE__ — off-chain flow (scaffolded skeleton).
//
// This file is intentionally STANDALONE and copy-paste friendly: the boilerplate
// frame (blueprint loading, yaci config) lives here, not in a shared library.
// Fill in the TODOs with your SDK's idiomatic transaction-building code, then
// remove the `throw` at the end. See docs/ADDING-A-LIBRARY.md for the contract.

// PLUTUS_JSON lets the cross-check runner point this same flow at any on-chain
// blueprint (aiken, scalus, …) without code edits. Falls back to the local
// Aiken blueprint for standalone runs.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Load the validator BY TITLE (not by array index) so a blueprint that lists
// its validators in a different order can never silently break the cross-check.
const VALIDATOR_TITLE = "__EXAMPLE__.__EXAMPLE__.spend"; // TODO: match your validator title
const validator =
  blueprint.validators.find((v: { title: string }) => v.title === VALIDATOR_TITLE) ??
  blueprint.validators[0];
if (!validator) throw new Error(`validator not found: ${VALIDATOR_TITLE}`);
const compiledCode: string = validator.compiledCode;

const YACI_URL = "http://localhost:8080/api/v1";
const MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

async function main(): Promise<void> {
  console.log("=== __EXAMPLE__ scenario (scaffold) ===");
  console.log(`Loaded validator '${validator.title}' (${compiledCode.length / 2} bytes)`);

  // TODO: construct an SDK provider/wallet from MNEMONIC against YACI_URL.
  // TODO: build → submit → confirm the use-case transaction(s).
  // TODO: throw on any failure so the cross-check marks this combo red.

  throw new Error("__EXAMPLE__ off-chain flow not implemented yet");
}

await main();

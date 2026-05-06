// Mesh.js conformance adapter — run-primitive entry point.
//
// Reads a scenario JSON, dispatches on scenario.primitive to the matching
// impl under ./src/primitive-impls/, compares observed to expected, writes
// a result.json per the runner contract, and exits non-zero on failure.
//
// Usage:
//   deno run --allow-read --allow-write run-primitive.ts <scenario.json>
//
// The script writes:
//   <id>.result.json  in the working directory (the cell runner moves it to
//                     .ci-results/ via run-cell.sh).

import { primitiveImpls } from "./src/primitive-impls/index.ts";

interface Scenario {
  id: string;
  primitive: string;
  era: string;
  description?: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const FRAMEWORK = "meshjs";

function fail(scenario: Scenario, errorSummary: string, observed?: unknown): never {
  writeResult(scenario, "fail", errorSummary, observed);
  Deno.exit(1);
}

function writeResult(
  scenario: Scenario,
  status: "pass" | "fail" | "skipped",
  errorSummary?: string,
  observed?: unknown,
) {
  const out: Record<string, unknown> = {
    tier: "primitive",
    id: scenario.id,
    primitive: scenario.primitive,
    framework: FRAMEWORK,
    era: scenario.era,
    status,
    duration_ms: Math.max(0, Date.now() - START),
  };
  if (errorSummary) out.error_summary = errorSummary;
  if (observed !== undefined) out.observed = observed;
  if (scenario.expected !== undefined) out.expected = scenario.expected;
  Deno.writeTextFileSync("result.json", JSON.stringify(out, null, 2));
}

const START = Date.now();

if (Deno.args.length < 1) {
  console.error("usage: run-primitive.ts <scenario.json>");
  Deno.exit(64);
}

const scenarioPath = Deno.args[0];
const scenarioText = Deno.readTextFileSync(scenarioPath);
const scenario: Scenario = JSON.parse(scenarioText);

const impl = primitiveImpls[scenario.primitive];
if (!impl) {
  // No impl registered for this primitive: report as skipped, exit 0.
  writeResult(scenario, "skipped", `primitive '${scenario.primitive}' not implemented in ${FRAMEWORK}`);
  Deno.exit(0);
}

let observed: unknown;
try {
  observed = await impl(scenario.input);
} catch (err) {
  fail(scenario, `impl threw: ${(err as Error).message}`);
}

// Deep equality check on observed vs expected. The impl may return a subset
// of expected fields if some are derived (e.g. blake2b_256 derived from cbor);
// missing fields fail.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  const ak = Object.keys(a as object).sort();
  const bk = Object.keys(b as object).sort();
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!bk.includes(k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

if (deepEqual(observed, scenario.expected)) {
  writeResult(scenario, "pass", undefined, observed);
  Deno.exit(0);
} else {
  fail(scenario, "observed != expected", observed);
}

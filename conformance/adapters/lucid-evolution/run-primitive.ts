// Lucid Evolution conformance adapter — run-primitive entry point.
// Mirrors the Mesh.js adapter's contract; see ../meshjs/run-primitive.ts for
// the full description.

import { primitiveImpls } from "./src/primitive-impls/index.ts";

interface Scenario {
  id: string;
  primitive: string;
  era: string;
  description?: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const FRAMEWORK = "lucid-evolution";
const START = Date.now();

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

if (Deno.args.length < 1) {
  console.error("usage: run-primitive.ts <scenario.json>");
  Deno.exit(64);
}

const scenarioPath = Deno.args[0];
const scenario: Scenario = JSON.parse(Deno.readTextFileSync(scenarioPath));

const impl = primitiveImpls[scenario.primitive];
if (!impl) {
  writeResult(scenario, "skipped", `primitive '${scenario.primitive}' not implemented in ${FRAMEWORK}`);
  Deno.exit(0);
}

let observed: unknown;
try {
  observed = await impl(scenario.input);
} catch (err) {
  writeResult(scenario, "fail", `impl threw: ${(err as Error).message}`);
  Deno.exit(1);
}

if (deepEqual(observed, scenario.expected)) {
  writeResult(scenario, "pass", undefined, observed);
  Deno.exit(0);
} else {
  writeResult(scenario, "fail", "observed != expected", observed);
  Deno.exit(1);
}

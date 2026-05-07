// Mesh.js impl of encoding/datum-cbor-roundtrip.
//
// Takes a plutus_data JSON value (Cardano's standard JSON representation:
// {int: N} | {bytes: "hex"} | {list: [...]} | {map: [{k,v},...]} | {constructor: N, fields: [...]})
// Returns the CBOR hex Mesh produces for that value, plus blake2b_256(cbor).
//
// Uses Mesh's @meshsdk/core-csl which exposes the lower-level CSL bindings
// for plutus-data → CBOR. The high-level @meshsdk/core has tx-building
// helpers that emit plutus-data CBOR internally; we call into the lower-level
// path directly so the result is exactly what Mesh would write to chain.

import { csl } from "@meshsdk/core-csl";

interface PlutusDataJson {
  int?: number | string;
  bytes?: string;
  list?: PlutusDataJson[];
  map?: Array<{ k: PlutusDataJson; v: PlutusDataJson }>;
  constructor?: number;
  fields?: PlutusDataJson[];
}

function toPlutusData(j: PlutusDataJson): unknown {
  if (j.int !== undefined) {
    return csl.PlutusData.new_integer(csl.BigInt.from_str(String(j.int)));
  }
  if (j.bytes !== undefined) {
    return csl.PlutusData.new_bytes(Uint8Array.from(Buffer.from(j.bytes, "hex")));
  }
  if (j.list !== undefined) {
    const list = csl.PlutusList.new();
    for (const item of j.list) list.add(toPlutusData(item));
    return csl.PlutusData.new_list(list);
  }
  if (j.map !== undefined) {
    const map = csl.PlutusMap.new();
    for (const { k, v } of j.map) {
      map.insert(toPlutusData(k), toPlutusData(v));
    }
    return csl.PlutusData.new_map(map);
  }
  if (j.constructor !== undefined && j.fields !== undefined) {
    const fields = csl.PlutusList.new();
    for (const field of j.fields) fields.add(toPlutusData(field));
    const constr = csl.ConstrPlutusData.new(
      csl.BigNum.from_str(String(j.constructor)),
      fields,
    );
    return csl.PlutusData.new_constr_plutus_data(constr);
  }
  throw new Error(`unrecognized plutus_data shape: ${JSON.stringify(j)}`);
}

async function blake2b256(bytesHex: string): Promise<string> {
  // Use Web Crypto if available; else fall back to a minimal blake2b impl.
  // Mesh ships its own utility; this is the most portable path.
  const bytes = Uint8Array.from(Buffer.from(bytesHex, "hex"));
  // Deno's Web Crypto doesn't include blake2b; use a small JS impl.
  const blake2b = await import("https://deno.land/x/blake2b@0.9.2/mod.ts").catch(() => null);
  if (blake2b && blake2b.blake2b) {
    const out = blake2b.blake2b(bytes, undefined, 32);
    return Array.from(out).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback: try noble-hashes via npm.
  const { blake2b: nobleBlake2b } = await import("npm:@noble/hashes/blake2b");
  const digest = nobleBlake2b(bytes, { dkLen: 32 });
  return Array.from(digest).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function datumCborRoundtrip(
  input: Record<string, unknown>,
): Promise<{ cbor_hex: string; blake2b_256: string }> {
  const j = input.plutus_data as PlutusDataJson;
  if (!j) throw new Error("scenario input missing 'plutus_data'");

  const data = toPlutusData(j);
  // @ts-expect-error CSL types are dynamic; .to_hex() returns the canonical CBOR hex.
  const cborHex = (data as { to_hex: () => string }).to_hex();
  const hash = await blake2b256(cborHex);
  return { cbor_hex: cborHex, blake2b_256: hash };
}

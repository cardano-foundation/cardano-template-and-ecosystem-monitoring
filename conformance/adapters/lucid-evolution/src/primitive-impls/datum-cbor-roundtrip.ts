// Lucid Evolution impl of encoding/datum-cbor-roundtrip.
//
// Lucid's `Data.to(value)` accepts a Lucid-native plutus_data shape and
// returns the canonical CBOR hex. We convert from Cardano's standard JSON
// representation to Lucid's runtime shape, then call Data.to.

import { Constr, Data } from "@evolution-sdk/lucid";
import { blake2b } from "npm:@noble/hashes/blake2b";

interface PlutusDataJson {
  int?: number | string;
  bytes?: string;
  list?: PlutusDataJson[];
  map?: Array<{ k: PlutusDataJson; v: PlutusDataJson }>;
  constructor?: number;
  fields?: PlutusDataJson[];
}

function toLucidData(j: PlutusDataJson): unknown {
  if (j.int !== undefined) return BigInt(j.int);
  if (j.bytes !== undefined) return j.bytes; // Lucid treats hex strings as bytestrings in plutus-data context
  if (j.list !== undefined) return j.list.map(toLucidData);
  if (j.map !== undefined) {
    const m = new Map<unknown, unknown>();
    for (const { k, v } of j.map) m.set(toLucidData(k), toLucidData(v));
    return m;
  }
  if (j.constructor !== undefined && j.fields !== undefined) {
    return new Constr(j.constructor, j.fields.map(toLucidData));
  }
  throw new Error(`unrecognized plutus_data shape: ${JSON.stringify(j)}`);
}

export function datumCborRoundtrip(
  input: Record<string, unknown>,
): { cbor_hex: string; blake2b_256: string } {
  const j = input.plutus_data as PlutusDataJson;
  if (!j) throw new Error("scenario input missing 'plutus_data'");

  const data = toLucidData(j);
  const cborHex = Data.to(data as never);
  const cborBytes = Uint8Array.from((cborHex.match(/.{2}/g) || []).map(b => parseInt(b, 16)));
  const digest = blake2b(cborBytes, { dkLen: 32 });
  const hash = Array.from(digest).map(b => b.toString(16).padStart(2, "0")).join("");
  return { cbor_hex: cborHex, blake2b_256: hash };
}

// Mesh.js impl of encoding/plutus-data-canonical-order.
//
// Same logical operation as datum-cbor-roundtrip but the scenarios test
// specifically that map keys are emitted in canonical lexicographic order,
// regardless of input order. The impl is identical: convert plutus_data to
// CBOR via Mesh and report the result. The scenario JSONs assert against
// the canonical (sorted) form; if Mesh does not canonicalise, the scenario
// fails — which is exactly what we want.

export { datumCborRoundtrip as plutusDataCanonicalOrder } from "./datum-cbor-roundtrip.ts";

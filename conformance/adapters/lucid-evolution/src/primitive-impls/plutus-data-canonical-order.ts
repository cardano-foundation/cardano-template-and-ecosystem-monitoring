// Same operation as datum-cbor-roundtrip; the scenarios test specifically
// that map keys are emitted in canonical order regardless of input order.
export { datumCborRoundtrip as plutusDataCanonicalOrder } from "./datum-cbor-roundtrip.ts";

// Registry of primitive implementations for the Mesh.js adapter.
// Adding a new primitive impl: write the function in its own file under this
// directory and add it to the map below. The run-primitive entry point
// dispatches on scenario.primitive (the registered key here).

import { datumCborRoundtrip } from "./datum-cbor-roundtrip.ts";
import { plutusDataCanonicalOrder } from "./plutus-data-canonical-order.ts";
import { addressBech32Roundtrip } from "./address-bech32-roundtrip.ts";

export type PrimitiveImpl = (input: Record<string, unknown>) => Promise<unknown> | unknown;

export const primitiveImpls: Record<string, PrimitiveImpl> = {
  "encoding/datum-cbor-roundtrip": datumCborRoundtrip,
  "encoding/plutus-data-canonical-order": plutusDataCanonicalOrder,
  "encoding/address-bech32-roundtrip": addressBech32Roundtrip,
};

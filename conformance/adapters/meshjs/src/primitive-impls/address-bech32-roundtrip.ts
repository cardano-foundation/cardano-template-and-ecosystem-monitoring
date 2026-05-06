// Mesh.js impl of encoding/address-bech32-roundtrip.
//
// Takes raw address bytes (as hex) plus a network tag, returns the canonical
// bech32 string Mesh produces.

import { csl } from "@meshsdk/core-csl";

export function addressBech32Roundtrip(
  input: Record<string, unknown>,
): { bech32: string } {
  const addressBytesHex = input.address_bytes_hex as string;
  if (!addressBytesHex) throw new Error("scenario input missing 'address_bytes_hex'");
  const bytes = Uint8Array.from(Buffer.from(addressBytesHex, "hex"));

  // CSL's Address.from_bytes accepts the raw header+body bytes; to_bech32
  // produces the canonical bech32 string with the correct HRP for the
  // address's header byte.
  // @ts-expect-error CSL types are dynamic; from_bytes / to_bech32 are documented helpers.
  const address = csl.Address.from_bytes(bytes);
  // @ts-expect-error
  const bech32: string = address.to_bech32();
  return { bech32 };
}

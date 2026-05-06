// Lucid Evolution impl of encoding/address-bech32-roundtrip.
//
// Lucid exposes raw-byte → bech32 conversion via the underlying CSL/CML
// bindings. We use C.Address.from_bytes(...).to_bech32(...) where C is
// Lucid's bundled CML re-export.

// @ts-expect-error: Lucid Evolution re-exports the CML core; the exact path
// is internal but stable.
import { C } from "@evolution-sdk/lucid";

export function addressBech32Roundtrip(
  input: Record<string, unknown>,
): { bech32: string } {
  const addressBytesHex = input.address_bytes_hex as string;
  if (!addressBytesHex) throw new Error("scenario input missing 'address_bytes_hex'");
  const bytes = Uint8Array.from((addressBytesHex.match(/.{2}/g) || []).map(b => parseInt(b, 16)));
  const address = C.Address.from_bytes(bytes);
  const bech32 = address.to_bech32(undefined);
  return { bech32 };
}

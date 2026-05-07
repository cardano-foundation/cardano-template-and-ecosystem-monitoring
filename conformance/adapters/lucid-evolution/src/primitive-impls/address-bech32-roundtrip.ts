// Lucid Evolution impl of encoding/address-bech32-roundtrip.
//
// Lucid exposes raw-byte → bech32 conversion via the underlying CSL/CML
// bindings. We use C.Address.from_bytes(...).to_bech32(...) where C is
// Lucid's bundled CML re-export.
//
// KNOWN BRITTLENESS: `C` is documented as an internal re-export and Lucid
// Evolution's release notes warn that the symbol may move under a public
// `@evolution-sdk/cml` (or similar) namespace in a future minor. If first
// CI runs report this import as missing or moved, the fix is to replace
// the import with whatever path the version pinned in versions.yml exposes.
// Tracked for hardening when P2W2 lands the wider primitives suite.

// @ts-expect-error: Lucid Evolution re-exports the CML core; the exact path
// is internal but stable for the pinned version (versions.yml `lucid_evolution`).
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

"""__EXAMPLE__ — off-chain flow (scaffolded skeleton).

This file is intentionally STANDALONE and copy-paste friendly: the boilerplate
frame (blueprint loading, yaci config) lives here, not in a shared library. Fill
in the TODOs with your SDK's idiomatic transaction-building code, then remove the
final raise. See docs/ADDING-A-LIBRARY.md for the contract.
"""

import json
import os
from pathlib import Path

# PLUTUS_JSON lets the cross-check runner point this same flow at any on-chain
# blueprint (aiken, scalus, …) without code edits. Falls back to the local Aiken
# blueprint for standalone runs.
BLUEPRINT_PATH = Path(
    os.environ.get(
        "PLUTUS_JSON",
        Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json",
    )
)
blueprint = json.loads(BLUEPRINT_PATH.read_text())

# Load the validator BY TITLE (not by array index) so a blueprint that lists its
# validators in a different order can never silently break the cross-check.
VALIDATOR_TITLE = "__EXAMPLE__.__EXAMPLE__.spend"  # TODO: match your validator title
validator = next(
    (v for v in blueprint["validators"] if v["title"] == VALIDATOR_TITLE),
    blueprint["validators"][0],
)
compiled_code = bytes.fromhex(validator["compiledCode"])

YACI_URL = "http://localhost:8080/api"
MNEMONIC = (
    "test test test test test test test test test test test test "
    "test test test test test test test test test test test sauce"
)


def main() -> None:
    print("=== __EXAMPLE__ scenario (scaffold) ===")
    print(f"Loaded validator '{validator['title']}' ({len(compiled_code)} bytes)")

    # TODO: construct an SDK chain context / wallet from MNEMONIC against YACI_URL.
    # TODO: build -> submit -> confirm the use-case transaction(s).
    # TODO: raise on any failure so the cross-check marks this combo red.

    raise SystemExit("__EXAMPLE__ off-chain flow not implemented yet")


if __name__ == "__main__":
    main()

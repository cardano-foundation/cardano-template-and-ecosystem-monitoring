#!/usr/bin/env bash
# Thin wrapper around the TypeScript run-primitive entry point so the shell
# command in the per-primitive READMEs is uniform across SDKs.
#
# Usage: conformance/adapters/lucid-evolution/run-primitive.sh <scenario.json>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec deno run --allow-read --allow-write --allow-net --allow-env "$HERE/run-primitive.ts" "$@"

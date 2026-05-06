#!/usr/bin/env bash
# Thin wrapper around the JBang RunPrimitive.java entry point so the shell
# command in the per-primitive READMEs is uniform across SDKs.
#
# Usage: conformance/adapters/ccl-java/run-primitive.sh <scenario.json>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec jbang "$HERE/RunPrimitive.java" "$@"

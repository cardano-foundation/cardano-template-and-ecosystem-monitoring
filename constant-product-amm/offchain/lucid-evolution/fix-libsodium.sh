#!/bin/bash

# This script is a workaround for a Deno npm compatibility issue with libsodium-wrappers-sumo.
# The 'libsodium-sumo.mjs' file, which is imported by 'libsodium-wrappers.mjs', is not
# correctly generated or placed by Deno's npm resolution, even with --allow-scripts.
# This script manually copies the missing file from its expected location in the
# 'libsodium-sumo' package to where 'libsodium-wrappers-sumo' expects it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MODULES_DIR="$SCRIPT_DIR/node_modules/.deno"

LIBSODIUM_WRAPPERS_SUMO_DIR="$NODE_MODULES_DIR/libsodium-wrappers-sumo@0.7.16/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm"
LIBSODIUM_SUMO_SOURCE_DIR="$NODE_MODULES_DIR/libsodium-wrappers-sumo@0.7.16/node_modules/libsodium-sumo/dist/modules-sumo-esm"
MISSING_FILE="libsodium-sumo.mjs"

echo "Applying libsodium-wrappers-sumo workaround..."

if [ -f "${LIBSODIUM_SUMO_SOURCE_DIR}/${MISSING_FILE}" ]; then
  if [ ! -d "$LIBSODIUM_WRAPPERS_SUMO_DIR" ]; then
    echo "Creating directory: $LIBSODIUM_WRAPPERS_SUMO_DIR"
    mkdir -p "$LIBSODIUM_WRAPPERS_SUMO_DIR"
  fi
  echo "Copying ${MISSING_FILE} to ${LIBSODIUM_WRAPPERS_SUMO_DIR}"
  cp "${LIBSODIUM_SUMO_SOURCE_DIR}/${MISSING_FILE}" "${LIBSODIUM_WRAPPERS_SUMO_DIR}/"
  echo "Workaround applied successfully."
else
  echo "Error: Source file ${LIBSODIUM_SUMO_SOURCE_DIR}/${MISSING_FILE} not found."
  echo "Please ensure Deno has installed npm packages first (run 'deno cache amm.ts' or 'deno run -A amm.ts prepare')."
  exit 1
fi

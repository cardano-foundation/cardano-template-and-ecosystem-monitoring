#!/bin/bash
# Workaround script for libsodium-wrappers-sumo missing libsodium-sumo.mjs file
# This copies the file from the libsodium-sumo package to where libsodium-wrappers-sumo expects it

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MODULES_DIR="$SCRIPT_DIR/node_modules/.deno"

if [ -d "$NODE_MODULES_DIR/libsodium-wrappers-sumo@0.7.16/node_modules/libsodium-sumo/dist/modules-sumo-esm" ] && \
   [ -f "$NODE_MODULES_DIR/libsodium-wrappers-sumo@0.7.16/node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs" ]; then
  TARGET_DIR="$NODE_MODULES_DIR/libsodium-wrappers-sumo@0.7.16/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm"
  SOURCE_FILE="$NODE_MODULES_DIR/libsodium-wrappers-sumo@0.7.16/node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs"
  TARGET_FILE="$TARGET_DIR/libsodium-sumo.mjs"
  
  if [ ! -f "$TARGET_FILE" ]; then
    echo "Copying libsodium-sumo.mjs to fix missing dependency..."
    cp "$SOURCE_FILE" "$TARGET_FILE"
    echo "Fixed: $TARGET_FILE"
  fi
fi

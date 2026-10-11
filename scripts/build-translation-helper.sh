#!/usr/bin/env bash
# Builds the macOS translation helper (native/translation-helper) into
# src/assets/images/icons/, where esbuild copies it into the app and
# assemble-trangpt-signal-layout.mjs places it in app.asar.unpacked.
set -euo pipefail

cd "$(dirname "$0")/.."

source_dir="native/translation-helper"
output="src/assets/images/icons/mactranslate-translation-helper"

xcrun swiftc -O -swift-version 5 -target arm64-apple-macos15.0 \
  "$source_dir/main.swift" -o "$output" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker "$source_dir/Info.plist"

codesign --force --sign - --options runtime \
  --identifier com.mactranslate.translation-helper "$output"

printf 'Translation helper built: %s\n' "$output"

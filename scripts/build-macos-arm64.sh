#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "This build must run on macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "This build is for Apple Silicon (arm64)."
for command in node npm pnpm lipo ditto tar; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required."
done

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 22 || minor < 18) {
  console.error(`Error: Node.js >=22.18.0 <23 is required; current: ${process.versions.node}.`);
  process.exit(1);
}
'

pnpm_major="$(pnpm --version | cut -d. -f1)"
[[ "$pnpm_major" == "10" ]] || fail "pnpm 10.x is required; current: $(pnpm --version)."

export CI=true
export CSC_IDENTITY_AUTO_DISCOVERY=false
export GIT_BRANCH_NAME=local
export npm_config_registry=https://registry.npmjs.org/

ensure_arm64_7za() {
  local package_root="$PWD/node_modules/.pnpm/7zip-bin@5.2.0/node_modules/7zip-bin"
  local sevenzip="$package_root/mac/arm64/7za"

  if [[ ! -s "$sevenzip" ]]; then
    printf '\nRepairing missing 7zip-bin ARM64 helper...\n'
    rm -rf "$PWD/node_modules/.pnpm/7zip-bin@5.2.0" "$PWD/node_modules/7zip-bin"
    pnpm install --no-frozen-lockfile --force
  fi

  if [[ ! -s "$sevenzip" ]]; then
    local repair_root
    repair_root="$(mktemp -d /tmp/mactranslate-7zip-repair.XXXXXX)"
    local package_file
    (
      cd "$repair_root"
      npm pack 7zip-bin@5.2.0 --silent >/dev/null
    )
    package_file="$(find "$repair_root" -maxdepth 1 -type f -name '7zip-bin-*.tgz' -print -quit)"
    [[ -s "$package_file" ]] || fail "Could not download the 7zip-bin repair package."
    tar -xzf "$package_file" -C "$repair_root"
    [[ -s "$repair_root/package/mac/arm64/7za" ]] || fail "The downloaded 7zip-bin package has no ARM64 7za."
    mkdir -p "$(dirname "$sevenzip")"
    cp "$repair_root/package/mac/arm64/7za" "$sevenzip"
    rm -rf "$repair_root"
  fi

  chmod 755 "$sevenzip"
  local arches
  arches="$(lipo -archs "$sevenzip" 2>/dev/null || true)"
  [[ " $arches " == *" arm64 "* ]] || fail "7za is not ARM64: $sevenzip ($arches)"
  printf '7zip-bin ARM64 helper verified: %s\n' "$sevenzip"
}

printf '\n[1/10] Verifying source and vendored Signal runtime...\n'
node scripts/verify-embedded-signal-source.mjs
node scripts/verify-signal-runtime-closure.mjs --runtime vendor/signal-runtime
node scripts/verify-signal-host-filesystem.mjs

printf '\n[2/10] Installing application dependencies...\n'
pnpm install --no-frozen-lockfile
ensure_arm64_7za

printf '\n[3/10] Building service recipes...\n'
(
  cd recipes
  pnpm install --frozen-lockfile
  pnpm package
)

[[ -s recipes/all.json ]] || fail "recipes/all.json was not generated."
for recipe in whatsapp telegram wire signal; do
  [[ -s "recipes/archives/$recipe.tar.gz" ]] || fail "$recipe recipe archive was not generated."
done

hidden_recipes=(discord gitter google-calendar mattermost proton-mail skype slack trello tweetdeck)
for recipe_id in "${hidden_recipes[@]}"; do
  [[ ! -e "recipes/recipes/$recipe_id" ]] || fail "Hidden recipe source still exists: $recipe_id"
  [[ ! -e "recipes/archives/$recipe_id.tar.gz" ]] || fail "Hidden recipe archive was generated: $recipe_id"
done

printf '\n[4/10] Checking TypeScript...\n'
pnpm typecheck

printf '\n[5/10] Building application files...\n'
node esbuild.mjs
for file in \
  build/electron/signal/EmbeddedSignalEngine.js \
  build/electron/signal/SignalRuntimeHost.js \
  build/electron/signal/runEmbeddedSignalSmokeTest.js \
  build/recipes/all.json \
  build/recipes/signal.tar.gz; do
  [[ -s "$file" ]] || fail "Build output is missing: $file"
done

printf '\n[6/10] Creating unpacked macOS application...\n'
rm -rf out
pnpm exec electron-builder --mac --arm64 --dir \
  --config electron-builder.mac-arm64.yml --publish never

app_path="$(find out -type d -path '*/MacTranslate.app' -print -quit)"
[[ -n "$app_path" ]] || fail "MacTranslate.app was not created."
resources="$app_path/Contents/Resources"
[[ -s "$resources/app.asar" ]] || fail "The unpacked application is missing app.asar."

printf '\n[7/10] Rebuilding app.asar with TranGPT-compatible Signal layout...\n'
node scripts/assemble-trangpt-signal-layout.mjs --app "$app_path"

printf '\n[8/10] Verifying final app.asar / app.asar.unpacked layout...\n'
app_asar="$resources/app.asar"
unpacked="$resources/app.asar.unpacked"
[[ -s "$app_asar" ]] || fail "The assembled application is missing app.asar."
[[ -s "$resources/SIGNAL_AGPL_NOTICE.md" ]] || fail "The Signal license notice is missing."

asar_list="$PWD/out/app-asar-list.txt"
pnpm exec asar list "$app_asar" > "$asar_list"

asar_entries=(
  '/signal-runtime/mactranslate-runtime.json'
  '/signal-runtime/mactranslate-closure.json'
  '/signal-runtime/mactranslate-main-globals.cjs'
  '/signal-runtime/mactranslate-main-directories.cjs'
  '/signal-runtime/mactranslate-main-bootstrap.cjs'
  '/signal-runtime/package.json'
  '/signal-runtime/bundles/main.js'
  '/signal-runtime/bundles/preload/wrapper.js'
  '/signal-runtime/preload/servicePreloadSignal.js'
  '/signal-runtime/preload/js/index.js'
  '/signal-runtime/preload/js/index2.js'
  '/signal-runtime/preload/js/base64.js'
  '/signal-runtime/preload/node_modules/@electron-toolkit/preload/package.json'
  '/signal-runtime/preload/node_modules/react/package.json'
  '/signal-runtime/preload/node_modules/react-dom/package.json'
  '/signal-runtime/preload/node_modules/scheduler/package.json'
  '/signal-runtime/mactranslate-trangpt-preload.json'
  '/signal-runtime/background.html'
  '/signal-runtime/mactranslate-trangpt-assets.json'
  '/signal-runtime/build/available-locales.json'
  '/signal-runtime/build/country-display-names.json'
  '/signal-runtime/build/dns-fallback.json'
  '/signal-runtime/build/emoji-data.json'
  '/signal-runtime/build/jumbomoji.json'
  '/signal-runtime/build/locale-display-names.json'
  '/signal-runtime/build/optional-resources.json'
  '/signal-runtime/build/icons/png/512x512.png'
  '/signal-runtime/build/icons/win/icon.ico'
  '/node_modules/node-gyp-build/package.json'
  '/node_modules/urlpattern-polyfill/package.json'
  '/node_modules/bindings/package.json'
  '/node_modules/file-uri-to-path/package.json'
  '/node_modules/google-libphonenumber/package.json'
  '/node_modules/@indutny/mac-screen-share/package.json'
  '/node_modules/fs-xattr/package.json'
  '/signal-runtime/node_modules/@signalapp/libsignal-client/package.json'
  '/signal-runtime/node_modules/@signalapp/sqlcipher/package.json'
  '/signal-runtime/node_modules/@signalapp/ringrtc/package.json'
)
for entry in "${asar_entries[@]}"; do
  grep -Fxq "$entry" "$asar_list" || fail "app.asar is missing: $entry"
done

[[ -s "$unpacked/signal-runtime/preload/servicePreloadSignal.js" ]] || fail "TranGPT servicePreloadSignal is not unpacked."
[[ -s "$unpacked/signal-runtime/preload/node_modules/@electron-toolkit/preload/package.json" ]] || fail "TranGPT preload dependency island is not unpacked."

packaged_native_files=(
  'signal-runtime/node_modules/@signalapp/sqlcipher/prebuilds/darwin-arm64/@signalapp+sqlcipher.node'
  'signal-runtime/node_modules/@signalapp/libsignal-client/prebuilds/darwin-arm64/@signalapp+libsignal-client.node'
  'signal-runtime/node_modules/@signalapp/ringrtc/build/darwin/libringrtc-arm64.node'
  'signal-runtime/node_modules/@signalapp/mute-state-change/build/Release/mute-state-change.node'
  'node_modules/@indutny/mac-screen-share/prebuilds/darwin-arm64/@indutny+mac-screen-share.node'
  'node_modules/fs-xattr/build/Release/xattr.node'
)
for relative in "${packaged_native_files[@]}"; do
  native="$unpacked/$relative"
  [[ -s "$native" ]] || fail "Packaged native module is missing: $relative"
  arches="$(lipo -archs "$native" 2>/dev/null || true)"
  [[ " $arches " == *" arm64 "* ]] || fail "Packaged native module is not arm64: $relative ($arches)"
done

[[ -s "$unpacked/recipes/all.json" ]] || fail "app.asar.unpacked/recipes/all.json is missing."
[[ -s "$unpacked/recipes/signal.tar.gz" ]] || fail "app.asar.unpacked/recipes/signal.tar.gz is missing."
cmp -s build/recipes/all.json "$unpacked/recipes/all.json" || fail "Packaged recipes/all.json differs from the build output."
cmp -s build/recipes/signal.tar.gz "$unpacked/recipes/signal.tar.gz" || fail "Packaged signal.tar.gz differs from the build output."

printf '\n[9/10] Testing homepage service webview first, then embedded Signal...\n'
smoke_root="$(mktemp -d /tmp/mactranslate-v12.4.3-smoke.XXXXXX)"
smoke_log="$PWD/out/signal-smoke-test.log"
smoke_pid=''
cleanup_smoke() {
  if [[ -n "$smoke_pid" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
    kill "$smoke_pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_root"
}
trap cleanup_smoke EXIT

FERDIUM_APPDATA_DIR="$smoke_root" \
  "$app_path/Contents/MacOS/MacTranslate" --signal-smoke-test \
  >"$smoke_log" 2>&1 &
smoke_pid=$!

smoke_finished=false
for _ in $(seq 1 240); do
  if ! kill -0 "$smoke_pid" 2>/dev/null; then
    smoke_finished=true
    break
  fi
  sleep 1
done

if [[ "$smoke_finished" != true ]]; then
  tail -200 "$smoke_log" >&2 || true
  fail "Signal smoke test timed out. See: $smoke_log"
fi

set +e
wait "$smoke_pid"
smoke_status=$?
set -e
smoke_pid=''

if grep -Eq 'ReferenceError: (Buffer|process) is not defined' "$smoke_log"; then
  tail -200 "$smoke_log" >&2 || true
  fail "Signal preload lost Buffer/process. See: $smoke_log"
fi

if [[ "$smoke_status" -ne 0 ]] || ! grep -q 'HOMEPAGE_WEBVIEW_SMOKE_OK' "$smoke_log" || ! grep -q 'SIGNAL_SMOKE_OK' "$smoke_log"; then
  tail -200 "$smoke_log" >&2 || true
  fail "Homepage service webview or Signal smoke test failed. See: $smoke_log"
fi

trap - EXIT
cleanup_smoke

printf '\n[10/10] Creating DMG and ZIP from the verified application...\n'
ensure_arm64_7za
prepackaged_root="$(mktemp -d /tmp/mactranslate-v12.4.3-prepackaged.XXXXXX)"
cleanup_prepackaged() {
  rm -rf "$prepackaged_root"
}
trap cleanup_prepackaged EXIT

ditto "$app_path" "$prepackaged_root/MacTranslate.app"
rm -f out/MacTranslate-v12.4.3-*.dmg out/MacTranslate-v12.4.3-*.zip \
  out/MacTranslate-v12.4.3-*.blockmap
pnpm exec electron-builder \
  --prepackaged "$prepackaged_root/MacTranslate.app" \
  --mac dmg zip --arm64 \
  --config electron-builder.mac-arm64.yml --publish never

trap - EXIT
cleanup_prepackaged

dmg_path="$(find out -maxdepth 1 -type f -name 'MacTranslate-v12.4.3-*.dmg' -print -quit)"
zip_path="$(find out -maxdepth 1 -type f -name 'MacTranslate-v12.4.3-*.zip' -print -quit)"
[[ -s "$dmg_path" ]] || fail "Verified DMG was not generated."
[[ -s "$zip_path" ]] || fail "Verified ZIP was not generated."

printf '\nHomepage service webview and Signal runtime smoke tests passed.\n'
printf 'DMG: %s\n' "$dmg_path"
printf 'ZIP: %s\n' "$zip_path"
printf 'Smoke log: %s\n' "$smoke_log"

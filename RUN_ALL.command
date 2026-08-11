#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo '[0/6] 停止旧程序并清理残留错误拾取脚本...'
pkill -x MacTranslate 2>/dev/null || true
"$ROOT/CLEAN_STALE_CAPTURE.command"

echo '[1/6] 核对 RP01 底座 + GitHub 根因稳定修复...'
node scripts/verify-rp01-frozen.mjs "$ROOT"
node scripts/verify-v6-frozen-manifest.mjs "$ROOT"

echo '[2/6] 核对 MacTr 程序坞图标...'
node scripts/verify-mactr-icon-v6.mjs "$ROOT"

echo '[3/6] 核对消息拾取、已知 Console 错误和 WhatsApp 历史快照...'
node scripts/verify-message-recognition-v72.mjs "$ROOT"
node scripts/verify-v722-console-history.mjs "$ROOT"
node scripts/verify-stable-rootcause-fix.mjs "$ROOT"
"$ROOT/CHECK_KNOWN_ERRORS.command"
node scripts/test-whatsapp-v72-harness.mjs "$ROOT"
node scripts/test-whatsapp-history-v722-harness.mjs "$ROOT"

echo '[4/6] 构建 DMG/ZIP（构建脚本会执行 TypeScript 检查）...'
chmod +x scripts/build-macos-arm64.sh
./scripts/build-macos-arm64.sh

echo '[5/6] 安装并启动...'
app_path="$(find out -type d -path '*/MacTranslate.app' -print -quit)"
[[ -n "$app_path" ]] || { echo '未找到构建后的 MacTranslate.app' >&2; exit 1; }
sudo rm -rf /Applications/MacTranslate.app
sudo ditto "$app_path" /Applications/MacTranslate.app
xattr -dr com.apple.quarantine /Applications/MacTranslate.app 2>/dev/null || true
"$ROOT/CLEAN_STALE_CAPTURE.command"
open -a /Applications/MacTranslate.app

echo
echo 'RP01_STABLE_ROOTCAUSE_FIX_INSTALLED'
echo 'WhatsApp 实时：./TEST_WHATSAPP_CAPTURE.command'
echo 'WhatsApp 已加载历史：./TEST_WHATSAPP_HISTORY.command'

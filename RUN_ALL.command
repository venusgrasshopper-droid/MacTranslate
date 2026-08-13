#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo '[0/6] 停止旧程序并清理残留错误拾取脚本...'
pkill -x MacTranslate 2>/dev/null || true
"$ROOT/CLEAN_STALE_CAPTURE.command"

echo '[1/6] 核对 RP01/Signal 冻结底座...'
node scripts/verify-rp01-frozen.mjs "$ROOT"
node scripts/verify-v6-frozen-manifest.mjs "$ROOT"
node scripts/verify-embedded-signal-source.mjs "$ROOT"
node scripts/verify-signal-runtime-closure.mjs "$ROOT"
node scripts/verify-signal-host-filesystem.mjs "$ROOT"
node scripts/verify-trangpt-official-signal-host.mjs "$ROOT"

echo '[2/6] 核对 MacTr 程序坞图标...'
node scripts/verify-mactr-icon-v6.mjs "$ROOT"

echo '[3/6] 核对 GitHub 根因修复 + 消息拾取...'
node scripts/verify-message-recognition-v72.mjs "$ROOT"
node scripts/verify-message-menu.mjs "$ROOT"
node scripts/verify-v722-console-history.mjs "$ROOT"
node scripts/verify-stable-rootcause-fix.mjs "$ROOT"
"$ROOT/CHECK_KNOWN_ERRORS.command"
node scripts/test-whatsapp-logger-readiness.mjs "$ROOT"
node scripts/test-whatsapp-v72-harness.mjs "$ROOT"
node scripts/test-whatsapp-history-v722-harness.mjs "$ROOT"
node scripts/test-whatsapp-provider-history-r6.mjs "$ROOT"
node scripts/test-whatsapp-resident-history-r7.mjs "$ROOT"
node scripts/test-whatsapp-history-lid-r8.mjs "$ROOT"
node scripts/verify-telegram-r14-adaptive-transport.mjs "$ROOT"
node scripts/verify-telegram-r13-live-state.mjs "$ROOT"
node scripts/test-telegram-r14-broadcast-runtime.mjs "$ROOT"
node scripts/test-telegram-r14-transport-watchdog.mjs "$ROOT"
node scripts/verify-teams-fluent-warnings-r14.mjs "$ROOT"
node scripts/test-teams-fluent-settings-r14.mjs "$ROOT"
node scripts/test-r16-runtime-console-policy.mjs "$ROOT"
node scripts/test-r16-wrapper-only-http-status.mjs "$ROOT"
node scripts/test-r14-source-transpile.mjs "$ROOT"
node scripts/verify-portable-build-paths.mjs "$ROOT"
node scripts/test-r10-upstream-console-fixes.mjs "$ROOT"
echo '[3/6] current-run proof...'
node scripts/test-current-run-capture-proof.mjs "$ROOT"
echo '[3/6] history source audit...'
node scripts/test-history-capture-fixes.mjs "$ROOT"
echo '[3/6] history runtime harness...'
node scripts/test-history-capture-runtime-harness.mjs "$ROOT"
echo '[3/6] persistence audit...'
node scripts/verify-real-capture-persistence.mjs "$ROOT"

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
echo 'MACTRANSLATE_STABLE_REAL_CAPTURE_INSTALLED'
echo '真实消息落盘：~/Library/Application Support/MacTranslate/MessageRecognitionV6/messages.jsonl'
echo '菜单：MacTranslate → 查看消息 / 导出消息…'
echo '本次启动四平台验收：./CHECK_ALL_CAPTURE_NOW.command'
echo 'WhatsApp 实时：./TEST_WHATSAPP_CAPTURE.command'
echo 'WhatsApp 已加载历史：./TEST_WHATSAPP_HISTORY.command'

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

printf '\n[1/3] 校验 TranGPT 与 Signal 官方宿主配置...\n'
node scripts/verify-trangpt-official-signal-host.mjs

printf '\n[2/3] 构建 macOS ARM64 软件...\n'
chmod +x scripts/build-macos-arm64.sh
./scripts/build-macos-arm64.sh

printf '\n[3/3] 安装 MacTranslate...\n'
app_path="$(find out -type d -path '*/MacTranslate.app' -print -quit)"
[[ -n "$app_path" ]] || { echo '未找到构建后的 MacTranslate.app' >&2; exit 1; }
pkill -x MacTranslate 2>/dev/null || true
sudo rm -rf /Applications/MacTranslate.app
sudo ditto "$app_path" /Applications/MacTranslate.app
xattr -dr com.apple.quarantine /Applications/MacTranslate.app 2>/dev/null || true
open -a /Applications/MacTranslate.app
printf '\nSIGNAL_LOGIN_FIX_INSTALLED\n'
printf '没有删除任何 Signal 账号、分区或本地数据。\n'

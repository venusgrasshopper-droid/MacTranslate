#!/usr/bin/env bash
set -euo pipefail

APP=/Applications/MacTranslate.app/Contents/MacOS/MacTranslate
[[ -x "$APP" ]] || { echo "未找到 /Applications/MacTranslate.app" >&2; exit 1; }
OUT="$HOME/Downloads/MacTranslate-Signal-登录检查-$(date +%Y%m%d-%H%M%S).txt"

pkill -x MacTranslate 2>/dev/null || true
DEBUG='MacTranslate:EmbeddedSignalEngine,MacTranslate:SignalHost' \
ELECTRON_ENABLE_LOGGING=1 \
"$APP" --enable-logging=stderr --v=1 >"$OUT" 2>&1 &
PID=$!

echo "现在打开 Signal 账号并保持 90 秒。"
sleep 90
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

echo >>"$OUT"
echo '===== SIGNAL PRELOAD CHECK =====' >>"$OUT"
if grep -Eq 'ReferenceError: (Buffer|process) is not defined' "$OUT"; then
  echo 'SIGNAL_PRELOAD_CHECK_FAILED' | tee -a "$OUT"
  grep -nE 'ReferenceError: (Buffer|process) is not defined' "$OUT" | tee -a "$OUT"
  open -R "$OUT"
  exit 2
fi

echo 'SIGNAL_PRELOAD_CHECK_OK' | tee -a "$OUT"
open -R "$OUT"

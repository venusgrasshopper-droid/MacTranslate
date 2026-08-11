#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo '=== MacTranslate 已知错误源码检查 ==='
failed=0
check_absent() {
  local label="$1" pattern="$2"; shift 2
  if rg -n --pcre2 "$pattern" "$@" >/tmp/mactr_known_error_hit 2>/dev/null; then
    echo "FAIL $label"
    cat /tmp/mactr_known_error_hit
    failed=1
  else
    echo "OK   $label"
  fi
}
check_absent 'legacy archiveCollectorStatus' 'Ferdium\.archiveCollectorStatus' "$ROOT/src" "$ROOT/recipes"
check_absent 'legacy WA-JS getUserhash injector' 'getUserhash.*WAWebContactGetters' "$ROOT/src" "$ROOT/recipes"
check_absent 'legacy MsgCollection error injector' 'MsgCollection was not found' "$ROOT/src" "$ROOT/recipes"
check_absent 'legacy MsgStore error injector' 'MsgStore was not found' "$ROOT/src" "$ROOT/recipes"
check_absent 'Telegram invalid window.onload call' 'window\.onload\s*\(\s*\(\)\s*=>' "$ROOT/recipes/recipes/telegram"
check_absent 'WhatsApp undefined error variable callback' "request\.addEventListener\('error',\s*\(\)\s*=>[\\s\\S]{0,180}Opening model-storage database failed:[^\\n]*event" "$ROOT/recipes/recipes/whatsapp"
check_absent 'WhatsApp extra internal module lookups' "WAWebUserPrefsMeUser|WAWebSocketModel" "$ROOT/src/electron/message-recognition/UnifiedMessageRecognition.ts"
if (( failed )); then
  echo 'KNOWN_APP_ERROR_SOURCE=FOUND'
  exit 2
fi
echo 'KNOWN_APP_ERROR_SOURCE=ABSENT'
echo 'Signal Host preload environment:'
rg -n 'contextIsolation: true|sandbox: false' "$ROOT/src/electron/signal/SignalRuntimeHost.ts"

#!/usr/bin/env bash
set -euo pipefail
BASE="$HOME/Library/Application Support/MacTranslate"
removed=0
for root in "$BASE/recipes" "$BASE"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r -d '' f; do
    case "$f" in
      *MessageRecognitionV6/messages.jsonl|*MessageRecognitionV6/status.jsonl) continue ;;
    esac
    if [[ "$(basename "$f")" == webview.mactranslate*.js ]] || \
       grep -Eq 'Ferdium\.archiveCollectorStatus|getUserhash.*WAWebContactGetters|MsgCollection was not found|MsgStore was not found|__mactranslateRealWhatsAppV6[2345689]' "$f" 2>/dev/null; then
      rm -f "$f"; removed=$((removed+1))
    fi
  done < <(find "$root" -type f -name '*.js' -print0 2>/dev/null)
done
rm -rf "$BASE/MessageRecognitionV6/status.jsonl" 2>/dev/null || true
echo "STALE_CAPTURE_CLEAN_OK removed=$removed"

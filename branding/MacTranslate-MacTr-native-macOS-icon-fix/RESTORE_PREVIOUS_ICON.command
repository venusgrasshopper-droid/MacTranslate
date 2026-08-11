#!/usr/bin/env bash
set -euo pipefail

APP="/Applications/MacTranslate.app"
ROOT="$HOME/Library/Application Support/MacTranslate/IconBackups"
LATEST="$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name 'MT-12.4.3-SIGNAL-OK-RP01-*' -print 2>/dev/null | sort | tail -1)"
[[ -n "$LATEST" ]] || { echo "未找到图标备份" >&2; exit 1; }

pkill -x MacTranslate 2>/dev/null || true
sudo /bin/cp -f "$LATEST/Info.plist" "$APP/Contents/Info.plist"
OLD_ICON="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$LATEST/Info.plist" 2>/dev/null || true)"
if [[ -n "$OLD_ICON" ]]; then
  [[ "$OLD_ICON" == *.icns ]] || OLD_ICON="${OLD_ICON}.icns"
  [[ -f "$LATEST/$OLD_ICON" ]] && sudo /bin/cp -f "$LATEST/$OLD_ICON" "$APP/Contents/Resources/$OLD_ICON"
fi

sudo /usr/bin/codesign --force --deep --sign - \
  --preserve-metadata=identifier,entitlements,requirements,flags,runtime \
  "$APP"
/usr/bin/touch "$APP"
/usr/bin/killall iconservicesagent 2>/dev/null || true
/usr/bin/killall Finder 2>/dev/null || true
/usr/bin/killall Dock 2>/dev/null || true
sleep 3
/usr/bin/open -a "$APP"
echo "ICON_RESTORE_OK"

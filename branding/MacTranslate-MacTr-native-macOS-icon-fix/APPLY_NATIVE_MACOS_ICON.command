#!/usr/bin/env bash
set -euo pipefail

APP="/Applications/MacTranslate.app"
ROOT="$(cd "$(dirname "$0")" && pwd)"
ICONSET="$ROOT/MacTranslate-MacTr.iconset"
NEW_ICNS_NAME="MacTranslate-MacTr-RP01.icns"
NEW_ICNS="$ROOT/$NEW_ICNS_NAME"
INFO="$APP/Contents/Info.plist"
RES="$APP/Contents/Resources"
RESTORE_POINT="MT-12.4.3-SIGNAL-OK-RP01"
BACKUP_ROOT="$HOME/Library/Application Support/MacTranslate/IconBackups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/$RESTORE_POINT-$STAMP"

[[ -d "$APP" ]] || { echo "未找到：$APP" >&2; exit 1; }
[[ -f "$INFO" ]] || { echo "未找到：$INFO" >&2; exit 1; }
[[ -d "$ICONSET" ]] || { echo "缺少 iconset：$ICONSET" >&2; exit 1; }

pkill -x MacTranslate 2>/dev/null || true
mkdir -p "$BACKUP"

# 备份当前 Info.plist 和旧图标，便于只恢复图标。
cp -p "$INFO" "$BACKUP/Info.plist"
OLD_ICON="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$INFO" 2>/dev/null || true)"
if [[ -n "$OLD_ICON" ]]; then
  [[ "$OLD_ICON" == *.icns ]] || OLD_ICON="${OLD_ICON}.icns"
  [[ -f "$RES/$OLD_ICON" ]] && cp -p "$RES/$OLD_ICON" "$BACKUP/$OLD_ICON"
fi

# 在本机用 Apple iconutil 编译标准 ICNS。
rm -f "$NEW_ICNS"
/usr/bin/iconutil -c icns "$ICONSET" -o "$NEW_ICNS"
[[ -s "$NEW_ICNS" ]] || { echo "ICNS 生成失败" >&2; exit 1; }

# 移除上次写入的 Finder 自定义图标元数据，避免 Finder 与 Dock 使用不同图标。
/usr/bin/xattr -d com.apple.FinderInfo "$APP" 2>/dev/null || true
/usr/bin/xattr -d com.apple.ResourceFork "$APP" 2>/dev/null || true

# 真正替换应用图标资源，并用新文件名绕过旧 Dock 图标缓存。
sudo /bin/cp -f "$NEW_ICNS" "$RES/$NEW_ICNS_NAME"
if /usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$INFO" >/dev/null 2>&1; then
  sudo /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile $NEW_ICNS_NAME" "$INFO"
else
  sudo /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string $NEW_ICNS_NAME" "$INFO"
fi

# 资源与 Info.plist 发生变化后重新做本机签名；保留原有标识和权限元数据。
sudo /usr/bin/codesign --force --deep --sign - \
  --preserve-metadata=identifier,entitlements,requirements,flags,runtime \
  "$APP"

/usr/bin/touch "$APP"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

/usr/bin/killall iconservicesagent 2>/dev/null || true
/usr/bin/killall Finder 2>/dev/null || true
/usr/bin/killall Dock 2>/dev/null || true
sleep 3
/usr/bin/open -a "$APP"

echo "ICON_BUNDLE_UPDATE_OK"
echo "恢复点：$RESTORE_POINT"
echo "图标备份：$BACKUP"
echo "仅修改图标资源、CFBundleIconFile 和应用签名；程序代码未修改。"

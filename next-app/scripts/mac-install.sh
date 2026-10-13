#!/usr/bin/env bash
# «Бюджет» для Mac: сборка из macos/Budget, значок из иконки iOS-приложения, подпись для запуска на этом Mac
# и установка в /Applications.
#
#   scripts/mac-install.sh                                        — собрать, поставить и открыть
#   BUDGET_SERVER_URL=http://localhost:3001 scripts/mac-install.sh — открыть сайт с другого адреса
#   MAC_INSTALL_NO_OPEN=1 scripts/mac-install.sh                  — поставить, но не открывать
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_URL=${BUDGET_SERVER_URL:-$(sed -n 's/^DEPLOY_URL=//p' .env.deploy 2>/dev/null || true)}
SERVER_URL=${SERVER_URL:-https://45-132-178-214.sslip.io}
BUNDLE_ID=ru.ekinosian.budget.mac
NAME="Бюджет"
TARGET="/Applications/$NAME.app"
BUILD="${TMPDIR:-/tmp}budget-mac"
APP="$BUILD/$NAME.app"
VERSION=$(scripts/app-version.sh)
BUILD_NUMBER=$(date +%Y%m%d%H%M)

echo "→ Сборка ($SERVER_URL)"
rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ru.lproj"
swiftc -O -parse-as-library -swift-version 5 -target arm64-apple-macos26.0 \
  macos/Budget/*.swift -o "$APP/Contents/MacOS/Budget"

python3 macos/make-icon.py ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>Budget</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>CFBundleDevelopmentRegion</key><string>ru</string>
  <key>CFBundleLocalizations</key><array><string>ru</string></array>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.finance</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>BudgetServerURL</key><string>$SERVER_URL</string>
</dict>
</plist>
PLIST

# Подпись «для этого Mac»: без сертификата разработчика, приложение запускается только здесь.
codesign --force --sign - "$APP"

echo "→ Установка в $TARGET"
if [[ -d "$TARGET" ]]; then
  existing=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$TARGET/Contents/Info.plist" 2>/dev/null || true)
  if [[ "$existing" != "$BUNDLE_ID" ]]; then
    echo "В $TARGET лежит другое приложение ($existing) — не трогаю." >&2
    exit 1
  fi
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$TARGET"
fi
ditto "$APP" "$TARGET"
# Обновить значок в Dock и Finder.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET" >/dev/null 2>&1 || true

if [[ -z "${MAC_INSTALL_NO_OPEN:-}" ]]; then open "$TARGET"; fi
echo "✓ $NAME $VERSION ($BUILD_NUMBER) установлен"

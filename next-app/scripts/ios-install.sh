#!/usr/bin/env bash
# Сборка iOS-приложения и установка на телефон без открытия: собрать интерфейс, Xcode-проект,
# поставить и запустить в фоне (--no-activate) — приложение покажет пуш «Бюджет обновлён» с текстом
# последнего выпуска из «Что нового» (src/components/app/whatsNew/releases.ts). Подпись — личный Apple ID.
# IOS_DEVICE — UDID телефона (по умолчанию — первый подключённый iPhone), IOS_DERIVED — папка сборки.
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE=${IOS_DEVICE:-$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && /available|connected/ && !/unavailable/ {print $3; exit}')}
: "${DEVICE:?не найден iPhone — подключите телефон или задайте IOS_DEVICE}"
DERIVED=${IOS_DERIVED:-${TMPDIR:-/tmp}/budget-ios-build}
NOTICE=$(sed -n 's/^ *summary: "\(.*\)",$/\1/p' src/components/app/whatsNew/releases.ts | head -1)

echo "→ Интерфейс"
npm run ios:sync >/dev/null

echo "→ Сборка"
(cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Release -destination "id=$DEVICE" \
  -derivedDataPath "$DERIVED" -allowProvisioningUpdates build 2>&1 | grep -E " error:|BUILD" | sort -u)

echo "→ Установка"
xcrun devicectl device install app --device "$DEVICE" "$DERIVED/Build/Products/Release-iphoneos/App.app" >/dev/null

if [ -n "$NOTICE" ] && [ "${IOS_NOTIFY:-1}" = 1 ]; then
  echo "→ Пуш «Бюджет обновлён»"
  xcrun devicectl device process launch --no-activate --device "$DEVICE" ru.ekinosian.budget -- -BudgetUpdateNotice "$NOTICE" >/dev/null
fi
echo "✓ Готово"

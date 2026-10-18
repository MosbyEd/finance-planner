#!/usr/bin/env bash
# Сборка iOS-приложения и установка на телефон без открытия: собрать интерфейс, Xcode-проект,
# поставить и запустить в фоне (--no-activate) — приложение покажет пуш «Бюджет обновлён» с текстом
# последнего выпуска из «Что нового» (src/components/app/whatsNew/releases.ts). Подпись — личный Apple ID.
# IOS_DEVICE — UDID телефона (по умолчанию — первый подключённый iPhone), IOS_DERIVED — папка сборки,
# IOS_RENEW=1 — новая подпись на 7 дней, даже если до конца старой больше двух суток.
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE=${IOS_DEVICE:-$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && /available|connected/ && !/unavailable/ {print $3; exit}')}
: "${DEVICE:?не найден iPhone — подключите телефон или задайте IOS_DEVICE}"
# Не во временной папке: macOS её чистит, и скачанные пакеты Capacitor ломаются («no Info.plist found»).
DERIVED=${IOS_DERIVED:-$HOME/Library/Caches/budget-ios-build}
APP="$DERIVED/Build/Products/Release-iphoneos/App.app"
NOTICE=$(sed -n 's/^ *summary: "\(.*\)",$/\1/p' src/components/app/whatsNew/releases.ts | head -1)
# Версия в настройках iPhone — та же, что в «О приложении»; номер сборки — дата и время.
VERSION=$(scripts/app-version.sh)
BUILD_NUMBER=$(date +%Y%m%d%H%M)

# Подпись бесплатного Apple ID живёт 7 дней, а Xcode, пока профиль в кэше не истёк, берёт его же — переустановка
# срок не продлевает. Без профиля в кэше Xcode (-allowProvisioningUpdates) выпускает новый на 7 дней от сборки.
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
TEAM=A3AQ5X62W5
RENEW_BEFORE=$((2 * 24 * 3600))

profile_end() { # ISO-дата конца профиля → секунды
  date -j -u -f %Y-%m-%dT%H:%M:%SZ "$(security cms -D -i "$1" 2>/dev/null | plutil -extract ExpirationDate raw -)" +%s
}

budget_profiles() { # путь, приложение, конец — профили «Бюджета» и его расширений, только своей команды
  local f plist app
  for f in "$PROFILES"/*.mobileprovision; do
    [ -e "$f" ] || continue
    plist=$(security cms -D -i "$f" 2>/dev/null) || continue
    app=$(plutil -extract Entitlements.application-identifier raw - <<<"$plist" 2>/dev/null) || continue
    case "$app" in "$TEAM.ru.ekinosian.budget" | "$TEAM.ru.ekinosian.budget."*) ;; *) continue ;; esac
    printf '%s\t%s\t%s\n' "$f" "$app" "$(profile_end "$f")"
  done
}

# Срок подписи — самый ранний из свежих профилей приложения и виджета (старые копии в кэше не в счёт).
SOONEST=$(budget_profiles | awk -F'\t' '!($2 in end) || $3 > end[$2] { end[$2] = $3 }
  END { for (a in end) if (min == "" || end[a] < min) min = end[a]; print min }')
if [ -n "$SOONEST" ] && { [ "${IOS_RENEW:-0}" = 1 ] || [ $((SOONEST - $(date +%s))) -lt $RENEW_BEFORE ]; }; then
  # Не удаляем: перекладываем в резервную папку рядом с кэшем.
  BACKUP="$PROFILES Backup/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP"
  budget_profiles | cut -f1 | while IFS= read -r f; do mv "$f" "$BACKUP/"; done
  echo "→ Новая подпись (старая до $(date -r "$SOONEST" '+%d.%m %H:%M'), её профили — в $BACKUP)"
fi

echo "→ Интерфейс"
npm run ios:sync >/dev/null

echo "→ Сборка $VERSION ($BUILD_NUMBER)"
(cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Release -destination "id=$DEVICE" \
  -derivedDataPath "$DERIVED" -allowProvisioningUpdates MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  build 2>&1 | grep -E " error:|BUILD" | sort -u)
SIGNED_UNTIL=$(profile_end "$APP/embedded.mobileprovision")
echo "  подпись до $(date -r "$SIGNED_UNTIL" '+%d.%m %H:%M')"

echo "→ Установка"
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null
# Срок подписи того, что стоит на телефоне (секунды с 1970), — для scripts/ios-auto-reinstall.sh.
echo "$SIGNED_UNTIL" > "$DERIVED/installed-expiry"

if [ -n "$NOTICE" ] && [ "${IOS_NOTIFY:-1}" = 1 ]; then
  echo "→ Пуш «Бюджет обновлён»"
  xcrun devicectl device process launch --no-activate --device "$DEVICE" ru.ekinosian.budget -- -BudgetUpdateNotice "$NOTICE" >/dev/null
fi
echo "✓ Готово"

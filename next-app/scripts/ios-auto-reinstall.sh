#!/usr/bin/env bash
# Еженедельная переустановка «Бюджета» на iPhone: подпись бесплатного Apple ID живёт 7 дней, после неё iOS не
# запускает приложение, и СМС из «Команд» не записываются. Агент launchd запускает скрипт по субботам каждый час
# с 2:00 до 23:00 (если Mac спал — при пробуждении), а скрипт:
#   - если с субботы 2:00 уже переустанавливал — ничего не делает;
#   - если iPhone недоступен — ничего не делает до следующего запуска;
#   - иначе собирает из чистой копии последнего выложенного коммита (origin/rework/next-app), а не из рабочей
#     папки, где бывают чужие незакоммиченные правки, и ставит с новой подписью на 7 дней (IOS_RENEW=1);
#   - пуш «Бюджет обновлён» повторяет, пока телефон не разблокируют: запуск в фоне ещё и переставляет
#     напоминания о подписи на новый срок;
#   - при ошибке — уведомление на Mac (одно и то же — не чаще раза в 6 часов).
# Журнал — ~/Library/Logs/budget-ios-resign.log.
#
#   scripts/ios-auto-reinstall.sh             — то же, что делает агент
#   scripts/ios-auto-reinstall.sh --dry-run   — только проверки: что сделал бы сейчас
#   scripts/ios-auto-reinstall.sh --force     — переустановить сейчас, даже если на этой неделе уже было
#   scripts/ios-auto-reinstall.sh --install   — записать и загрузить агент; --uninstall — выгрузить и удалить
# Агент один раз переустановит при следующем запуске (проверка в его окружении):
#   touch ~/Library/Caches/budget-auto-reinstall/force-once && launchctl kickstart gui/$(id -u)/com.eduard.budget-ios-resign
set -uo pipefail

SCRIPTS=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(dirname "$SCRIPTS")
REPO=$(git -C "$APP_DIR" rev-parse --show-toplevel)
LABEL=com.eduard.budget-ios-resign
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
LOG=$HOME/Library/Logs/budget-ios-resign.log
STATE=$HOME/Library/Caches/budget-auto-reinstall
DERIVED=${IOS_DERIVED:-$HOME/Library/Caches/budget-ios-build}
BUNDLE_ID=ru.ekinosian.budget
# У launchd в PATH только системные папки, а node и npm — в /usr/local/bin.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
MONTHS=(января февраля марта апреля мая июня июля августа сентября октября ноября декабря)

. "$SCRIPTS/ios-lock.sh"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# «2 ноября в 03:15»
human_date() {
  local m
  m=$(date -j -f %s "$1" +%m)
  echo "$(date -j -f %s "$1" +%-d) ${MONTHS[$((10#$m - 1))]} в $(date -j -f %s "$1" +%H:%M)"
}

# Последняя суббота 2:00, которая уже наступила: с неё начинается неделя переустановки.
week_start() {
  local start
  # date +%u: 1 — понедельник … 6 — суббота, 7 — воскресенье; (u + 1) % 7 — сколько дней прошло с субботы.
  start=$(($(date -j -v0H -v0M -v0S +%s) - ($(date +%u) + 1) % 7 * 86400 + 2 * 3600))
  [ "$start" -gt "$(date +%s)" ] && start=$((start - 7 * 86400))
  echo "$start"
}

# Уведомление на Mac; одно и то же — не чаще раза в 6 часов, чтобы повторные попытки не сыпали одинаковыми.
notify() {
  local stamp=$STATE/notified
  log "Уведомление на Mac: $1"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$1" ] && [ -n "$(find "$stamp" -mmin -360)" ]; then return; fi
  printf '%s' "$1" > "$stamp"
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Бюджет на iPhone"' -e 'end run' "$1" >/dev/null 2>&1 || true
}

# with_timeout <секунды> <команда…>: зависшую команду (devicectl ждёт пароль для xcodebuild -runFirstLaunch
# после обновления Xcode) снимаем вместе с дочерними процессами. Код 124 — сработал таймаут.
with_timeout() {
  local limit=$1 waited=0 pid
  shift
  set -m
  "$@" &
  pid=$!
  set +m
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill -TERM -- "-$pid" 2>/dev/null
      sleep 3
      kill -KILL -- "-$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# Срок подписи того, что стоит на телефоне, в секундах с 1970: его записывает scripts/ios-install.sh после
# установки; если записи нет — срок профиля последней сборки.
installed_expiry() {
  local iso
  if [ -s "$DERIVED/installed-expiry" ]; then
    cat "$DERIVED/installed-expiry"
    return
  fi
  iso=$(security cms -D -i "$DERIVED/Build/Products/Release-iphoneos/App.app/embedded.mobileprovision" 2>/dev/null |
    plutil -extract ExpirationDate raw -o - - 2>/dev/null) || return 1
  date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null
}

# Первый iPhone, который видит devicectl: UDID в DEVICE.
find_device() {
  local out=$STATE/devices.txt
  DEVICE=${IOS_DEVICE:-}
  [ -n "$DEVICE" ] && return 0
  if ! with_timeout 60 xcrun devicectl list devices >"$out" 2>&1; then
    log "devicectl не ответил за минуту: $(tail -1 "$out")"
    return 1
  fi
  DEVICE=$(awk '/iPhone/ && /physical/ && /available|connected/ && !/unavailable/' "$out" | grep -oE '[0-9A-F]{8}-[0-9A-F]{16}' | head -1)
  [ -n "$DEVICE" ]
}

# Телефон отвечает; LOCKED=1 — заблокирован (ставить можно, а запустить приложение для пуша — нет).
probe_device() {
  local out=$STATE/lock.json
  rm -f "$out"
  with_timeout 60 xcrun devicectl device info lockState --device "$DEVICE" --timeout 45 --json-output "$out" -q >/dev/null 2>&1 || return 1
  LOCKED=$(plutil -extract result.passcodeRequired raw -o - "$out" 2>/dev/null)
  [ "$LOCKED" = true ] && LOCKED=1 || LOCKED=0
}

# Пуш «Бюджет обновлён» после установки: на заблокированном телефоне фоновый запуск не получается — тогда
# текст ждёт в push-pending до следующей попытки.
send_pending_push() {
  local pending=$STATE/push-pending out=$STATE/push.txt
  [ -s "$pending" ] || return 0
  if with_timeout 90 xcrun devicectl device process launch --no-activate --device "$DEVICE" "$BUNDLE_ID" \
    -- -BudgetUpdateNotice "$(cat "$pending")" >"$out" 2>&1; then
    rm -f "$pending"
    log "Пуш «Бюджет обновлён» отправлен"
    return 0
  fi
  log "Пуш пока не отправлен (телефон заблокирован?) — повторю: $(grep -m1 -iE 'error|locked' "$out" || tail -1 "$out")"
  return 1
}

TREE=$STATE/tree
remove_tree() {
  if [ -e "$TREE" ]; then
    git -C "$REPO" worktree remove --force "$TREE" >/dev/null 2>&1 || rm -rf "$TREE"
  fi
  git -C "$REPO" worktree prune
}

cleanup() {
  remove_tree
  ios_unlock
}

# Чистая копия последнего выложенного коммита: всё выложенное пушится в origin с этого Mac.
prepare_tree() {
  local sha
  sha=$(git -C "$REPO" rev-parse -q --verify refs/remotes/origin/rework/next-app || git -C "$REPO" rev-parse refs/heads/rework/next-app) || return 1
  log "Сборка из $(git -C "$REPO" log -1 --format='%h %s' "$sha")"
  remove_tree
  git -C "$REPO" worktree add -q --detach "$TREE" "$sha" || return 1
  # Клон APFS: быстро и без лишнего места; ссылку вместо папки сборщик не принимает.
  cp -c -R "$APP_DIR/node_modules" "$TREE/next-app/node_modules" || return 1
  # Без .env.deploy интерфейс собрался бы с адресом этого Mac в локальной сети вместо сервера.
  cp "$APP_DIR/.env.deploy" "$TREE/next-app/.env.deploy" || return 1
  [ -f "$APP_DIR/.env.local" ] && cp "$APP_DIR/.env.local" "$TREE/next-app/.env.local"
  return 0
}

# Подсказка к ошибке установки — по известным поломкам после обновления Xcode.
install_hint() {
  if grep -qiE 'runFirstLaunch|CoreDevice.*(version|mismatch)' "$1"; then
    echo "после обновления Xcode нужен «sudo xcodebuild -runFirstLaunch» в Терминале"
  elif grep -qiE 'No Accounts|No account for team|not signed in|sign in with your Apple ID' "$1"; then
    echo "войдите в Apple ID в Xcode → Settings → Accounts"
  elif grep -qiE 'explicitly trusted|untrusted developer' "$1"; then
    echo "доверьте сертификату на iPhone: Настройки → Основные → VPN и управление устройством"
  else
    echo "подробности — в ~/Library/Logs/budget-ios-resign.log"
  fi
}

install_agent() {
  local hour slots=""
  for hour in $(seq 2 23); do
    slots="$slots
		<dict><key>Weekday</key><integer>6</integer><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>0</integer></dict>"
  done
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<!-- По субботам переустанавливает «Бюджет» на iPhone с новой 7-дневной подписью (next-app/scripts/ios-auto-reinstall.sh). -->
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$SCRIPTS/ios-auto-reinstall.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>BUDGET_AGENT</key>
		<string>1</string>
	</dict>
	<!-- Суббота, каждый час с 2:00 до 23:00: после удачной установки остальные запуски ничего не делают. -->
	<key>StartCalendarInterval</key>
	<array>$slots
	</array>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
</dict>
</plist>
EOF
  plutil -lint -s "$PLIST" || return 1
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "✓ Агент $LABEL загружен: по субботам с 2:00, журнал $LOG"
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  echo "✓ Агент $LABEL выгружен"
}

main() {
  local force=0 dry=0 due=0 expiry=0 left since last out rc new_expiry
  case "${1:-}" in
    --install) install_agent; return ;;
    --uninstall) uninstall_agent; return ;;
    --force) force=1 ;;
    --dry-run) dry=1 ;;
    "") ;;
    *) echo "Неизвестный параметр: $1 (см. начало скрипта)" >&2; return 2 ;;
  esac
  mkdir -p "$STATE" "$(dirname "$LOG")"
  # Агент пишет в журнал через launchd; вручную — и в терминал, и в журнал.
  if [ "${BUDGET_AGENT:-}" != 1 ]; then exec > >(tee -a "$LOG") 2>&1; fi
  if [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 2000000 ]; then
    tail -n 5000 "$LOG" > "$LOG.tmp" && cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
  fi
  if [ "$dry" = 0 ] && [ -f "$STATE/force-once" ]; then
    rm -f "$STATE/force-once"
    force=1
    log "Разовая переустановка по force-once"
  fi

  expiry=$(installed_expiry) || expiry=0
  left=$((expiry - $(date +%s)))
  since=$(week_start)
  last=$(cat "$STATE/last-install" 2>/dev/null || echo 0)
  if [ "$force" = 1 ] || [ "$last" -lt "$since" ]; then due=1; fi
  if [ "$expiry" = 0 ]; then
    log "Срок подписи неизвестен (нет сборки в $DERIVED)"
  else
    log "Подпись до $(human_date "$expiry") (осталось $((left / 3600)) ч); последняя переустановка агентом — $([ "$last" = 0 ] && echo 'не было' || human_date "$last")"
  fi

  # На этой неделе уже переустановлено и пуш не ждёт — к телефону даже не обращаемся.
  if [ "$due" = 0 ] && [ "$dry" = 0 ] && [ ! -s "$STATE/push-pending" ]; then
    log "С субботы $(human_date "$since") уже переустанавливал — ничего не делаю"
    return 0
  fi

  if ! find_device || ! probe_device; then
    log "iPhone недоступен — попробую при следующем запуске"
    if [ "$due" = 1 ] && [ "$dry" = 0 ] && [ "$left" -lt $((12 * 3600)) ]; then
      if [ "$left" -le 0 ]; then
        notify "Подпись «Бюджета» закончилась, а iPhone недоступен — подключите его к Mac кабелем или к той же Wi-Fi"
      else
        notify "Подпись «Бюджета» кончается $(human_date "$expiry"), а iPhone недоступен — подключите его к Mac кабелем или к той же Wi-Fi"
      fi
    fi
    return 0
  fi
  log "iPhone $DEVICE на связи$([ "$LOCKED" = 1 ] && echo ', заблокирован')"
  [ "$dry" = 0 ] && send_pending_push

  if [ "$due" = 0 ]; then
    log "С субботы $(human_date "$since") уже переустанавливал — ничего не делаю"
    return 0
  fi
  if [ "$dry" = 1 ]; then
    log "Переустановил бы сейчас (--dry-run — ничего не делаю)"
    return 0
  fi

  if pgrep -qf 'scripts/(deploy|ios-install)\.sh|xcodebuild|devicectl device install'; then
    log "Идёт выкладка или сборка из другой сессии — попробую при следующем запуске"
    return 0
  fi
  if ! ios_lock; then
    log "Замок занят — попробую при следующем запуске"
    return 0
  fi
  trap cleanup EXIT

  if ! prepare_tree; then
    notify "Переустановка «Бюджета» не смогла подготовить копию проекта — подробности в журнале"
    return 1
  fi
  out=$STATE/install.txt
  log "Ставлю на iPhone (scripts/ios-install.sh, новая подпись)"
  # 40 минут — с большим запасом: обычно 3–6 минут, первая сборка в новой папке — дольше.
  with_timeout 2400 env IOS_DEVICE="$DEVICE" IOS_RENEW=1 IOS_NOTIFY=0 "$TREE/next-app/scripts/ios-install.sh" >"$out" 2>&1
  rc=$?
  sed 's/^/    /' "$out"
  remove_tree
  ios_unlock
  if [ "$rc" = 124 ]; then
    notify "Переустановка «Бюджета» зависла и снята — вероятно, после обновления Xcode нужен «sudo xcodebuild -runFirstLaunch»"
    return 1
  elif [ "$rc" != 0 ]; then
    notify "Переустановка «Бюджета» не удалась: $(install_hint "$out")"
    return 1
  fi

  date +%s > "$STATE/last-install"
  new_expiry=$(installed_expiry) || new_expiry=$expiry
  log "Установлено; подпись до $(human_date "$new_expiry")"
  if [ $((new_expiry - $(date +%s))) -lt $((6 * 86400)) ]; then
    notify "«Бюджет» переустановлен, но подпись не продлилась: кончается $(human_date "$new_expiry")"
  fi
  if [ "$new_expiry" -gt $((expiry + 3600)) ]; then
    echo "Подпись продлена до $(human_date "$new_expiry") — СМС будут записываться и дальше." > "$STATE/push-pending"
  else
    echo "Установлена последняя версия; подпись действует до $(human_date "$new_expiry")." > "$STATE/push-pending"
  fi
  # Ночью телефон почти всегда заблокирован: несколько попыток сейчас, дальше — при следующих запусках.
  for _ in 1 2 3; do
    send_pending_push && break
    sleep 60
  done
  return 0
}

main "$@"

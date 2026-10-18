# Замок установки на iPhone: один телефон делят сессии Claude (scripts/ios-install.sh) и агент
# автопереустановки (scripts/ios-auto-reinstall.sh). Подключается через `.`; ios_lock берёт замок или
# возвращает 1, если его держит живой процесс; снимает его ios_unlock (обычно в trap … EXIT).
# Вызванный из-под замка скрипт (BUDGET_IOS_LOCKED=1) второй раз его не берёт.
IOS_LOCK_DIR=${IOS_LOCK_DIR:-$HOME/Library/Caches/budget-ios-install.lock}
IOS_LOCK_OWNED=0

ios_lock() {
  [ "${BUDGET_IOS_LOCKED:-}" = 1 ] && return 0
  if ! mkdir "$IOS_LOCK_DIR" 2>/dev/null; then
    local holder
    holder=$(cat "$IOS_LOCK_DIR/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "На iPhone уже ставит другой процесс (pid $holder)" >&2
      return 1
    fi
    # Прежний владелец завершился, не сняв замок.
    rm -rf "$IOS_LOCK_DIR"
    mkdir "$IOS_LOCK_DIR" 2>/dev/null || return 1
  fi
  echo $$ > "$IOS_LOCK_DIR/pid"
  IOS_LOCK_OWNED=1
  export BUDGET_IOS_LOCKED=1
}

ios_unlock() {
  if [ "$IOS_LOCK_OWNED" = 1 ]; then
    rm -rf "$IOS_LOCK_DIR"
    IOS_LOCK_OWNED=0
    unset BUDGET_IOS_LOCKED
  fi
}

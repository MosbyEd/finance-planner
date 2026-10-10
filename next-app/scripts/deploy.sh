#!/usr/bin/env bash
# Выкладка на сервер в облаке: сборка → копирование → переключение версии → перезапуск → проверка.
# Адрес сервера — в .env.deploy (DEPLOY_HOST=budget@1.2.3.4, DEPLOY_URL=https://1-2-3-4.sslip.io).
# Первичная настройка сервера — deploy/server-setup.sh (см. README).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.deploy ] && . ./.env.deploy
: "${DEPLOY_HOST:?задайте DEPLOY_HOST в .env.deploy}"
: "${DEPLOY_URL:?задайте DEPLOY_URL в .env.deploy}"
KEY=${DEPLOY_KEY:-$HOME/.ssh/budget_server_ed25519}
SSH=(ssh -i "$KEY" -o BatchMode=yes)

RELEASE=$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
echo "→ Сборка $RELEASE"
DEPLOY_BUILD=1 APP_VERSION="$RELEASE" npx next build

# Самодостаточный пакет: сервер + статика (Next не кладёт её в standalone сам).
PKG=.next-deploy/standalone
cp -R public "$PKG/public"
mkdir -p "$PKG/.next-deploy"
cp -R .next-deploy/static "$PKG/.next-deploy/static"

echo "→ Копирование на $DEPLOY_HOST"
"${SSH[@]}" "$DEPLOY_HOST" "mkdir -p /opt/budget/releases/$RELEASE"
rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" "$PKG/" "$DEPLOY_HOST:/opt/budget/releases/$RELEASE/"

echo "→ Переключение и перезапуск"
"${SSH[@]}" "$DEPLOY_HOST" "set -e
  ln -sfn /opt/budget/releases/$RELEASE /opt/budget/current.new
  mv -T /opt/budget/current.new /opt/budget/current
  sudo systemctl restart budget
  # Оставляем три последние версии — для отката.
  ls -1dt /opt/budget/releases/* | tail -n +4 | xargs -r rm -rf"

echo "→ Проверка $DEPLOY_URL"
for _ in $(seq 1 30); do
  if curl -fsS "$DEPLOY_URL/api/me" >/dev/null 2>&1; then
    echo "✓ Готово: $DEPLOY_URL ($RELEASE)"
    exit 0
  fi
  sleep 2
done
echo "✗ Сервер не ответил. Журнал: ssh $DEPLOY_HOST journalctl -u budget -n 50" >&2
exit 1

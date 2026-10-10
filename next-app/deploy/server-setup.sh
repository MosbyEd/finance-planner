#!/usr/bin/env bash
# Первичная настройка сервера (Ubuntu 24.04). Повторный запуск безопасен.
# Запуск на сервере: sudo bash server-setup.sh <домен>
# Ставит Node.js, Caddy (HTTPS), службу приложения, ежедневные бэкапы базы и закрывает вход по паролю.
set -euo pipefail

DOMAIN=${1:?"укажите домен, например 1-2-3-4.sslip.io"}
NODE_VERSION=25.7.0
NODE_SHA256=2af25e8fc301bb3bbf02874f7d07e1d00483dc143fbd0eb56ee844c17849168e
CADDY_VERSION=2.11.7
APP_USER=budget-app
DEPLOY_USER=${SUDO_USER:-budget}
HERE=$(cd "$(dirname "$0")" && pwd)

export DEBIAN_FRONTEND=noninteractive
# Сразу после создания ВМ apt ещё может быть занят автообновлениями — ждём замок, а не падаем.
apt-get() { command apt-get -o DPkg::Lock::Timeout=900 "$@"; }
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl xz-utils libatomic1 sqlite3 rsync unattended-upgrades

timedatectl set-timezone Europe/Moscow

# Подкачка: 2 ГБ памяти хватает, но запас не помешает.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# Node.js — та же версия, что при разработке (node:sqlite).
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSLo "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c -
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
  rm -rf "$tmp"
fi

# Caddy — HTTPS-прокси с автоматическим сертификатом Let's Encrypt.
# Пакет с GitHub: apt-репозиторий Caddy (cloudsmith) из российских сетей отвечает 402.
if [ "$(caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]; then
  tmp=$(mktemp -d)
  base="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
  curl -fsSLo "$tmp/caddy_${CADDY_VERSION}_linux_amd64.deb" "$base/caddy_${CADDY_VERSION}_linux_amd64.deb"
  curl -fsSLo "$tmp/checksums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  (cd "$tmp" && grep " caddy_${CADDY_VERSION}_linux_amd64.deb\$" checksums.txt | sha512sum -c -)
  apt-get install -y -q "$tmp/caddy_${CADDY_VERSION}_linux_amd64.deb"
  rm -rf "$tmp"
fi

# Пользователь службы и каталоги.
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/budget --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 /var/lib/budget
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 /opt/budget /opt/budget/releases
install -d -o root -g "$APP_USER" -m 750 /etc/budget
# Бэкапы пишет служба, а забирает (rsync на Mac) пользователь выкладки — через общую группу.
install -d -o "$APP_USER" -g "$DEPLOY_USER" -m 2750 /var/backups/budget

if [ ! -f /etc/budget/env ]; then
  cat >/etc/budget/env <<EOF
NODE_ENV=production
PORT=3001
HOSTNAME=127.0.0.1
DATABASE_PATH=/var/lib/budget/finance.sqlite
TRUST_PROXY=true
ALLOW_REGISTRATION=false
CORS_ORIGINS=capacitor://localhost
DEEPSEEK_API_KEY=
EOF
fi
chown root:"$APP_USER" /etc/budget/env
chmod 640 /etc/budget/env

install -m 644 "$HERE/budget.service" /etc/systemd/system/budget.service
install -m 644 "$HERE/budget-backup.service" /etc/systemd/system/budget-backup.service
install -m 644 "$HERE/budget-backup.timer" /etc/systemd/system/budget-backup.timer
systemctl daemon-reload
systemctl enable budget.service budget-backup.timer
systemctl start budget-backup.timer

sed "s/{{DOMAIN}}/$DOMAIN/g" "$HERE/Caddyfile" >/etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy

# Вход только по ключу.
cat >/etc/ssh/sshd_config.d/10-budget.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh

echo "Готово: https://$DOMAIN"

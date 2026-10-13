#!/usr/bin/env bash
# Версия приложения для сборок iOS и Mac — как APP_VERSION в releases.ts: «3.» и число выпусков в «Что нового».
set -euo pipefail
cd "$(dirname "$0")/.."
echo "3.$(grep -cE '^    id: "[0-9]{4}-[0-9]{2}-[0-9]{2}' src/components/app/whatsNew/releases.ts)"

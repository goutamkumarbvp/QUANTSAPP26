#!/bin/sh
# Q26 Options - one-click start (macOS / Linux). Run: ./start-q26.sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Install Node.js LTS from https://nodejs.org first."; exit 1; }
if [ ! -f .env ]; then cp .env.example .env; echo "Created .env: fill in NEO_*, AUTH_SECRET, OPS_ADMIN_EMAILS, then run this again."; exit 0; fi
[ -d node_modules ] || npm ci --no-audit --no-fund || exit 1
[ -f apps/server/dist/server.mjs ] || npm run build || exit 1
echo "Starting Q26 Options: http://localhost:8787 (Ctrl+C to stop)"
( sleep 8; (command -v xdg-open >/dev/null && xdg-open http://localhost:8787) || (command -v open >/dev/null && open http://localhost:8787) ) >/dev/null 2>&1 &
exec npm run start:supervised

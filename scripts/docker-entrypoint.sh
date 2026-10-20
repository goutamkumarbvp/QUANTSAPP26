#!/bin/sh
# Q26 container entrypoint: runs the supervisor as the unprivileged `node` user. Started as root only
# to hand data volumes created by older images (which ran as root) to `node` first; the ownership walk
# runs only when some file is not owned by `node` yet.
set -e
DATA=/app/apps/server/data
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  if [ -n "$(find "$DATA" ! -user node -print -quit 2>/dev/null)" ]; then
    echo "entrypoint: giving $DATA to the node user (volume from an older image)"
    chown -R node:node "$DATA"
  fi
  exec su node -s /bin/sh -c 'exec node scripts/supervise.mjs'
fi
exec node scripts/supervise.mjs

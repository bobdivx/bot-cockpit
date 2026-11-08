#!/bin/sh
set -eu
mkdir -p "$(dirname "$BOT_COCKPIT_DATA")"
chown -R node:node "$(dirname "$BOT_COCKPIT_DATA")"
exec gosu node node dist/server/index.js

#!/bin/sh
set -eu

node /app/scripts/inject-public-env.mjs

(cd /app/apps/api && node --import tsx src/server.ts) &

cd /app/apps/web
exec node node_modules/next/dist/bin/next start -p 3000

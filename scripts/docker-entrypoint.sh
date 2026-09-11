#!/bin/sh
set -eu

api_pid=''
web_pid=''

stop_children() {
  for child_pid in "$api_pid" "$web_pid"; do
    if [ -n "$child_pid" ]; then
      kill -TERM "$child_pid" 2>/dev/null || true
    fi
  done

  for child_pid in "$api_pid" "$web_pid"; do
    if [ -n "$child_pid" ]; then
      wait "$child_pid" 2>/dev/null || true
    fi
  done
}

shutdown() {
  trap - TERM INT
  stop_children
  exit 0
}

trap shutdown TERM INT

node /app/scripts/inject-public-env.mjs

(cd /app/apps/api && exec node --import tsx src/server.ts) &
api_pid=$!

(cd /app/apps/web && exec node node_modules/next/dist/bin/next start -p 3000) &
web_pid=$!

while :; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    if wait "$api_pid"; then child_status=0; else child_status=$?; fi
    break
  fi
  if ! kill -0 "$web_pid" 2>/dev/null; then
    if wait "$web_pid"; then child_status=0; else child_status=$?; fi
    break
  fi
  sleep 0.1
done

stop_children
exit "$child_status"

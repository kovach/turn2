#!/bin/sh
# Run the browser typecheck/emit watcher and the dev server together, each
# under its own supervisor so a crash in one (e.g. tsc dying on an inotify
# ENOSPC limit) is logged and auto-restarted instead of silently leaving the
# other half running with no rebuilds. Ctrl-C tears the whole group down.
trap 'kill 0' EXIT

# Restart $@ forever, logging each exit. A short backoff keeps a command that
# fails instantly from spinning the CPU.
supervise() {
  name=$1
  shift
  while true; do
    "$@"
    status=$?
    echo "[watch.sh] '$name' exited (status $status); restarting in 2s..." >&2
    sleep 2
  done
}

supervise tsc node_modules/.bin/tsc -p tsconfig.browser.json --watch --preserveWatchOutput &
supervise server node_modules/.bin/tsx watch src/server.ts --port 5174 &

wait

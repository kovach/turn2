#!/bin/sh
# Run the browser typecheck/emit watcher and the dev server together, each
# under its own supervisor so a crash in one (e.g. tsc dying on an inotify
# ENOSPC limit) is logged and auto-restarted instead of silently leaving the
# other half running with no rebuilds. Ctrl-C tears the whole group down.
# Usage: ./watch.sh <port> [rw]
# The server runs with --read-only by default; pass `rw` to allow writes.
# Trap INT/TERM explicitly: background jobs start with SIGINT ignored in a
# non-interactive shell, so the supervisors outlive a Ctrl-C unless we SIGTERM
# the whole process group ourselves (and an untrapped SIGINT may skip EXIT).
# The trap is installed only after arg validation: a usage-error exit must not
# kill 0, which would SIGTERM the caller's process group too.

port=$1
case "$port" in
  ''|*[!0-9]*)
    echo "usage: $0 <port> [rw]" >&2
    exit 1
    ;;
esac

trap 'trap - INT TERM EXIT; kill 0' INT TERM EXIT

server_flags="--read-only"
if [ "$2" = "rw" ]; then
  server_flags=""
fi

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
supervise server node_modules/.bin/tsx watch src/server.ts --port "$port" $server_flags &

wait

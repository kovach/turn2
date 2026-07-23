#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/ts"
if [ $# -eq 0 ]; then
  # Default sweep: v2 + shared tests only. Skip the deprecated v1 tests
  # (those importing from src/v1/); they can still be run explicitly by name.
  files=()
  for f in src/tests/*.test.ts; do
    if grep -q 'from "\.\./v1/' "$f"; then continue; fi
    files+=("$f")
  done
else
  files=()
  for name in "$@"; do
    files+=("src/tests/${name}.test.ts")
  done
fi
for f in "${files[@]}"; do
  echo "  $f"
  # In-process loader, not the tsx CLI: the CLI spawns a child node behind a
  # unix-socket IPC server, which sandboxes may forbid (listen EPERM).
  node --import tsx "$f"
done
echo "all tests passed"

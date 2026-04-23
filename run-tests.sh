#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/ts"
if [ $# -eq 0 ]; then
  files=(src/tests/*.test.ts)
else
  files=()
  for name in "$@"; do
    files+=("src/tests/${name}.test.ts")
  done
fi
for f in "${files[@]}"; do
  echo "  $f"
  npx tsx "$f"
done
echo "all tests passed"

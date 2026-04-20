#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/ts"
for f in src/*.test.ts; do
  echo "  $f"
  npx tsx "$f"
done
echo "all tests passed"

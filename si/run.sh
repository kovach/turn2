#!/bin/sh
# usage: [SEED=n] [GAS=n] [RAW=1] run.sh file.t [more.t ...]
#   concatenates the files, evaluates, and (unless RAW=1) hides acc rows,
#   internal tuples and static setup facts. SEED overrides `+rng-seed 7`.
cd "$(dirname "$0")/../ts"
for f in "$@"; do cat "$OLDPWD/$f"; done | sed "s/+rng-seed 7\$/+rng-seed ${SEED:-7}/" \
  | npm run -s v2 -- --gas ${GAS:-3000} --tuple-gas 50000 2>&1 | grep -v "DEP0\|trace-dep" \
  | if [ -n "$RAW" ]; then cat; else awk '{ split($NF, iv, /\.\./); if (iv[1] == iv[2]) next; print }' \
  | grep -vE '^(_|moved|is |piece |piece:kind|kind|invader |land|adjacent|card|ocean|spirit|presence-of|rng-seed|invader-card|tally|tallied|context|element|power)'; fi

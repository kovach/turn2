// collectPositiveLines: which source lines qualify for forward highlighting
// (lines containing at least one emitting atom). Ported from the behavior
// previously inlined in web-v2.ts (plans/v2-source-timeline-link.md).

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { collectPositiveLines } from "../v2/source-link.js";

const SOURCE = `
~game
  ( ~step here );
  ( ~look )

#agg at * -> last

step L, +at me -> L

look, at me -> L, ^print L
`;

const parsed = parse(SOURCE);
if ("message" in parsed) {
  throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
}

const lines = collectPositiveLines(parsed.rules);

// Emitting atoms: ~game (2), ~step (3), ~look (4) — the latter two inside
// Sub bodies, which must be walked — +at (8), ^print (10).
assert.deepEqual(
  [...lines].sort((a, b) => a - b),
  [2, 3, 4, 8, 10],
  `positive lines mismatch: got {${[...lines].sort((a, b) => a - b).join(", ")}}`,
);

// Non-rule and match-only positions never qualify: blank (1, 5), the #agg
// directive (6), and lines whose only atoms are pure matches would be
// absent — 8 and 10 qualify through their asserts, not their matches.
for (const l of [1, 5, 6, 7, 9]) {
  assert.ok(!lines.has(l), `line ${l} should not be positive`);
}

console.log("ALL v2 source-link tests passed");

// collectPositiveSpans: which emitting-atom spans qualify for forward
// highlighting, indexed by source line. Ported from collectPositiveLines
// (plans/v2-source-timeline-link.md) when linking went per-atom
// (plans/v2-atom-span-provenance.md).

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { spanKey } from "../v2/term.js";
import { collectPositiveSpans } from "../v2/source-link.js";

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

const spans = collectPositiveSpans(parsed.rules);

// Emitting atoms: ~game (2), ~step (3), ~look (4) — the latter two inside
// Sub bodies, which must be walked — +at (8), ^print (10).
assert.deepEqual(
  [...spans.keys()].sort((a, b) => a - b),
  [2, 3, 4, 8, 10],
  `positive lines mismatch: got {${[...spans.keys()].sort((a, b) => a - b).join(", ")}}`,
);

// Non-rule and match-only positions never qualify: blank (1, 5), the #agg
// directive (6), and lines whose only atoms are pure matches would be
// absent — 8 and 10 qualify through their asserts, not their matches.
for (const l of [1, 5, 6, 7, 9]) {
  assert.ok(!spans.has(l), `line ${l} should not be positive`);
}

// Every collected span carries columns whose extent slices the source back
// out — the key invariant per-atom linking rests on.
const lines = SOURCE.split("\n");
const keyed = new Set<string>();
for (const [line, list] of spans) {
  for (const s of list) {
    const key = spanKey(s);
    assert.ok(key !== undefined, `line ${line}: emitting span has no columns`);
    keyed.add(key);
    const text = lines[s.line - 1]!.slice(s.startCol, s.endCol);
    assert.ok(text.length > 0 && text === text.trim(), `bad extent for ${key}: "${text}"`);
  }
}
// The two emitting atoms on line 8/10 sit at distinct keys from their lines'
// match atoms (which are absent), and `+at me -> L` slices exactly.
const atSpan = spans.get(8)![0]!;
assert.equal(lines[7]!.slice(atSpan.startCol, atSpan.endCol), "+at me -> L");
assert.equal(keyed.size, [...spans.values()].flat().length, "span keys must be distinct");

console.log("ALL v2 source-link tests passed");

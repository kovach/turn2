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

#acc at : e (@last loc)

step L, +put me L

put X L / at X L

look, at me L, ^print L
`;

const parsed = parse(SOURCE);
if ("message" in parsed) {
  throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
}

const spans = collectPositiveSpans(parsed.rules);

// Emitting atoms: ~game (2), ~step (3), ~look (4) — the latter two inside
// Sub bodies, which must be walked — +put (8), ^print (12).
assert.deepEqual(
  [...spans.keys()].sort((a, b) => a - b),
  [2, 3, 4, 8, 12],
  `positive lines mismatch: got {${[...spans.keys()].sort((a, b) => a - b).join(", ")}}`,
);

// Non-rule and match-only positions never qualify: blanks (1, 5, 7, 9, 11),
// the #acc directive (6), the acc rule (10: it contributes, it never emits a
// tuple), and lines whose only atoms are pure matches would be absent — 8 and
// 12 qualify through their asserts, not their matches.
for (const l of [1, 5, 6, 7, 9, 10, 11]) {
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
// The two emitting atoms on line 8/12 sit at distinct keys from their lines'
// match atoms (which are absent), and `+put me L` slices exactly.
const putSpan = spans.get(8)![0]!;
assert.equal(lines[7]!.slice(putSpan.startCol, putSpan.endCol), "+put me L");
assert.equal(keyed.size, [...spans.values()].flat().length, "span keys must be distinct");

console.log("ALL v2 source-link tests passed");

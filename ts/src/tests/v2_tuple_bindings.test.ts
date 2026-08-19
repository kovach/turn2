// Per-tuple binding decoding (plans/v2-live-values-in-editor.md):
// `tupleBindings` zips a stored tuple's `(*id rule lexPos (*chain …))` slot
// against the expanded rule's Emit template to recover the user variables
// (name → value) that were bound when the tuple was asserted.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { candidatesByHead } from "../v2/store.js";
import { renderAtom, renderTerm, renderTermShallow, tupleBindings } from "../v2/print.js";
import { collectVarLines } from "../v2/source-link.js";

const src = [
  "#agg c -> last",
  "~setup; ~go",
  "setup, +n (s z), +m a, +c 1, +q b",
  "go, n (s X), m Y, +pin X Y",
  "  q Z",
  "  +pq X Z",
  "go, c -> V, +cv V",
].join("\n");

const parsed = parse(src);
if ("message" in parsed) throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
const { store, rules } = runFixpoint(parsed, 200, 5000);
assert.ok(rules !== undefined, "runFixpoint should expose the expanded rules");

function one(head: string): number {
  const idxs = candidatesByHead(store, head);
  assert.equal(idxs.length, 1, `expected one '${head}' tuple, got ${idxs.length}`);
  return idxs[0]!;
}

// pin X Y: both user vars, in first-occurrence order, no compiler slots.
{
  const r = tupleBindings(store, rules, one("pin"));
  assert.ok(r, "pin tuple should decode");
  assert.equal(r.ruleName, "r3");
  assert.deepEqual(r.bindings.map((b) => b.name), ["X", "Y"]);
  for (const b of r.bindings) assert.ok(!b.name.startsWith("_"));
  assert.equal(renderTerm(store, r.bindings[0]!.term), "z");
  assert.equal(renderTerm(store, r.bindings[1]!.term), "a");
  // Shallow rendering gives the `*id` form for compound values.
  const pinAtom = renderAtom(store, store.tuples[one("pin")]!.atom);
  assert.equal(pinAtom, "pin z a");
}

// pq X Z is emitted from a consumer segment (the rule is split at `+pin`);
// the prefix variable X is still present, Y too (bound before the emit).
{
  const r = tupleBindings(store, rules, one("pq"));
  assert.ok(r, "pq tuple should decode");
  assert.deepEqual(r.bindings.map((b) => b.name), ["X", "Y", "Z"]);
  assert.equal(renderTerm(store, r.bindings[2]!.term), "b");
}

// Aggregate-read rule: V bound by the agg result.
{
  const r = tupleBindings(store, rules, one("cv"));
  assert.ok(r);
  assert.deepEqual(r.bindings.map((b) => b.name), ["V"]);
  assert.equal(renderTermShallow(store, r.bindings[0]!.term), "1");
}

// Engine rows (`_do-agg` and the `_agg-result` that copies its trailing id)
// may decode to the emitting rule, but never to user bindings; a tuple whose
// last term is not an id slot at all yields undefined.
for (const head of ["_agg-result", "_do-agg"]) {
  for (const i of candidatesByHead(store, head)) {
    assert.deepEqual(tupleBindings(store, rules, i)?.bindings ?? [], [], `${head} has no user bindings`);
  }
}
{
  const fakeIdx = store.tuples.length;
  store.tuples.push({ atom: { terms: [{ tag: "Symbol", name: "seed" }, { tag: "Symbol", name: "x" }] }, l: store.bot, r: store.top });
  assert.equal(tupleBindings(store, rules, fakeIdx), undefined, "no id slot → undefined");
  store.tuples.pop();
}

// Name → first-occurrence line/col per rule (pre-expand rules).
{
  const vl = collectVarLines(parsed.rules);
  const r3 = vl.get("r3");
  assert.ok(r3, "r3 should have a var-line map");
  assert.deepEqual(
    [...r3.entries()].map(([n, p]) => [n, p.line]),
    [["X", 4], ["Y", 4], ["Z", 5]],
  );
  assert.ok(r3.get("X")!.col < r3.get("Y")!.col, "X precedes Y on line 4");
}

console.log("PASS: tuple bindings decode from the id slot; var lines map to first occurrence");
console.log("ALL v2 tuple-bindings tests passed");

// Per-rule order-robust fuzz: for each rule pattern in the corpus,
// lower it, run `unifyConstraints` against a fixed reference store
// recording the visit-bindings, then permute `te.matching` K times
// (fixed seed) and assert the same multiset of bindings is produced
// each time.
//
// Compares solutions as multisets of binding maps — see
// plans/order-robust-unifier.md §"Differential testing".

import assert from "node:assert/strict";
import { parsePatterns } from "../v1/parse.js";
import { expandAll } from "../v1/expand.js";
import { lower } from "../v1/lower.js";
import { newTrail, trailLookup, type MatchingConstraint, type Term } from "../v1/types.js";
import { unifyConstraints, collectMatches } from "../v1/unify.js";
import { createHashcons, hashconsAtom, hashconsTerm } from "../v1/hashcons.js";
import {
  emptyRefStore,
  insertRow,
  addParentChild,
  addBeforeAfter,
  type NodeRow,
} from "../v1/refstore.js";
import { sym } from "../v1/types.js";
import type { Tree } from "../v1/types.js";

// --- Tiny deterministic PRNG (mulberry32) ---
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// --- Build a fixture reference store ---
//
// A small store with a few sibling subtrees and explicit
// before:after edges. Keeps the corpus self-contained without
// depending on the parser/expand path for the data side.
function buildFixtureStore() {
  const hc = createHashcons();
  const store = emptyRefStore(hc);
  const mk = (name: string, head: string, ...rest: Term[]): Term => {
    const id = hashconsTerm(sym(name), hc);
    const row: NodeRow = {
      tag: "Assert",
      id,
      atom: hashconsAtom({ terms: [sym(head), ...rest] }, hc),
      gen: 0,
    };
    insertRow(store, row, hc);
    return id;
  };
  const turn = mk("turn1", "turn", sym("t"));
  const m1 = mk("m1", "move", sym("a"));
  const m2 = mk("m2", "move", sym("b"));
  const m3 = mk("m3", "move", sym("c"));
  addParentChild(store, turn, m1, hc);
  addParentChild(store, turn, m2, hc);
  addParentChild(store, turn, m3, hc);
  addBeforeAfter(store, m1, m2, hc);
  addBeforeAfter(store, m2, m3, hc);
  // Disjoint sibling tree: another turn with one move.
  const turn2 = mk("turn2", "turn", sym("t2"));
  const m4 = mk("m4", "move", sym("a"));
  addParentChild(store, turn2, m4, hc);
  return { hc, store };
}

// --- Capture visit-bindings as a sorted multiset of canonical strings ---
//
// Per visit, snapshot every name on the trail (latest binding wins)
// and serialize `name=token,…`. Two runs that produce the same
// multiset of solutions stringify identically once sorted.
function snapshot(trail: ReturnType<typeof newTrail>): string {
  const names = new Set<string>(trail.names);
  const parts: string[] = [];
  for (const n of names) {
    const t = trailLookup(trail, n);
    parts.push(`${n}=${termKey(t)}`);
  }
  parts.sort();
  return parts.join("|");
}
function termKey(t: Term | undefined): string {
  if (!t) return "?";
  if (t.tag === "Symbol") return `S:${t.name}`;
  if (t.tag === "Variable") return `V:${t.name}`;
  if (t.tag === "Wildcard") return "_";
  if (t.tag === "Ref") return `R:${t.id}`;
  // Atom / Id — small enough in fixtures to include head only.
  return `${t.tag}:[${t.atom.terms.map(termKey).join(",")}]`;
}

function runAndCollect(matching: MatchingConstraint[], assertions: never[], store: ReturnType<typeof buildFixtureStore>): string[] {
  void assertions;
  const trail = newTrail();
  const out: string[] = [];
  unifyConstraints(
    { matching, assertions },
    store.store,
    trail,
    Number.MAX_SAFE_INTEGER,
    store.hc,
    () => out.push(snapshot(trail)),
  );
  out.sort();
  return out;
}

// --- Corpus: small parsed rules covering Match/Before/Overlap/Equal ---
const corpus: string[] = [
  // Single match.
  `- move X`,
  // Nested match (parent + child).
  `- turn _\n  - move X`,
  // Before with sibling anchor.
  `- turn _\n  - move S\n  < move X`,
  // Two distinct moves under a turn.
  `- turn _\n  - move X\n  - move Y`,
  // Equal binding plus a match.
  `- move X\n  = X (a)`,
];

const rng = mulberry32(0xc0ffee);

for (const src of corpus) {
  const parsed = parsePatterns(src, ["fz"]);
  if ("message" in parsed) throw new Error(`parse: ${parsed.message}`);
  const expanded = expandAll(parsed);
  for (const pat of expanded) {
    const te = lower(pat);
    const fixture = buildFixtureStore();
    const baseline = runAndCollect(te.matching, [], fixture);
    // 8 shuffles per pattern.
    for (let iter = 0; iter < 8; iter++) {
      const permuted = shuffle(te.matching, rng);
      const fresh = buildFixtureStore();
      const got = runAndCollect(permuted, [], fresh);
      assert.deepEqual(got, baseline,
        `pattern ${JSON.stringify(src)} (iter ${iter}): permuted matching produced different solutions\n` +
        `baseline: ${baseline.join(" ; ")}\n` +
        `permuted: ${got.join(" ; ")}`);
    }
  }
}
console.log("PASS: order-robust fuzz over rule corpus");

// Suppress the unused import warning — collectMatches is exported on the
// surface we lean on, and the import documents intent.
void collectMatches;

console.log("All order-robust tests passed.");

// Tree-mode lane-layout invariants for `renderTimeline`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { timelineCollapseKey } from "../v2/render-output.js";
import { compressRefs, renderAtom } from "../v2/print.js";
import { layoutTimeline, DEFAULT_OPTS, type TimelineOpts, type TimelineLayout } from "../v2/timeline.js";

const SOURCE = `
~game
  ( ~step here );
  ( ~look );
  ( ~step there );
  ( ~look );

#agg at * -> last

step L, +at me -> L

look, at me -> L, ^print L
`;

const parsed = parse(SOURCE);
if ("message" in parsed) {
  throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
}
const { store, status } = runFixpoint(parsed, 200, 5000);
assert.equal(status.kind, "done", `fixpoint did not finish: ${status.kind}`);

const opts: TimelineOpts = { ...DEFAULT_OPTS, laneMode: "tree" };
// Stub measurer — this is a layout assertion, not a pixel one, and we
// want the test to run headless without a canvas.
const layout = layoutTimeline(store, opts, () => 0);

assert.equal(
  layout.laneCount, 3,
  `game/step/look/print in tree mode should fit in 3 lanes; got ${layout.laneCount}\n` +
  `lanes per bar: ${layout.bars.map(b => `${b.label}=${b.lane}`).join(", ")}`,
);

// game on lane 0, the four steps/looks on lane 1, the prints on lane 2.
// Key by head token: `~game` etc. auto-fill to arity 1, so labels now carry a
// trailing id (`game *4`) — plans/v2-arity-auto-wildcard.md.
const laneOf = new Map<string, number>();
for (const b of layout.bars) laneOf.set(b.label.split(" ")[0]!, b.lane);
assert.equal(laneOf.get("game"), 0, `game on lane 0, got ${laneOf.get("game")}`);

console.log("PASS: tree mode collapses game/step/look/print to 3 lanes");

// --- edges variant: step/fractional columns + canonical anchors ---

const eLayout = layoutTimeline(
  store,
  { ...DEFAULT_OPTS, laneMode: "tree", momentStyle: "edges" },
  () => 0,
);

// Every displayed moment gets its own column: ranks are exactly 0..N-1.
const cols = [...eLayout.moments.values()].map((m) => m.rank).sort((a, b) => a - b);
for (let i = 0; i < cols.length; i++) {
  assert.equal(cols[i], i, `columns must be a permutation of 0..N-1; got ${cols.join(",")}`);
}
assert.equal(eLayout.maxRank, cols.length - 1);

// Column x-position = prefix sum of the per-step gap widths.
function colXs(layout: TimelineLayout): number[] {
  const xs = [0];
  for (let r = 0; r < layout.maxRank; r++) xs.push(xs[r]! + layout.colWidths[r]!);
  return xs;
}

// The two-tier invariant. With a stub measurer (no label widths) every gap is
// exactly its floor: minFracWidth within a step-rank, minColWidth across a
// boundary. So (a) covers — always comparable — span at least one full step,
// and (b) no gap is wider than a step or narrower than the fractional floor.
function assertTwoTier(layout: TimelineLayout, label: string): void {
  const xs = colXs(layout);
  for (const e of layout.edges) {
    const f = layout.moments.get(e.from)!.rank;
    const t = layout.moments.get(e.to)!.rank;
    assert.ok(f < t, `[${label}] cover ${e.from}→${e.to} must increase column (${f} vs ${t})`);
    assert.ok(
      xs[t]! - xs[f]! >= DEFAULT_OPTS.minColWidth,
      `[${label}] comparable moments must be ≥ a step apart; got ${xs[t]! - xs[f]!}`,
    );
  }
  for (const w of layout.colWidths) {
    assert.ok(
      w === DEFAULT_OPTS.minFracWidth || w === DEFAULT_OPTS.minColWidth,
      `[${label}] every floored gap is fractional or a full step; got ${w}`,
    );
  }
}
assertTwoTier(eLayout, "inline");

// Canonical anchors + ties partition the bar-edge occurrences: each (bar,
// side) is either some moment's anchor or a tie.
let anchored = 0;
for (const a of eLayout.momentAnchor.values()) if (a !== null) anchored++;
assert.equal(
  anchored + eLayout.momentTies.length, eLayout.bars.length * 2,
  "every (bar, side) occurrence is an anchor or a tie",
);

// orderPairs excludes pairs a bar already shows as its own endpoints.
const barPairs = new Set(eLayout.bars.map((b) => `${b.lTok},${b.rTok}`));
for (const p of eLayout.orderPairs) {
  assert.ok(!barPairs.has(`${p.from},${p.to}`), "bar-implied pair must be suppressed");
}

console.log("PASS: edges variant assigns unique order-respecting columns and anchors");

// --- real data: the two tiers actually both occur ---
// dominion's choices/throne-room expansion yields incomparable moments that
// share a step-rank, so its layout must contain fractional gaps (the inline
// program above is a total order and exercises only the step tier).
const domSrc = readFileSync(new URL("../../data/v2/dominion.t", import.meta.url), "utf8");
const domParsed = parse(domSrc);
if ("message" in domParsed) {
  throw new Error(`dominion parse error line ${domParsed.line}: ${domParsed.message}`);
}
const domLayout = layoutTimeline(
  runFixpoint(domParsed, 200, 5000).store,
  { ...DEFAULT_OPTS, laneMode: "tree", momentStyle: "edges" },
  () => 0,
);
const fracGaps = domLayout.colWidths.filter((w) => w === DEFAULT_OPTS.minFracWidth).length;
assert.ok(fracGaps > 0, `dominion should have incomparable same-rank moments; got ${fracGaps} fractional gaps`);
assertTwoTier(domLayout, "dominion");
console.log(`PASS: dominion exercises both tiers (${fracGaps} fractional gaps)`);

// --- monotone placement: no drift from unrelated subtrees ---
// plans/v2-timeline-occupancy-lanes.md. The `move` bars nest under
// `setup` and must sit directly above it, even though `turn`'s
// pairwise-incomparable children a/b/c later need fresh lanes. Under
// the old splice-shifting placer they pushed the moves to the top.
const driftSrc = `
~setup; ~turn

setup,
  ~move a here;
  ~move b here;
  ~move a there;
  ~move c there

turn, ~a

turn, ~b

turn, ~c
`;
const driftParsed = parse(driftSrc);
if ("message" in driftParsed) {
  throw new Error(`drift parse error line ${driftParsed.line}: ${driftParsed.message}`);
}
const driftLayout = layoutTimeline(
  runFixpoint(driftParsed, 200, 5000).store,
  { ...DEFAULT_OPTS, laneMode: "tree" },
  () => 0,
);
const setupLane = driftLayout.bars.find((b) => b.label.startsWith("setup"))!.lane;
for (const b of driftLayout.bars) {
  if (!b.label.startsWith("move")) continue;
  assert.equal(
    b.lane, setupLane + 1,
    `"${b.label}" should sit directly above setup (lane ${setupLane + 1}); got ${b.lane}\n` +
    `lanes: ${driftLayout.bars.map((x) => `${x.label}=${x.lane}`).join(", ")}`,
  );
}

// Disjointness invariant: same-lane bars never overlap. The true rule
// is chain-ordering in the moment partial order; the order isn't in
// the layout, but comparable moments always differ in rank, so
// rank-disjointness is a necessary condition — the check can't fail a
// valid layout, it just won't catch incomparable-but-rank-disjoint
// sharing.
function assertLaneInvariants(layout: TimelineLayout, label: string): void {
  const leq = (a: number, b: number): boolean =>
    a === b || layout.moments.get(a)!.rank < layout.moments.get(b)!.rank;
  for (const x of layout.bars) for (const y of layout.bars) {
    if (x.tupleIndex >= y.tupleIndex) continue;
    if (x.lane === y.lane) {
      assert.ok(
        leq(x.rTok, y.lTok) || leq(y.rTok, x.lTok),
        `[${label}] same-lane bars "${x.label}"/"${y.label}" must be rank-disjoint`,
      );
    }
  }
}
assertLaneInvariants(driftLayout, "drift");
assertLaneInvariants(layout, "game");
console.log("PASS: moves stay adjacent to setup; lane invariants hold");

// --- Source provenance (plans/v2-source-timeline-link.md) ---
// Every bar/fact tupleIndex must round-trip to a recorded source line so the
// renderer can stamp data-source-line for source ↔ output linking.
for (const b of layout.bars) {
  const span = store.tupleSource[b.tupleIndex];
  assert.ok(
    span !== undefined && span.line >= 1,
    `bar "${b.label}" (tuple ${b.tupleIndex}) has no source line`,
  );
}
for (const f of layout.facts) {
  if (f.tupleIndex < 0) continue; // synthetic "+N more" row
  const span = store.tupleSource[f.tupleIndex];
  assert.ok(
    span !== undefined && span.line >= 1,
    `fact "${f.label}" (tuple ${f.tupleIndex}) has no source line`,
  );
}
console.log("PASS: bars/facts carry source-line provenance");

// Sidebar rows (is/constrain tuples) carry the source line too.
const sidebarSrc = `
~is choice value
`;
const sidebarParsed = parse(sidebarSrc);
if ("message" in sidebarParsed) {
  throw new Error(`sidebar parse error line ${sidebarParsed.line}: ${sidebarParsed.message}`);
}
const sidebarLayout = layoutTimeline(
  runFixpoint(sidebarParsed, 200, 5000).store,
  { ...DEFAULT_OPTS, laneMode: "tree" },
  () => 0,
);
assert.ok(sidebarLayout.sidebar.length > 0, "expected an `is` sidebar section");
for (const section of sidebarLayout.sidebar) {
  for (const row of section.rows) {
    assert.ok(
      row.line !== undefined && row.line >= 1,
      `sidebar row "${row.label}" has no source line`,
    );
  }
}
console.log("PASS: sidebar rows carry source-line provenance");

// --- Collapsed intervals (`opts.collapsed`) ---
const collapseSrc = `
~game

game, ~turn

turn
  ( ~action, + drew );
  ( ~cleanup )

action, ~play

game, + score
`;
const collapseParsed = parse(collapseSrc);
if ("message" in collapseParsed) {
  throw new Error(`collapse parse error line ${collapseParsed.line}: ${collapseParsed.message}`);
}
const collapseStore = runFixpoint(collapseParsed, 200, 5000).store;
const baseCollapse = layoutTimeline(collapseStore, { ...DEFAULT_OPTS, laneMode: "tree" }, () => 0);
const barNamed = (l: TimelineLayout, name: string) => {
  const b = l.bars.find((x) => x.label.startsWith(name));
  assert.ok(b !== undefined, `expected a "${name}" bar`);
  return b;
};
for (const name of ["game", "turn", "action", "play", "cleanup"]) barNamed(baseCollapse, name);

const turnBar = barNamed(baseCollapse, "turn");
const collapsedLayout = layoutTimeline(
  collapseStore,
  { ...DEFAULT_OPTS, laneMode: "tree", collapsed: [{ l: turnBar.lTok, r: turnBar.rTok }] },
  () => 0,
);
assert.deepEqual(
  collapsedLayout.bars.map((b) => b.label).sort(),
  ["turn...", barNamed(baseCollapse, "game").label].sort(),
  `collapsing turn should leave only the outer game bar plus the "turn..." stand-in; ` +
  `got ${collapsedLayout.bars.map((b) => b.label).join(", ")}`,
);
const standIn = collapsedLayout.bars.find((b) => b.collapsed)!;
assert.equal(standIn.label, "turn...", "the stand-in is labeled with the collapsed episode's name");
assert.equal(standIn.lTok, turnBar.lTok);
assert.equal(standIn.rTok, turnBar.rTok);
// The stand-in keeps the collapsed episode's tuple, so source linking works.
assert.equal(standIn.tupleIndex, turnBar.tupleIndex);
// `drew` starts inside the collapsed span and is hidden; `score` starts at
// the game's start (outside it) and survives.
const factLabels = collapsedLayout.facts.map((f) => f.label);
assert.ok(!factLabels.some((l) => l.startsWith("drew")), `drew should be hidden; got ${factLabels.join(", ")}`);
assert.ok(factLabels.some((l) => l.startsWith("score")), `score should survive; got ${factLabels.join(", ")}`);

// An interval nested inside another collapsed one is subsumed — no second
// stand-in bar appears.
const actionBar = barNamed(baseCollapse, "action");
const nestedLayout = layoutTimeline(
  collapseStore,
  {
    ...DEFAULT_OPTS, laneMode: "tree",
    collapsed: [{ l: turnBar.lTok, r: turnBar.rTok }, { l: actionBar.lTok, r: actionBar.rTok }],
  },
  () => 0,
);
assert.equal(nestedLayout.bars.filter((b) => b.collapsed).length, 1, "nested collapse should be subsumed");
assert.deepEqual(
  nestedLayout.bars.map((b) => b.label).sort(),
  collapsedLayout.bars.map((b) => b.label).sort(),
);

// Collapsing an inner interval leaves its siblings alone.
const innerLayout = layoutTimeline(
  collapseStore,
  { ...DEFAULT_OPTS, laneMode: "tree", collapsed: [{ l: actionBar.lTok, r: actionBar.rTok }] },
  () => 0,
);
const innerLabels = innerLayout.bars.map((b) => b.label);
assert.ok(innerLabels.includes("action..."), `expected an "action..." bar; got ${innerLabels.join(", ")}`);
assert.ok(!innerLabels.some((l) => l.startsWith("play")), "play is inside action and should be hidden");
assert.ok(innerLabels.some((l) => l.startsWith("cleanup")), "cleanup is a sibling and should survive");
assert.ok(innerLabels.some((l) => l.startsWith("turn")), "turn contains action and should survive");
console.log("PASS: collapsed intervals hide contained episodes and interior facts");

// Co-extensive episodes (`~a, ^b` emits two bars over one interval) collapse
// as a unit: collapsing either folds both into one stand-in, which is labeled
// with the episode that was collapsed and carries its tuple, so right-clicking
// it expands them all again.
{
  const dupSrc = `
~a, ^b

a, ~c
`;
  const dupParsed = parse(dupSrc);
  if ("message" in dupParsed) throw new Error(`dup parse error: ${dupParsed.message}`);
  const dupStore = runFixpoint(dupParsed, 200, 5000).store;
  const base = layoutTimeline(dupStore, { ...DEFAULT_OPTS, laneMode: "tree" }, () => 0);
  const bBar = base.bars.find((x) => x.label.startsWith("b"))!;
  const aBar = base.bars.find((x) => x.label.startsWith("a"))!;
  assert.ok(bBar !== undefined && aBar !== undefined, "expected both a and b bars");
  assert.equal(aBar.lTok, bBar.lTok, "fixture requires a and b to share an interval");
  assert.equal(aBar.rTok, bBar.rTok, "fixture requires a and b to share an interval");
  assert.ok(base.bars.some((x) => x.label.startsWith("c")), "expected a nested c bar");

  // Collapsing b — the second of the pair — folds a and the nested c with it.
  const collapsedB = layoutTimeline(
    dupStore,
    {
      ...DEFAULT_OPTS, laneMode: "tree",
      collapsed: [{ l: bBar.lTok, r: bBar.rTok, tupleIndex: bBar.tupleIndex }],
    },
    () => 0,
  );
  assert.deepEqual(
    collapsedB.bars.map((x) => x.label), ["b..."],
    `collapsing b should fold every co-extensive bar; got ${collapsedB.bars.map((x) => x.label).join(", ")}`,
  );
  // Named after the episode that was collapsed, not whichever comes first.
  assert.equal(collapsedB.bars[0]!.tupleIndex, bBar.tupleIndex, "the stand-in stays b's click target");

  // Collapsing a is symmetric — same fold, its own label.
  const collapsedA = layoutTimeline(
    dupStore,
    {
      ...DEFAULT_OPTS, laneMode: "tree",
      collapsed: [{ l: aBar.lTok, r: aBar.rTok, tupleIndex: aBar.tupleIndex }],
    },
    () => 0,
  );
  assert.deepEqual(collapsedA.bars.map((x) => x.label), ["a..."]);
  assert.equal(collapsedA.bars[0]!.tupleIndex, aBar.tupleIndex);

  // Both collapsed at once is still one interval, hence one stand-in.
  const collapsedBoth = layoutTimeline(
    dupStore,
    {
      ...DEFAULT_OPTS, laneMode: "tree",
      collapsed: [
        { l: aBar.lTok, r: aBar.rTok, tupleIndex: aBar.tupleIndex },
        { l: bBar.lTok, r: bBar.rTok, tupleIndex: bBar.tupleIndex },
      ],
    },
    () => 0,
  );
  assert.equal(collapsedBoth.bars.length, 1, "one interval collapses to one bar");
  assert.ok(collapsedBoth.bars[0]!.collapsed);
  console.log("PASS: co-extensive episodes collapse and expand as a unit");
}

// --- Collapse keys survive re-evaluation ---
// The editor re-runs the program on every edit, and appends an `^ is …` row
// when the user resolves a choice. Hashcons ids shift across those runs, so
// the collapse key must not depend on them: an episode that still derives the
// same way must keep its key, or the timeline would silently expand.
{
  const choiceSrc = `
+ cell c1

~game
  ? C
  ! cell C
  ~pick C

pick C
  is C V
  ~use V
`;
  const p1 = parse(choiceSrc);
  if ("message" in p1) throw new Error(`choice parse error: ${p1.message}`);
  const r1 = runFixpoint(p1, 200, 5000);
  assert.equal(r1.status.kind, "active-choices", `expected an active choice; got ${r1.status.kind}`);
  if (r1.status.kind !== "active-choices") throw new Error("unreachable");

  const keysOf = (store: typeof r1.store): Map<string, string> => {
    const m = new Map<string, string>();
    for (let i = 0; i < store.tuples.length; i++) {
      const key = timelineCollapseKey(store, i);
      if (key === null) continue;
      const head = store.tuples[i]!.atom.terms[0];
      if (head?.tag === "Symbol" && !head.name.startsWith("_")) m.set(head.name, key);
    }
    return m;
  };
  const before = keysOf(r1.store);
  assert.ok(before.has("game"), `expected a game episode; got ${[...before.keys()].join(", ")}`);
  assert.ok(before.has("pick"), `expected a pick episode; got ${[...before.keys()].join(", ")}`);

  // Resolve the choice the way web-v2's click handler does: reify the active
  // term with `compressRefs` (raw `*<token>` wouldn't survive the re-run —
  // that token shift is exactly why the collapse key can't use one) and append
  // an `^ is` row.
  const choice = r1.status.choices[0]!;
  const { bindings, results } = compressRefs([choice.activeTerms[0]!], r1.store);
  const p2 = parse(`${choiceSrc}\n${bindings.join("\n")}\n^ is ${results[0]} c1\n`);
  if ("message" in p2) throw new Error(`resolved parse error: ${p2.message}`);
  const r2 = runFixpoint(p2, 200, 5000);
  const after = keysOf(r2.store);

  for (const name of ["game", "pick"]) {
    assert.equal(
      after.get(name), before.get(name),
      `the ${name} episode's collapse key must survive the appended \`is\` row`,
    );
  }
  // The hashcons tokens did move — that shift is what the old atom-rendered
  // key tripped over.
  assert.notEqual(
    renderAtom(r2.store, r2.store.tuples.find((t) => {
      const h = t.atom.terms[0];
      return h?.tag === "Symbol" && h.name === "pick";
    })!.atom),
    renderAtom(r1.store, r1.store.tuples.find((t) => {
      const h = t.atom.terms[0];
      return h?.tag === "Symbol" && h.name === "pick";
    })!.atom),
    "this fixture is only meaningful while the appended row shifts pick's token",
  );

  // Sanity: the key is a fixed-size fingerprint, not an expansion of the id
  // DAG — expanding one of these bodies is exponential in derivation depth.
  assert.ok(
    /^[0-9a-f]{16}$/.test(after.get("pick")!),
    `collapse keys must be a 64-bit fingerprint; got ${after.get("pick")}`,
  );
  console.log("PASS: collapse keys survive an appended `is` resolution");
}

console.log("ALL v2 timeline-layout tests passed");

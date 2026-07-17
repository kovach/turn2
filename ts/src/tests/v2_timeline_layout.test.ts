// Tree-mode lane-layout invariants for `renderTimeline`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
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

console.log("ALL v2 timeline-layout tests passed");

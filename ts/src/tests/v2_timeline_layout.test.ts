// Tree-mode lane-layout invariants for `renderTimeline`.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { layoutTimeline, DEFAULT_OPTS, type TimelineOpts } from "../v2/timeline.js";

const SOURCE = `
~game
  ( ~step here );
  ( ~look );
  ( ~step there );
  ( ~look );

#acc at * -> last

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
const laneOf = new Map<string, number>();
for (const b of layout.bars) laneOf.set(b.label, b.lane);
assert.equal(laneOf.get("game"), 0, `game on lane 0, got ${laneOf.get("game")}`);

console.log("PASS: tree mode collapses game/step/look/print to 3 lanes");
console.log("ALL v2 timeline-layout tests passed");

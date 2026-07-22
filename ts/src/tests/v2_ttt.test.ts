// End-to-end ttt regression: drive the fixture program through three turns
// by appending choice resolutions to source between fixpoint runs, and
// verify that the count of newly-emitted `eligible` rows decreases as
// 9 → 8 → 7 across turns 1, 2, 3.
//
// This exercises:
//   - rule splitting at a weighted match nested inside a sub-rule
//     (`( el-check, cell R C, fills (cell R C) -> z )`),
//   - cross-turn visibility of `+ fills … -> 1` contributions,
//   - free / `_free` handling in the wrapped do-agg pattern,
//   - the empty-group guard that prevents `_free` leakage,
//   - constraint-query interval scoping (the `! eligible` row's stored
//     interval gates which `eligible` candidates appear as options).
//
// If any of those pieces regresses, the option count for some turn will
// either go to 0 (engine stuck) or stay at 9 (fills not seen).

import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { compressRefs } from "../v2/print.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "fixtures/ttt.t");
const baseSource = readFileSync(fixturePath, "utf-8");

const GAS = 500;
const TUPLE_GAS = 100000;
const TURNS_TO_PLAY = 3;

let source = baseSource;
const optionCounts: number[] = [];

for (let turn = 1; turn <= TURNS_TO_PLAY; turn++) {
  const parsed = parse(source);
  if ("message" in parsed) {
    throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
  }
  const { store, status } = runFixpoint(parsed, GAS, TUPLE_GAS);

  assert.equal(status.kind, "active-choices",
    `turn ${turn}: expected status 'active-choices', got '${status.kind}'`);
  if (status.kind !== "active-choices") break;

  // The ttt program presents one component per turn (the cell choice).
  assert.equal(status.components.length, 1,
    `turn ${turn}: expected 1 component, got ${status.components.length}`);
  const comp = status.components[0]!;
  optionCounts.push(comp.options.length);

  assert.ok(comp.options.length > 0,
    `turn ${turn}: no options available; the constraint query produced an empty fringe`);

  // Pick the first option and append a resolution row, mirroring what
  // web-v2's handleClick does: ^ is <activeTerm> <optionTerm>.
  const option = comp.options[0]!;
  const roots = [...comp.activeTerms, ...option];
  const { bindings, results } = compressRefs(roots, store);
  const N = comp.activeTerms.length;
  const lines: string[] = [...bindings];
  for (let i = 0; i < N; i++) {
    lines.push(`^ is ${results[i]} ${results[i + N]}`);
  }
  source = source + "\n\n" + lines.map((l, i) => (i === 0 ? l : "  " + l)).join("\n") + "\n";
}

assert.deepEqual(optionCounts, [9, 8, 7],
  `expected eligible-option counts of [9, 8, 7] across turns, got [${optionCounts.join(", ")}]`);

console.log("PASS: ttt eligibility decreases 9 → 8 → 7 across turns");
console.log("ALL v2 ttt tests passed");

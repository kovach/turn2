// v3 in the web editor (src/v3/bridge.ts): saved `--@` answers replay, a
// misfit stops the replay, a click's answer line round-trips, and the run is
// presented in v2's shapes (store tuples, components, accAt).

import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parse } from "../v2/parse.js";
import { tokenOf } from "../v2/store.js";
import { runV3, parseAnswers } from "../v3/bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
// without any answers the editor saved into the file
const base = readFileSync(resolve(here, "../../data/v3/ttt-v3.t"), "utf8")
  .split("\n").filter((l) => !l.startsWith("--@") && !l.startsWith("-- answers:")).join("\n");

function run(src: string) {
  const p = parse(src);
  if ("message" in p) throw new Error(p.message);
  return runV3(p, src);
}

// play three moves through answerText, as clicks would
let src = base;
for (let i = 0; i < 3; i++) {
  const r = run(src);
  assert.equal(r.status.kind, "active-choices");
  if (r.status.kind !== "active-choices") break;
  const c = r.status.components[0]!;
  const line = r.answerText(c.activeTerms, c.options[0]!);
  assert.ok(line !== null && line.startsWith("--@ C@"), `answer line: ${line}`);
  src += `\n${line}`;
}
{
  const r = run(src);
  assert.equal(r.replayed, 3);
  assert.equal(r.unused.length, 0);
  assert.equal(parseAnswers(src).length, 3);
  if (r.status.kind !== "active-choices") throw new Error("expected choices");
  assert.equal(r.status.components[0]!.options.length, 6, "three cells taken");
  // the store holds v3's tuples, with spans for source links
  const filled = r.store.byHead.get("filled") ?? [];
  assert.equal(filled.length, 3);
  assert.ok(r.store.tupleSource[filled[0]!] !== undefined);
  // accAt answers at the pending choice's moment
  const rows = r.accAt(tokenOf(r.store, r.status.components[0]!.moment), ["taken"]);
  assert.equal(rows?.get("taken")?.length, 3);
}
{
  // a misfit: the 2nd answer names a taken cell; replay stops there
  const lines = src.split("\n");
  const answers = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("--@"));
  lines[answers[1]![1]] = answers[0]![0];
  const r = run(lines.join("\n"));
  assert.equal(r.replayed, 1);
  assert.equal(r.unused.length, 2);
  assert.equal(r.unused[0]!.line, answers[1]![1] + 1);
}
console.log("PASS: v3 editor answers replay, misfits stop replay, store/accAt presented");

// a whole Spirit Island game through the bridge, timed
{
  const si = readFileSync(resolve(here, "../../../si/game/si-game.t"), "utf8");
  let s = si.slice(0, si.indexOf("\n= V1 (*chain)")).replace("-- display: si-display.js\n", "-- display: si-display.js\n-- engine: v3\n");
  let n = 0;
  for (;;) {
    const r = run(s);
    if (r.status.kind !== "active-choices") break;
    const c = r.status.components[0]!;
    s += `\n${r.answerText(c.activeTerms, c.options[0]!)}`;
    if (++n > 200) throw new Error("runaway");
  }
  const t0 = performance.now();
  const r = run(s);
  const ms = performance.now() - t0;
  assert.equal(r.replayed, n);
  assert.equal(r.status.kind, "done");
  console.log(`PASS: si-game played through the bridge (${n} answers); a full rerun takes ${ms.toFixed(0)} ms, ${r.store.tuples.length} store tuples`);
}
console.log("ALL v3 bridge tests passed");

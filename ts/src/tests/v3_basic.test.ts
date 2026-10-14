// v3 (plans/v3-procedural.md): the moment order, single-program behavior,
// the procedural rewrites, and lockstep agreement with v2 on small programs.

import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parse } from "../v2/parse.js";
import { MomentOrder, type Moment } from "../v3/moments.js";
import { Runtime } from "../v3/runtime.js";
import { report } from "../v3/analyze.js";
import { diffRun } from "../v3/diff.js";

const here = dirname(fileURLToPath(import.meta.url));
const data = (p: string) => readFileSync(resolve(here, "../../data", p), "utf8");

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- moments
// Grow random histories the way the runtime does (subdivide a window; an
// episode is l < r inside it; continue inside, after, or at a fresh fact)
// and check `le` against reachability over the pred/succ edges.
{
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed);
    const mo = new MomentOrder();
    const edges = new Map<Moment, Moment[]>();
    const edge = (a: Moment, b: Moment) => { if (!edges.has(a)) edges.set(a, []); edges.get(a)!.push(b); };
    const windows: [Moment, Moment][] = [[mo.bot, mo.top]];
    for (let i = 0; i < 300; i++) {
      const [xl, xr] = windows[Math.floor(r() * windows.length)]!;
      const l = mo.fresh(xl, xr)!;
      edge(xl, l);
      edge(l, xr);
      if (r() < 0.5) {
        windows.push([l, xr]);
      } else {
        const e = mo.fresh(l, xr)!;
        edge(l, e);
        edge(e, xr);
        windows.push([l, e], [e, xr]);
      }
    }
    const reach = (a: Moment, b: Moment): boolean => {
      if (a === b || a === mo.bot || b === mo.top) return true;
      const seen = new Set<Moment>([a]);
      const st = [a];
      while (st.length > 0) {
        const x = st.pop()!;
        for (const y of edges.get(x) ?? []) {
          if (y === b) return true;
          if (!seen.has(y)) { seen.add(y); st.push(y); }
        }
      }
      return false;
    };
    const ms = mo.all;
    for (let k = 0; k < 2000; k++) {
      const a = ms[Math.floor(r() * ms.length)]!;
      const b = ms[Math.floor(r() * ms.length)]!;
      assert.equal(mo.le(a, b), reach(a, b), `seed ${seed}: le(${a.id}, ${b.id})`);
    }
  }
  console.log("PASS: moment order matches reachability on random histories");
}

// ---------------------------------------------------------------- ttt
{
  const p = parse(data("v2/ttt.t"));
  if ("message" in p) throw new Error(p.message);
  const rt = new Runtime(p);
  const counts: number[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const s = rt.run();
    assert.equal(s.kind, "choices");
    if (s.kind !== "choices") break;
    counts.push(s.components[0]!.options.length);
    rt.answer(s.components[0]!, s.components[0]!.options[0]!);
  }
  assert.deepEqual(counts, [9, 8, 7]);
  console.log("PASS: ttt offers 9, 8, 7 cells, resuming in place");
}

// ---------------------------------------------------------------- rewrites
for (const f of ["v3/ttt.t", "v3/wolf-sheep.t"]) {
  const p = parse(data(f));
  if ("message" in p) throw new Error(p.message);
  const rt = new Runtime(p);
  const subs = report(p, rt.an).flatMap((r) => r.kinds).filter((k) => k.kind === "subscribe");
  assert.equal(subs.length, 0, `${f}: subscribing matches ${JSON.stringify(subs)}`);
}
{
  const p = parse(data("v3/ttt.t"));
  if ("message" in p) throw new Error(p.message);
  const rt = new Runtime(p);
  let s = rt.run();
  while (s.kind === "choices") {
    rt.answer(s.components[0]!, s.components[0]!.options[0]!);
    s = rt.run();
  }
  assert.equal(s.kind, "done");
  const winner = rt.acc.rowsAt("winner", rt.mom.top).map((r) => rt.terms.show(r.args[0]!));
  assert.deepEqual(winner, ["o"]);
  console.log("PASS: procedural rewrites have no subscriptions; ttt plays to a winner");
}

// ---------------------------------------------------------------- v2 agreement
for (const [f, steps] of [
  ["v2/ttt.t", 12], ["v2/pins.t", 8], ["v2/dominion.t", 8], ["v2/dessert.t", 4],
  ["v2/exceptions.t", 4], ["v2/caret-exception.t", 4], ["v2/choice-test.t", 10], ["v2/dungeon.t", 10],
  ["v2/spirit-island.t", 10], ["v3/ttt.t", 12], ["v3/wolf-sheep.t", 6],
] as const) {
  for (const seed of [1, 2]) {
    const r = diffRun(data(f), { steps, pick: "random", seed });
    assert.ok(r.ok, `${f} seed ${seed}: ${r.mismatches.join("\n")}`);
  }
}
{
  // the Spirit Island game (si/, a sibling of ts/)
  const r = diffRun(readFileSync(resolve(here, "../../../si/game/si-game.t"), "utf8"), { steps: 12, pick: "random", seed: 3 });
  assert.ok(r.ok, `si-game: ${r.mismatches.join("\n")}`);
}
console.log("PASS: v3 agrees with v2 (facts, acc rows at each choice, options) on the sample programs");
console.log("ALL v3 tests passed");

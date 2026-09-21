// Display-side views of `#acc` rows (plans/v2-acc-timeline-display.md):
// merged bars, read markers, per-relation visibility, the moment inspector.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { addOrder, addTuple, createStore, intern, tokenOf, type Store } from "../v2/store.js";
import type { Term } from "../v2/term.js";
import { renderAtom } from "../v2/print.js";
import { accRuns, accSnapshot, isAccRow, type AccRun } from "../v2/acc-view.js";
import { layoutTimeline, renderTimeline, DEFAULT_OPTS } from "../v2/timeline.js";
import { momentKey } from "../v2/render-output.js";

function run(src: string, random?: () => number): Store {
  const p = parse(src);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return runFixpoint(p, 200, 5000, random === undefined ? undefined : { random }).store;
}

const label = (store: Store, r: AccRun): string => renderAtom(store, store.tuples[r.tupleIndex]!.atom);

// Left endpoint of the (first) episode with this head.
function startOf(store: Store, head: string): number {
  const t = store.tuples.find((x) => {
    const h = x.atom.terms[0];
    return h?.tag === "Symbol" && h.name === head;
  });
  assert.ok(t !== undefined, `no '${head}' tuple`);
  return tokenOf(store, t.l);
}

const OCC = `
#acc at : e (@last location)
#acc occupancy : location @count
#acc crowded : location

move A B / at A B
at _ X / occupancy X ()
occupancy X (s (s _)) / crowded X

~game
  ~a; ~b; ~c

a, +move me here
a, +move you here
b, +move me there

c, at X L, ^pos X L
c, occupancy L N, ^occ L N
c, crowded L, ^crowded-c L
`;

// ===== 1) Merged bars ========================================================
{
  const store = run(OCC);
  const runs = accRuns(store);
  const rows = store.tuples.filter((_, i) => isAccRow(store, i)).length;
  assert.ok(runs.length < rows / 2, `merging must shrink the display: ${runs.length} bars for ${rows} rows`);
  // Every stored acc row is covered by exactly one bar.
  const covered = runs.reduce((n, r) => n + r.moments.length, 0);
  assert.equal(covered, rows, "each row belongs to exactly one bar");

  const of = (l: string): AccRun[] => runs.filter((r) => label(store, r) === l);
  // A value that changes: `at me here` ends — closed — where `at me there`
  // starts.
  const here = of("at me here"), there = of("at me there");
  assert.equal(here.length, 1);
  assert.equal(there.length, 1);
  assert.equal(here[0]!.open, false, "a superseded value ends with a closed edge");
  assert.equal(here[0]!.rTok, there[0]!.lTok, "the old value's bar ends where the new one starts");
  // A value that holds to the end runs, open, to `top`.
  assert.equal(there[0]!.rTok, store.topTok);
  assert.equal(there[0]!.open, true);
  assert.equal(of("at you here").length, 1);
  // `crowded here` holds between the second arrival and the departure.
  const crowded = of("crowded here");
  assert.equal(crowded.length, 1);
  assert.equal(crowded[0]!.open, false);
  assert.equal(crowded[0]!.rTok, there[0]!.lTok);
  console.log("PASS: acc rows merge into one bar per stretch a value holds");

  // ===== 2) Read markers =====================================================
  const cStart = startOf(store, "c");
  for (const rel of ["at", "occupancy", "crowded"]) {
    assert.deepEqual([...(store.accConsulted.get(rel) ?? [])], [cStart], `${rel} is read at c's start only`);
  }
  assert.deepEqual(there[0]!.consulted, [cStart]);
  assert.deepEqual(here[0]!.consulted, [], "a bar that ended before the read carries no marker");
  // The failed read is recorded too: `crowded` is consulted at c's start
  // although no row matches there.
  assert.ok(!crowded[0]!.moments.includes(cStart));
  console.log("PASS: reads are recorded per relation and moment, matched or not");

  // ===== 3) Layout ===========================================================
  for (const laneMode of ["tree", "nested", "compact"] as const) {
    const L = layoutTimeline(store, { ...DEFAULT_OPTS, laneMode, momentStyle: "edges" }, (t) => t.length * 7);
    assert.ok(L.bars.every((b) => b.lTok !== b.rTok), `${laneMode}: no acc row is drawn as a point`);
    const acc = L.bars.filter((b) => b.acc !== undefined);
    const plain = L.bars.filter((b) => b.acc === undefined);
    assert.equal(acc.length, runs.length);
    const top = Math.max(...plain.map((b) => b.lane));
    assert.ok(acc.every((b) => b.lane > top), `${laneMode}: acc bars sit in a band above the episodes`);
    // A key's successive values share a lane (a track).
    const lane = (l: string): number => acc.find((b) => b.label === l)!.lane;
    assert.equal(lane("at me here"), lane("at me there"), `${laneMode}: at me's values share a lane`);
    // Relations do not interleave: each owns a contiguous run of lanes.
    const byRel = new Map<string, number[]>();
    for (const b of acc) byRel.set(b.acc!.relation, [...(byRel.get(b.acc!.relation) ?? []), b.lane]);
    const spans = [...byRel.values()].map((ls) => [Math.min(...ls), Math.max(...ls)] as const).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < spans.length; i++) {
      assert.ok(spans[i - 1]![1] < spans[i]![0], `${laneMode}: relation lane bands overlap`);
    }
    // Moment dots prefer episode edges.
    for (const [tok, a] of L.momentAnchor) {
      if (a === null || L.bars[a.barIndex]!.acc === undefined) continue;
      const onEpisode = plain.some((b) => b.lTok === tok || b.rTok === tok);
      assert.ok(!onEpisode, `${laneMode}: a moment with an episode edge must not anchor on an acc bar`);
    }
  }
  console.log("PASS: merged bars pack into per-relation lane bands above the episodes");

  // ===== 4) Per-relation visibility ==========================================
  const hideAt = layoutTimeline(store, { ...DEFAULT_OPTS, accOverrides: new Map([["at", false]]) }, () => 0);
  assert.ok(hideAt.bars.every((b) => b.acc?.relation !== "at"));
  assert.ok(hideAt.bars.some((b) => b.acc?.relation === "occupancy"));
  assert.ok(hideAt.bars.every((b) => b.lTok !== b.rTok), "a hidden relation's rows do not fall back to points");
  console.log("PASS: an override hides a relation");

  // ===== 5) Moment inspector =================================================
  const moved = there[0]!.lTok; // the moment `at me there` first holds
  const snap = accSnapshot(store, moved);
  assert.equal(snap.resolved, true);
  const at = snap.relations.find((r) => r.relation === "at")!;
  assert.deepEqual(at.rows.map((r) => [r.label, r.status]), [["at me there", "new"], ["at you here", "same"]]);
  assert.deepEqual(at.gone, ["at me here"]);
  assert.equal(at.consulted, false);
  const crowdedSnap = snap.relations.find((r) => r.relation === "crowded")!;
  assert.deepEqual(crowdedSnap.rows, []);
  assert.deepEqual(crowdedSnap.gone, ["crowded here"]);
  const atC = accSnapshot(store, cStart);
  assert.ok(atC.relations.every((r) => r.consulted), "every relation is read at c's start");
  assert.ok(atC.relations.every((r) => r.rows.every((x) => x.status === "same") && r.gone.length === 0));
  assert.equal(accSnapshot(store, store.topTok).resolved, false);
  // A moment's key survives re-evaluation with an unrelated edit.
  const store2 = run(OCC + "\n^unrelated x\n");
  const key = momentKey(store, moved);
  assert.ok(key !== null);
  const again = [...store2.momentTerms.keys()].filter((t) => momentKey(store2, t) === key);
  assert.equal(again.length, 1, "the inspected moment is found again by key");
  assert.deepEqual(
    accSnapshot(store2, again[0]!).relations.find((r) => r.relation === "at")!.gone,
    ["at me here"],
  );
  console.log("PASS: the moment inspector diffs a moment against its predecessors");
}

// ===== 6) Static default: pure intermediates start hidden ====================
{
  const store = run(`
#acc n : @count
#acc many : kind

item _ / n ()
n (s (s _)) / many items

^item a
^item b

many K, ^plenty K
`);
  assert.equal(store.accRelations.get("n")!.readByRules, false);
  assert.equal(store.accRelations.get("many")!.readByRules, true);
  const dflt = layoutTimeline(store, DEFAULT_OPTS, () => 0);
  assert.deepEqual([...new Set(dflt.bars.flatMap((b) => (b.acc ? [b.acc.relation] : [])))], ["many"]);
  const forced = layoutTimeline(store, { ...DEFAULT_OPTS, accOverrides: new Map([["n", true]]) }, () => 0);
  assert.ok(forced.bars.some((b) => b.acc?.relation === "n"));
  // Hidden from the timeline, still in the inspector.
  assert.ok(accSnapshot(store, store.botTok).relations.some((r) => r.relation === "n" && r.rows.length > 0));
  console.log("PASS: a relation only acc rules read is hidden by default");
}

// ===== 7) Open end behind a pending choice ===================================
{
  const store = run(`
#acc n : @count

opt _ / n ()

~game
  ~pick;
  ~after

pick, ^opt x, ^opt y

pick, ? C, ~choice C, !opt C

after, n N, +seen N
`);
  const after = startOf(store, "after");
  assert.ok(!store.resolved.has(after));
  const runs = accRuns(store);
  const last = runs.filter((r) => r.open);
  assert.ok(last.length > 0, "the value held when the walk stopped has an open bar");
  for (const r of last) {
    assert.ok(!store.resolved.has(r.rTok), "an open bar ends at an unresolved moment");
    assert.notEqual(r.rTok, store.topTok, "…the first one, not top");
  }
  assert.ok(runs.every((r) => r.moments.every((m) => store.resolved.has(m))));
  console.log("PASS: a bar stops, open, at the first unresolved moment");
}

// ===== 8) Branching order: fork and join =====================================
{
  // m < a < j, m < b < j, j < z. `v x` holds at m, a, b, j and not at z;
  // `v y` holds at a only.
  const s = createStore();
  const sym = (name: string): Term => ({ tag: "Symbol", name });
  const [m, a, b, j, z] = ["m", "a", "b", "j", "z"].map((n) => intern(s, sym(n))) as [Term, Term, Term, Term, Term];
  addOrder(s, m, a); addOrder(s, m, b); addOrder(s, a, j); addOrder(s, b, j); addOrder(s, j, z);
  addOrder(s, m, j); // a non-cover edge: must not let a chain skip a / b
  s.accRelations.set("v", { readByRules: true });
  const row = (val: string, at: Term): void => {
    addTuple(s, { terms: [sym("v"), sym(val), intern(s, { tag: "Id", atom: { terms: [sym("*acc"), sym(val), at] } })] }, at, at);
  };
  for (const at of [m, a, b, j]) row("x", at);
  row("y", a);
  for (const t of [s.bot, m, a, b, j, z]) s.resolved.add(tokenOf(s, t));
  const T = (t: Term): number => tokenOf(s, t);
  const runs = accRuns(s);
  const x = runs.filter((r) => label(s, r) === "v x");
  assert.equal(x.length, 2, "one bar per branch");
  const main = x.find((r) => r.moments.length === 3)!;
  const side = x.find((r) => r.moments.length === 1)!;
  assert.deepEqual([main.lTok, main.rTok, main.open], [T(m), T(z), false]);
  assert.equal(side.lTok, T(m), "the second branch's bar starts at the fork");
  assert.equal(side.rTok, T(j), "…and ends at the join");
  assert.equal(side.open, false);
  const y = runs.filter((r) => label(s, r) === "v y");
  assert.deepEqual(y.map((r) => [r.lTok, r.rTok, r.open]), [[T(a), T(j), false]]);
  // x is new at m (bot lacks it) and the same at j; y is gone at j.
  const atJ = accSnapshot(s, T(j)).relations[0]!;
  assert.deepEqual(atJ.rows.map((r) => [r.label, r.status]), [["v x", "same"]]);
  assert.deepEqual(atJ.gone, ["v y"]);
  console.log("PASS: a value held along two branches gets a bar per branch");
}

// ===== 9) SVG smoke test (stub DOM) ==========================================
{
  // No DOM in node; a minimal stand-in is enough to run `renderTimeline` and
  // look at what it drew.
  interface Node_ { tag: string; attrs: Map<string, string>; classes: Set<string>; children: Node_[]; textContent: string }
  const make = (tag: string): Node_ & Record<string, unknown> => {
    const n: Node_ & Record<string, unknown> = {
      tag, attrs: new Map(), classes: new Set(), children: [], textContent: "",
      style: {},
      setAttribute(k: string, v: string) { n.attrs.set(k, v); },
      getAttribute(k: string) { return n.attrs.get(k) ?? null; },
      appendChild(c: Node_) { n.children.push(c); return c; },
      classList: { add: (...cs: string[]) => cs.forEach((c) => n.classes.add(c)) },
    };
    return n;
  };
  const g = globalThis as Record<string, unknown>;
  const saved = g.document;
  g.document = {
    createElementNS: (_ns: string, tag: string) => make(tag),
    createElement: (tag: string) => tag === "canvas"
      ? { getContext: () => ({ font: "", measureText: (t: string) => ({ width: t.length * 7 }) }) }
      : make(tag),
  };
  try {
    const store = run(OCC);
    const svg = renderTimeline(store, { momentStyle: "edges" }).main as unknown as Node_;
    const accBars = svg.children.filter((c) => c.classes.has("tl-bar-acc"));
    assert.equal(accBars.length, accRuns(store).length);
    assert.ok(accBars.every((c) => c.attrs.get("rx") === "0"));
    const open = accBars.filter((c) => c.classes.has("tl-bar-acc-open"));
    assert.ok(open.length > 0 && open.length < accBars.length);
    for (const c of open) {
      const dash = c.attrs.get("stroke-dasharray")!.split(",").map(Number);
      assert.equal(dash[0], Number(c.attrs.get("width")), "the top edge is solid");
      assert.ok(dash.length % 2 === 0 || dash.length > 3);
    }
    const marks = svg.children.filter((c) => c.classes.has("tl-acc-read"));
    const expected = accRuns(store).reduce((n, r) => n + r.consulted.length, 0);
    assert.equal(marks.length, expected);
    assert.ok(svg.children.some((c) => c.attrs.has("data-tl-moment")));
    const sel = renderTimeline(store, { momentStyle: "edges", selectedMoment: startOf(store, "c") }).main as unknown as Node_;
    assert.equal(sel.children.filter((c) => c.classes.has("tl-moment-selected")).length, 1);
  } finally {
    g.document = saved;
  }
  console.log("PASS: renderTimeline draws acc bars, open edges, read markers, moment hits");
}

console.log("ALL v2 acc-view tests passed");

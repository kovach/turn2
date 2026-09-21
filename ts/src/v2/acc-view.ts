// Display-side views of `#acc` rows (plans/v2-acc-timeline-display.md).
// DOM-free; consumed by timeline.ts (merged bars, read markers) and
// render-output.ts (the moment inspector).
//
// The engine writes every acc relation's rows as point tuples at every
// resolved moment (acc.ts), so a value that holds for a while is stored once
// per moment. Nothing here changes that; these functions only fold the
// repetition back up for display:
//
//  - `accRuns` merges each distinct row content into bars: one bar per
//    maximal chain of moments at which the content holds, running from the
//    first such moment to the moment at which it stops holding.
//  - `accSnapshot` is the full acc state at one moment, diffed against the
//    moment's immediate predecessors.
//
// Both read `store.accRelations` / `store.accConsulted` (store.ts), which
// `runFixpoint` and `evalMatch` maintain.

import type { Term } from "./term.js";
import { lessThan, tokenOf, type Store } from "./store.js";
import { renderAtom, userTerms } from "./print.js";

// One merged bar: a row content holding along a chain of moments.
export interface AccRun {
  relation: string;
  // The stored row at the chain's first moment: label text and click target.
  tupleIndex: number;
  // Bar extent. `lTok` is the chain's first moment — or, when the chain
  // forks off another bar of the same content, the fork moment (the content
  // already held there). `rTok` is where the chain stops: the moment at
  // which the content no longer holds, the moment it merges into another bar
  // of the same content, or — `open` — the first moment past the chain that
  // is not resolved (`top` when the chain's last moment is maximal).
  lTok: number;
  rTok: number;
  lTerm: Term;
  rTerm: Term;
  open: boolean;
  // Moments at which the content holds, in walk order.
  moments: number[];
  // The subset of `moments` at which an ordinary rule read the relation.
  consulted: number[];
}

// True iff the relation is drawn: a per-relation override wins, otherwise a
// relation shows iff some ordinary rule reads it (pure intermediates — acc
// relations only other acc rules read — start hidden).
export function accRelationVisible(
  store: Store,
  relation: string,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  const forced = overrides.get(relation);
  if (forced !== undefined) return forced;
  return store.accRelations.get(relation)?.readByRules ?? true;
}

// True iff tuple `i` is a stored acc row (a point tuple of an acc relation).
export function isAccRow(store: Store, i: number): boolean {
  if (store.accRelations.size === 0) return false;
  const t = store.tuples[i]!;
  const h = t.atom.terms[0];
  if (h === undefined || h.tag !== "Symbol" || !store.accRelations.has(h.name)) return false;
  return tokenOf(store, t.l) === tokenOf(store, t.r);
}

// --- The cover relation over the store's moments -----------------------------

interface Covers {
  succ: Map<number, number[]>;
  pred: Map<number, number[]>;
  // A linear extension of the order, `bot` first; `top` is not a member.
  topo: number[];
  topoIndex: Map<number, number>;
}

// Hasse covers of the asserted moment order, `bot` included (it covers into
// every moment without an asserted predecessor) and `top` excluded. Asserted
// edges are not transitively reduced, so an edge `u → v` is dropped when
// another asserted successor of `u` lies strictly below `v`. The asserted
// order can contain cycles (moment-walk.ts `frontier`); mutually reachable
// moments never drop each other's edges, and the Kahn pass appends whatever
// a cycle strands in token order.
function momentCovers(store: Store): Covers {
  const toks: number[] = [];
  for (const tok of store.momentTerms.keys()) if (tok !== store.topTok) toks.push(tok);
  toks.sort((a, b) => a - b);
  const term = (tok: number): Term => store.momentTerms.get(tok)!;
  const succ = new Map<number, number[]>();
  const pred = new Map<number, number[]>();
  for (const tok of toks) { succ.set(tok, []); pred.set(tok, []); }
  const link = (u: number, v: number): void => { succ.get(u)!.push(v); pred.get(v)!.push(u); };
  for (const u of toks) {
    if (u === store.botTok) {
      for (const v of toks) {
        if (v === store.botTok) continue;
        const ps = store.orderBwd.get(v);
        if (ps === undefined || ps.size === 0) link(u, v);
      }
      continue;
    }
    const out = store.orderFwd.get(u);
    if (out === undefined) continue;
    const vs = [...out].filter((v) => succ.has(v)).sort((a, b) => a - b);
    for (const v of vs) {
      const redundant = vs.some((w) =>
        w !== v && lessThan(store, term(w), term(v)) && !lessThan(store, term(v), term(w)));
      if (!redundant) link(u, v);
    }
  }
  const indeg = new Map<number, number>();
  for (const tok of toks) indeg.set(tok, pred.get(tok)!.length);
  const topo: number[] = [];
  const queue = toks.filter((t) => indeg.get(t) === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi]!;
    topo.push(u);
    for (const v of succ.get(u)!) {
      const left = indeg.get(v)! - 1;
      indeg.set(v, left);
      if (left === 0) queue.push(v);
    }
  }
  if (topo.length < toks.length) {
    const placed = new Set(topo);
    for (const t of toks) if (!placed.has(t)) topo.push(t);
  }
  const topoIndex = new Map<number, number>();
  topo.forEach((t, i) => topoIndex.set(t, i));
  return { succ, pred, topo, topoIndex };
}

// Row content → (moment token → tuple index), per acc relation. The content
// key is the row's user terms (the trailing id names the moment, so it
// differs at every moment and is left out).
function accRowsByContent(store: Store): Map<string, { relation: string; at: Map<number, number> }> {
  const out = new Map<string, { relation: string; at: Map<number, number> }>();
  for (const relation of store.accRelations.keys()) {
    for (const i of store.byHead.get(relation) ?? []) {
      if (!isAccRow(store, i)) continue;
      const t = store.tuples[i]!;
      const key = userTerms(t.atom).map((x) => tokenOf(store, x)).join(",");
      let entry = out.get(key);
      if (entry === undefined) { entry = { relation, at: new Map() }; out.set(key, entry); }
      entry.at.set(tokenOf(store, t.l), i);
    }
  }
  return out;
}

// Merge every acc relation's point rows into bars.
//
// Per content, the moments at which it holds are covered greedily by chains,
// walking a linear extension of the moment order: a moment extends a chain
// whose last moment it covers, and otherwise starts a new one. On a linear
// timeline that is one bar per stretch of time the content holds. Where the
// order branches, a content that holds along two branches gets a bar per
// branch — the second starting at the fork moment, and a branch that rejoins
// ending at the join. A bar is an over-approximation in one way: it runs
// through every column between its endpoints, including moments on a side
// branch where the content does not hold — the same ambiguity any episode
// bar has against moments incomparable to it.
export function accRuns(store: Store): AccRun[] {
  const contents = accRowsByContent(store);
  if (contents.size === 0) return [];
  const cov = momentCovers(store);
  const byTopo = (a: number, b: number): number => cov.topoIndex.get(a)! - cov.topoIndex.get(b)!;
  const runs: AccRun[] = [];
  for (const { relation, at } of contents.values()) {
    const consultedAt = store.accConsulted.get(relation);
    type Chain = { lTok: number; moments: number[] };
    const chainOf = new Map<number, Chain>();
    const chains: Chain[] = [];
    const held = [...at.keys()].filter((m) => cov.topoIndex.has(m)).sort(byTopo);
    for (const m of held) {
      const preds = cov.pred.get(m)!.filter((p) => chainOf.has(p)).sort(byTopo);
      const ext = preds.find((p) => {
        const c = chainOf.get(p)!;
        return c.moments[c.moments.length - 1] === p;
      });
      let chain: Chain;
      if (ext !== undefined) {
        chain = chainOf.get(ext)!;
        chain.moments.push(m);
      } else {
        chain = { lTok: preds[0] ?? m, moments: [m] };
        chains.push(chain);
      }
      chainOf.set(m, chain);
    }
    for (const chain of chains) {
      const tail = chain.moments[chain.moments.length - 1]!;
      const next = cov.succ.get(tail)!.slice().sort(byTopo);
      const merge = next.find((n) => at.has(n));
      const ended = next.find((n) => store.resolved.has(n));
      let rTok: number;
      let open = false;
      if (merge !== undefined) rTok = merge;
      else if (ended !== undefined) rTok = ended;
      else { rTok = next[0] ?? store.topTok; open = true; }
      runs.push({
        relation,
        tupleIndex: at.get(chain.moments[0]!)!,
        lTok: chain.lTok,
        rTok,
        lTerm: store.momentTerms.get(chain.lTok)!,
        rTerm: store.momentTerms.get(rTok)!,
        open,
        moments: chain.moments,
        consulted: consultedAt === undefined ? [] : chain.moments.filter((m) => consultedAt.has(m)),
      });
    }
  }
  runs.sort((a, b) =>
    a.relation.localeCompare(b.relation) || byTopo(a.lTok, b.lTok) || (a.tupleIndex - b.tupleIndex));
  return runs;
}

// --- Moment inspector ---------------------------------------------------------

export interface AccSnapshotRow {
  tupleIndex: number;
  label: string;
  // "new": some immediate predecessor of the moment lacks this row.
  status: "same" | "new";
}

export interface AccSnapshotRelation {
  relation: string;
  readByRules: boolean;
  // An ordinary rule read this relation at this moment.
  consulted: boolean;
  rows: AccSnapshotRow[];
  // Rows some immediate predecessor has and this moment lacks.
  gone: string[];
}

export interface AccSnapshot {
  tok: number;
  // Acc rows exist only at resolved moments; an unresolved moment (a pending
  // choice at or below it, or `top`) has none yet.
  resolved: boolean;
  relations: AccSnapshotRelation[];
}

// Immediate predecessors of `tok`: its asserted predecessors minus any that
// lie strictly below another, or `bot` when it has none.
function coverPreds(store: Store, tok: number): number[] {
  if (tok === store.botTok) return [];
  const ps = [...(store.orderBwd.get(tok) ?? [])];
  if (ps.length === 0) return [store.botTok];
  const term = (t: number): Term => store.momentTerms.get(t)!;
  return ps.filter((p) => !ps.some((q) =>
    q !== p && lessThan(store, term(p), term(q)) && !lessThan(store, term(q), term(p))));
}

// The full acc state at one moment, every relation included (the inspector
// ignores the timeline's per-relation visibility).
export function accSnapshot(store: Store, tok: number): AccSnapshot {
  const preds = coverPreds(store, tok).filter((p) => store.resolved.has(p));
  const relations: AccSnapshotRelation[] = [];
  for (const [relation, info] of store.accRelations) {
    // content key → label / tuple index, per moment of interest.
    const here = new Map<string, { tupleIndex: number; label: string }>();
    const before = preds.map(() => new Map<string, string>());
    for (const i of store.byHead.get(relation) ?? []) {
      if (!isAccRow(store, i)) continue;
      const t = store.tuples[i]!;
      const at = tokenOf(store, t.l);
      const key = userTerms(t.atom).map((x) => tokenOf(store, x)).join(",");
      if (at === tok) here.set(key, { tupleIndex: i, label: renderAtom(store, t.atom) });
      const pi = preds.indexOf(at);
      if (pi >= 0) before[pi]!.set(key, renderAtom(store, t.atom));
    }
    const rows: AccSnapshotRow[] = [...here.entries()].map(([key, r]) => ({
      tupleIndex: r.tupleIndex,
      label: r.label,
      status: before.some((b) => !b.has(key)) ? "new" as const : "same" as const,
    }));
    rows.sort((a, b) => a.label.localeCompare(b.label));
    const gone = new Map<string, string>();
    for (const b of before) for (const [key, label] of b) if (!here.has(key)) gone.set(key, label);
    relations.push({
      relation,
      readByRules: info.readByRules,
      consulted: store.accConsulted.get(relation)?.has(tok) ?? false,
      rows,
      gone: [...gone.values()].sort(),
    });
  }
  return { tok, resolved: store.resolved.has(tok), relations };
}

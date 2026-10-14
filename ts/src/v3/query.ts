// Conjunctive queries evaluated at one moment `m` (point reads): the body of
// an `#acc` rule, and a choice component's `!(...)` constraints. A stored
// tuple takes part when it is alive at `m` (`l ≤ m ≤ r`), an acc relation
// contributes its rows at `m`, `not` succeeds when no row of an acc relation
// matches, js relations enumerate, and `=` unifies.

import type { Moment } from "./moments.js";
import { groundPat, matchArgs, matchPat, patSlots, UNBOUND, type Env, type Id, type Pat } from "./terms.js";

export type QAtom =
  | { k: "rel"; rel: string; pats: Pat[] }
  | { k: "acc"; rel: string; pats: Pat[] }
  | { k: "not"; rel: string; pats: Pat[] }
  | { k: "js"; rel: string; pats: Pat[] }
  | { k: "eq"; lhs: Pat; rhs: Pat };

export interface AccRow {
  args: Id[];
  moment: Moment;
  key: string; // identity: relation + args
}

export interface StoredTuple {
  args: Id[];
  l: Moment;
  r: Moment;
  seq: number;
}

export interface PointSource {
  // Stored tuples of `rel` alive at `m` that may match `pats` under `env`.
  alive(rel: string, pats: Pat[], env: Env, m: Moment): Iterable<StoredTuple>;
  rows(rel: string, m: Moment): readonly AccRow[];
  js(rel: string, args: (Id | null)[]): Iterable<Id[]>;
  ground(p: Pat, env: Env): Id | null;
  match(ps: readonly Pat[], ids: readonly Id[], env: Env): boolean;
  matchOne(p: Pat, id: Id, env: Env): boolean;
}

// Moments and identities of what a solution read (for acc contributions).
export interface Trace {
  moments: Moment[];
  ids: string[];
}

export type Solution = (env: Env, trace: Trace) => void;

// Solve `atoms` in the given order (acc bodies keep their written order, as
// v2 does) or, with `reorder`, picking at each step the most constrained
// atom (constraint queries, which mix stores and js freely).
export function solve(
  atoms: readonly QAtom[], env: Env, m: Moment, src: PointSource, cb: Solution, reorder = false,
): void {
  const go = (rest: readonly QAtom[], env: Env, trace: Trace): void => {
    if (rest.length === 0) {
      cb(env, trace);
      return;
    }
    const i = reorder ? pick(rest, env, src) : 0;
    const a = rest[i]!;
    const others = rest.length === 1 ? [] : [...rest.slice(0, i), ...rest.slice(i + 1)];
    switch (a.k) {
      case "rel":
        for (const t of src.alive(a.rel, a.pats, env, m)) {
          const e = env.slice();
          if (!src.match(a.pats, t.args, e)) continue;
          go(others, e, { moments: [...trace.moments, t.l], ids: [...trace.ids, `t${t.seq}`] });
        }
        return;
      case "acc":
        for (const row of src.rows(a.rel, m)) {
          const e = env.slice();
          if (!src.match(a.pats, row.args, e)) continue;
          go(others, e, { moments: [...trace.moments, row.moment], ids: [...trace.ids, row.key] });
        }
        return;
      case "not": {
        for (const row of src.rows(a.rel, m)) {
          const e = env.slice();
          if (src.match(a.pats, row.args, e)) return;
        }
        go(others, env, trace);
        return;
      }
      case "js": {
        const args = a.pats.map((p) => src.ground(p, env));
        for (const out of src.js(a.rel, args)) {
          const e = env.slice();
          if (!src.match(a.pats, out, e)) continue;
          go(others, e, trace);
        }
        return;
      }
      case "eq": {
        const e = env.slice();
        const r = src.ground(a.rhs, e);
        if (r !== null) {
          if (src.matchOne(a.lhs, r, e)) go(others, e, trace);
          return;
        }
        const l = src.ground(a.lhs, e);
        if (l === null) throw new Error("v3: '=' with both sides unbound");
        if (src.matchOne(a.rhs, l, e)) go(others, e, trace);
        return;
      }
    }
  };
  go(atoms, env, { moments: [], ids: [] });
}

function boundCount(pats: Pat[], env: Env, src: PointSource): number {
  let n = 0;
  for (const p of pats) if (src.ground(p, env) !== null) n++;
  return n;
}

function allBound(pats: Pat[], env: Env): boolean {
  for (const p of pats) for (const s of patSlots(p, new Set())) if (env[s] === UNBOUND) return false;
  return true;
}

function pick(rest: readonly QAtom[], env: Env, src: PointSource): number {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.k === "not" && allBound(a.pats, env)) return i;
    if (a.k === "eq" && (src.ground(a.lhs, env) !== null || src.ground(a.rhs, env) !== null)) return i;
  }
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.k !== "rel" && a.k !== "acc") continue;
    const s = boundCount(a.pats, env, src);
    if (s > bestScore) { best = i; bestScore = s; }
  }
  if (best >= 0) return best;
  for (let i = 0; i < rest.length; i++) if (rest[i]!.k === "js") return i;
  return 0; // a `not` or `=` with unbound variables: let it report
}

export { groundPat, matchArgs, matchPat };

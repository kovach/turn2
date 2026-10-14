// Static analysis of a parsed Turn program for v3 (plans/v3-procedural.md).
//
// The question per body match: can a matching tuple still be emitted, inside
// the rule's current scope, after the match runs? If not, a lookup of the
// tuples that exist is complete; if so, the match also subscribes.
//
// - A rule's *scope* at an atom is the frame whose end is the running
//   window's right end. Statically it is approximated by an episode relation
//   name (or ROOT), always an ancestor-or-self of the runtime scope; `exact`
//   records when it is the runtime scope.
// - The *spawn graph* has an edge S → E when some rule emits `~E` with
//   static scope S. Frames nest along its edges.
// - A tuple can overlap a window only if its emitter runs inside the
//   window's scope frame (moments.ts: a fresh moment is below a scope end
//   only via its own succ chain). So a match on R at scope S needs a
//   subscription iff some emit site of R may run inside S.

import type { Program, RuleAtom, Rule } from "../v2/types.js";
import type { Atom } from "../v2/term.js";

export const ROOT = "<root>";

type AtomNode = Extract<RuleAtom, { tag: "Atom" }>;

export type MatchKind =
  | "first" // the rule's first match: a root listener
  | "ancestor" // an enclosing episode (lookup only)
  | "lookup" // complete when it runs
  | "subscribe" // can still arrive inside the scope
  | "await" // `is`: waits for a choice's answer
  | "acc"
  | "not"
  | "js";

export interface MatchInfo {
  kind: MatchKind;
  subscribe: boolean;
  scope: string;
}

export interface EmitSite {
  rel: string;
  marker: string;
  scope: string;
  exact: boolean;
}

export interface Analysis {
  markers: Map<string, Set<string>>;
  episodes: Set<string>;
  acc: Set<string>;
  js: Set<string>;
  intercepted: Set<string>; // relations some exception intercepts
  spawn: Map<string, Set<string>>;
  emits: EmitSite[];
  matches: Map<AtomNode, MatchInfo>;
  reach(from: string): Set<string>;
}

export function headOf(a: Atom): string {
  const h = a.terms[0];
  return h !== undefined && h.tag === "Symbol" ? h.name : "?";
}

export function analyze(program: Program): Analysis {
  const markers = new Map<string, Set<string>>();
  const note = (rel: string, m: string) => {
    let s = markers.get(rel);
    if (s === undefined) markers.set(rel, (s = new Set()));
    s.add(m);
  };
  const intercepted = new Set<string>();
  const collect = (body: RuleAtom[]) => {
    for (const a of body) {
      if (a.tag === "Sub") collect(a.body);
      else if (a.tag === "Exception") {
        intercepted.add(headOf(a.left));
        collect(a.right);
      } else if (a.tag === "Atom" && a.marker !== "match" && a.marker !== "constrain" && a.marker !== "ask") {
        note(headOf(a.atom), a.marker);
      }
    }
  };
  for (const r of program.rules) collect(r.body);
  const acc = new Set(program.accDecls.keys());
  const js = new Set(program.jsRels.keys());
  const episodes = new Set<string>();
  for (const [rel, ms] of markers) if (ms.size === 1 && ms.has("episode")) episodes.add(rel);

  let spawn = new Map<string, Set<string>>();
  const reachCache = new Map<string, Set<string>>();
  const reach = (from: string): Set<string> => {
    let s = reachCache.get(from);
    if (s !== undefined) return s;
    s = new Set([from]);
    if (from === ROOT) {
      for (const e of episodes) s.add(e);
    } else {
      const st = [from];
      while (st.length > 0) {
        const x = st.pop()!;
        for (const y of spawn.get(x) ?? []) if (!s.has(y)) { s.add(y); st.push(y); }
      }
    }
    reachCache.set(from, s);
    return s;
  };

  let emits: EmitSite[] = [];
  let matches = new Map<AtomNode, MatchInfo>();

  // One pass over every rule. Scopes depend on the spawn graph (to tell an
  // ancestor match from a descendant one), which depends on scopes, so the
  // pass repeats until the graph is stable.
  const pass = () => {
    const nextSpawn = new Map<string, Set<string>>();
    const nextEmits: EmitSite[] = [];
    const nextMatches = new Map<AtomNode, MatchInfo>();
    type St = { scope: string; exact: boolean; first: boolean };

    const walk = (body: RuleAtom[], st: St): St => {
      for (const a of body) {
        if (a.tag === "Sub") {
          const inner = walk(a.body, { ...st });
          st = { ...st, first: inner.first };
          continue;
        }
        if (a.tag === "Exception") {
          const p = headOf(a.left);
          // the right-hand side runs on the intercepted tuple's interval
          const factOnly = markers.get(p)?.size === 1 && markers.get(p)!.has("fact");
          const sc: St = episodes.has(p) ? { scope: p, exact: true, first: false } : { scope: ROOT, exact: factOnly, first: false };
          walk(a.right, sc);
          continue;
        }
        if (a.tag !== "Atom") continue;
        const rel = headOf(a.atom);
        if (a.marker === "match") {
          let info: MatchInfo;
          if (acc.has(rel)) info = { kind: a.negated ? "not" : "acc", subscribe: false, scope: st.scope };
          else if (js.has(rel)) info = { kind: "js", subscribe: false, scope: st.scope };
          else if (rel === "is") info = { kind: "await", subscribe: true, scope: st.scope };
          else {
            const sub = mayArrive(rel, st);
            const anc = !sub && episodes.has(rel) && st.scope !== ROOT && reach(rel).has(st.scope);
            info = { kind: st.first ? "first" : sub ? "subscribe" : anc ? "ancestor" : "lookup", subscribe: sub, scope: st.scope };
            st = { ...st, first: false };
            if (!a.after && episodes.has(rel)) {
              // The window's end becomes min(XR, r_E): E's frame when E can
              // only be spawned below the current scope, the current scope
              // when E only encloses it, unknown otherwise.
              const down = st.scope === ROOT || reach(st.scope).has(rel);
              const up = st.scope !== ROOT && reach(rel).has(st.scope);
              if (st.scope === ROOT) st = { ...st, scope: rel, exact: true };
              else if (down && !up) st = { ...st, scope: rel };
              else if (!down && up) { /* an ancestor: scope unchanged */ }
              else st = { ...st, scope: ROOT, exact: false };
            } else if (!a.after && !(markers.get(rel)?.size === 1 && markers.get(rel)!.has("fact"))) {
              st = { ...st, exact: false }; // a view or a mixed relation may narrow to an unknown frame
            }
          }
          nextMatches.set(a, info);
          continue;
        }
        if (a.marker === "ask" || a.marker === "constrain") continue;
        nextEmits.push({ rel, marker: a.marker, scope: st.scope, exact: st.exact });
        st = { ...st, first: false };
        if (a.marker === "episode") {
          let s = nextSpawn.get(st.scope);
          if (s === undefined) nextSpawn.set(st.scope, (s = new Set()));
          s.add(rel);
          if (!a.after) st = { ...st, scope: rel, exact: true };
        }
      }
      return st;
    };

    const mayArrive = (rel: string, st: St): boolean => {
      for (const e of emits) {
        if (e.rel !== rel) continue;
        if (reach(st.scope).has(e.scope)) return true;
        if (!e.exact && reach(e.scope).has(st.scope)) return true;
      }
      return false;
    };

    for (const r of program.rules) walk(r.body, { scope: ROOT, exact: true, first: true });
    return { nextSpawn, nextEmits, nextMatches };
  };

  // Seed: every emit site at ROOT, inexact (everything may arrive anywhere).
  for (const [rel, ms] of markers) for (const m of ms) emits.push({ rel, marker: m, scope: ROOT, exact: false });
  for (let i = 0; i < 6; i++) {
    const { nextSpawn, nextEmits, nextMatches } = pass();
    const key = (m: Map<string, Set<string>>) => [...m].map(([k, v]) => `${k}>${[...v].sort().join(",")}`).sort().join(";");
    const stable = key(nextSpawn) === key(spawn) && JSON.stringify(nextEmits) === JSON.stringify(emits);
    spawn = nextSpawn;
    emits = nextEmits;
    matches = nextMatches;
    reachCache.clear();
    if (stable) break;
  }
  return { markers, episodes, acc, js, intercepted, spawn, emits, matches, reach };
}

// Per-rule summary: which matches are lookups and which subscribe.
export interface RuleReport {
  rule: Rule;
  kinds: { rel: string; kind: MatchKind }[];
  procedural: boolean;
}

export function report(program: Program, an: Analysis): RuleReport[] {
  const out: RuleReport[] = [];
  const visit = (body: RuleAtom[], kinds: { rel: string; kind: MatchKind }[]) => {
    for (const a of body) {
      if (a.tag === "Sub") visit(a.body, kinds);
      else if (a.tag === "Exception") visit(a.right, kinds);
      else if (a.tag === "Atom" && a.marker === "match") {
        const info = an.matches.get(a);
        if (info !== undefined) kinds.push({ rel: headOf(a.atom), kind: info.kind });
      }
    }
  };
  for (const r of program.rules) {
    const kinds: { rel: string; kind: MatchKind }[] = [];
    visit(r.body, kinds);
    out.push({ rule: r, kinds, procedural: !kinds.some((k) => k.kind === "subscribe") });
  }
  return out;
}

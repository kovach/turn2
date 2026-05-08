// v2 scheduler. Reads store contents at outer-loop quiescence to find
// blocked do-agg / choose rows; selects the earliest tier under the
// moment-order `prior` relation; closes earliest aggs by emitting
// `agg-result` rows. Knows nothing about rule continuations — paused work
// lives entirely in the store.

import type { Atom, Term } from "../types.js";
import { hashconsTerm, refTagOf } from "../hashcons.js";
import { getAggregator } from "../aggregators.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  comparable,
  intervalContains,
  lessEq,
  lessThan,
  tokenOf,
  type Store,
} from "./store.js";
import type { BlockedChoose } from "./types.js";

// A do-agg row whose matching agg-result row does not yet exist.
interface BlockedDoAgg {
  rowIndex: number;
  aggId: Term;
  aggIdTok: number;
  wrappedAtom: Atom;          // unwrapped from the third row term
  l: Term;
  r: Term;
}

type Blocked =
  | { kind: "agg"; row: BlockedDoAgg }
  | { kind: "choose"; row: BlockedChoose };

// Scan store for do-agg rows lacking matching agg-result rows.
export function collectBlockedDoAggs(store: Store): BlockedDoAgg[] {
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "agg-result")) {
    const t = store.tuples[idx]!;
    const idTerm = t.atom.terms[1];
    if (idTerm === undefined) continue;
    resolved.add(tokenOf(store, idTerm));
  }
  const out: BlockedDoAgg[] = [];
  for (const idx of candidatesByHead(store, "do-agg")) {
    const t = store.tuples[idx]!;
    const idTerm = t.atom.terms[1];
    const wrappedTerm = t.atom.terms[2];
    if (idTerm === undefined || wrappedTerm === undefined) continue;
    const idTok = tokenOf(store, idTerm);
    if (resolved.has(idTok)) continue;
    const wrappedAtom = unwrapAtom(wrappedTerm, store);
    if (wrappedAtom === null) continue;
    out.push({ rowIndex: idx, aggId: idTerm, aggIdTok: idTok, wrappedAtom, l: t.l, r: t.r });
  }
  return out;
}

// Scan store for choose rows whose wrapped atom contains at least one
// non-Symbol term lacking a matching `is <activeTerm> _` row.
export function collectBlockedChooses(store: Store): BlockedChoose[] {
  // Gather resolved active-term tokens from `is` rows.
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "is")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    if (T === undefined) continue;
    resolved.add(tokenOf(store, T));
  }
  const out: BlockedChoose[] = [];
  for (const idx of candidatesByHead(store, "choose")) {
    const t = store.tuples[idx]!;
    const chooseId = t.atom.terms[1];
    const wrappedTerm = t.atom.terms[2];
    if (chooseId === undefined || wrappedTerm === undefined) continue;
    const wrappedAtom = unwrapAtom(wrappedTerm, store);
    if (wrappedAtom === null) continue;
    const active: Term[] = [];
    collectActiveTerms(wrappedAtom, store, resolved, active);
    if (active.length > 0) {
      out.push({ rowIndex: idx, chooseId, wrappedAtom, activeTerms: active, l: t.l, r: t.r });
    }
  }
  return out;
}

function collectActiveTerms(atom: Atom, store: Store, resolved: Set<number>, out: Term[]): void {
  for (const term of atom.terms) {
    const t = term.tag === "Ref" ? expandRef(term, store) : term;
    if (t === null) continue;
    if (t.tag === "Symbol") continue;
    if (t.tag === "Variable" || t.tag === "Wildcard") continue; // shouldn't occur in stored rows
    if (t.tag === "Atom" || t.tag === "Id") {
      // A fresh-id term has head sym starting with `*id` or `*choose`. Treat
      // any compound atom term as a candidate active term: check resolution.
      const tok = tokenOf(store, term);
      if (!resolved.has(tok)) out.push(term);
      // Don't recurse — active terms are only at the top level of the
      // wrapped atom.
    }
  }
}

function unwrapAtom(term: Term, store: Store): Atom | null {
  let t: Term = term;
  if (t.tag === "Ref") {
    const a = store.hash.refToAtom.get(t.id);
    if (a === undefined) return null;
    return a;
  }
  if (t.tag === "Atom" || t.tag === "Id") return t.atom;
  return null;
}

function expandRef(term: Term, store: Store): Term | null {
  if (term.tag !== "Ref") return term;
  const a = store.hash.refToAtom.get(term.id);
  if (a === undefined) return null;
  // Preserve the Ref's backing tag so callers see Atom vs Id correctly.
  // (Ids are opaque per notes/v2-design.md — callers must not unfold them.)
  const tag = refTagOf(store.hash, term.id);
  return { tag, atom: a };
}

// `prior` over intervals: A.r ≤ B.l, OR B properly contains A.
function isPrior(store: Store, a: { l: Term; r: Term }, b: { l: Term; r: Term }): boolean {
  if (a.r === b.l || (lessEq(store, a.r, b.l) && comparable(store, a.r, b.l))) return true;
  // Proper containment: B contains A and B != A.
  if (intervalContains(store, b.l, b.r, a.l, a.r)) {
    if (a.l !== b.l || a.r !== b.r) return true;
  }
  return false;
}

// Earliest tier: prefix of prior-sorted list whose first element is prior to
// nothing else; include everything prior-incomparable to it.
export function selectEarliestTier(store: Store, items: Blocked[]): Blocked[] {
  if (items.length <= 1) return items.slice();
  const interval = (b: Blocked) => b.kind === "agg" ? b.row : b.row;
  const sorted = [...items].sort((x, y) => {
    if (isPrior(store, interval(x), interval(y))) return -1;
    if (isPrior(store, interval(y), interval(x))) return 1;
    return 0;
  });
  const first = sorted[0]!;
  const tier: Blocked[] = [first];
  const firstI = interval(first);
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (isPrior(store, firstI, interval(next))) break;
    tier.push(next);
  }
  return tier;
}

export function collectAllBlocked(store: Store): Blocked[] {
  const out: Blocked[] = [];
  for (const a of collectBlockedDoAggs(store)) out.push({ kind: "agg", row: a });
  for (const c of collectBlockedChooses(store)) out.push({ kind: "choose", row: c });
  return out;
}

// Close one do-agg row by computing its aggregate and emitting agg-result.
// Returns true if a result was emitted (count/sum always emit; last may emit
// 0+ rows depending on candidates).
export function closeDoAgg(
  store: Store,
  blocked: BlockedDoAgg,
  schema: Map<string, string>,
): boolean {
  const wrapped = blocked.wrappedAtom;
  const headTerm = wrapped.terms[0];
  if (headTerm === undefined || headTerm.tag !== "Symbol") return false;
  const aggName = schema.get(headTerm.name);
  if (aggName === undefined) {
    throw new Error(`weighted query '${headTerm.name}' has no schema declaration`);
  }
  const aggregator = getAggregator(aggName);

  // wrapped.terms layout: [headSym, k1, ..., kK, weight]. A position is
  // "free" iff its term is the reserved Symbol `_free`; bound positions
  // require equality with the candidate. Free key positions become group-by
  // dimensions; the free weight position (if any) just doesn't filter.
  const isFree = (t: Term): boolean =>
    t.tag === "Symbol" && t.name === "_free";
  const arity = wrapped.terms.length;
  if (arity < 2) return false;

  // Candidates: tuples with same head sym + arity, interval contains the
  // do-agg's interval, and bound positions equal pointwise.
  type Cand = { idx: number; terms: readonly Term[] };
  const candidates: Cand[] = [];
  for (const idx of candidatesByHead(store, headTerm.name)) {
    const t = store.tuples[idx]!;
    if (t.atom.terms.length !== arity) continue;
    if (!intervalContains(store, t.l, t.r, blocked.l, blocked.r)) continue;
    let ok = true;
    for (let i = 0; i < arity; i++) {
      if (isFree(wrapped.terms[i]!)) continue;
      if (!termsEqualByToken(store, wrapped.terms[i]!, t.atom.terms[i]!)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    candidates.push({ idx, terms: t.atom.terms });
  }

  // Group by free *key* positions (positions 1..arity-2). Key signature is
  // a `|`-joined string of hashcons tokens.
  const keyPositions: number[] = [];
  for (let i = 1; i < arity - 1; i++) if (isFree(wrapped.terms[i]!)) keyPositions.push(i);
  const groups = new Map<string, Cand[]>();
  for (const c of candidates) {
    const sig = keyPositions.map((p) => tokenOf(store, c.terms[p]!)).join("|");
    let bucket = groups.get(sig);
    if (bucket === undefined) { bucket = []; groups.set(sig, bucket); }
    bucket.push(c);
  }
  if (groups.size === 0) {
    // No contributions. count/sum still emit one row using their zero;
    // last fails (per spec, last on empty has no agg-result).
    if (aggName === "last") return false;
    return emitAggResultRow(store, blocked, wrapped, null, aggregator.zero);
  }

  let any = false;
  for (const group of groups.values()) {
    if (aggName === "last") {
      const maximal = group.filter((c) => {
        const ci = store.tuples[c.idx]!;
        for (const d of group) {
          if (d === c) continue;
          const di = store.tuples[d.idx]!;
          if (lessEq(store, ci.r, di.l) && comparable(store, ci.r, di.l)) return false;
        }
        return true;
      });
      for (const c of maximal) {
        if (emitAggResultRow(store, blocked, wrapped, c, c.terms[arity - 1]!)) any = true;
      }
      continue;
    }
    let acc = aggregator.zero;
    for (const c of group) {
      try { acc = aggregator.fold(acc, c.terms[arity - 1]!); } catch { /* skip */ }
    }
    if (emitAggResultRow(store, blocked, wrapped, group[0]!, acc)) any = true;
  }
  return any;
}

// Construct an agg-result row. Its 3rd term mirrors the wrapped pattern's
// shape: head + key positions + weight, where each free key position is
// replaced by the representative candidate's actual value at that index.
// `weight` is the aggregated value (sum/count) or candidate's weight (last).
function emitAggResultRow(
  store: Store,
  blocked: BlockedDoAgg,
  wrapped: Atom,
  rep: { terms: readonly Term[] } | null,
  weight: Term,
): boolean {
  const arity = wrapped.terms.length;
  const isFree = (t: Term): boolean =>
    t.tag === "Symbol" && t.name === "_free";
  const filledTerms: Term[] = [];
  for (let i = 0; i < arity - 1; i++) {
    const w = wrapped.terms[i]!;
    if (isFree(w)) {
      if (rep === null) {
        // No representative (empty count/sum group). Leave `_free` in place;
        // there should be no free-key positions in the empty case since we
        // only reach here when groups.size === 0 and there are no candidates
        // to drive groupby. Consumer pattern's free-var binds to `_free`.
        filledTerms.push(w);
      } else {
        filledTerms.push(rep.terms[i]!);
      }
    } else {
      filledTerms.push(w);
    }
  }
  filledTerms.push(weight);
  const inner: Term = { tag: "Atom", atom: { terms: filledTerms.map((t) => hashconsTerm(t, store.hash)) } };
  const internedInner = hashconsTerm(inner, store.hash);
  const sym: Term = { tag: "Symbol", name: "agg-result" };
  const atom: Atom = { terms: [sym, blocked.aggId, internedInner] };
  const inserted = addTuple(store, atom, blocked.l, blocked.r);
  if (inserted) {
    addOrder(store, blocked.l, blocked.r);
  }
  return inserted;
}

function termsEqualByToken(store: Store, a: Term, b: Term): boolean {
  return tokenOf(store, a) === tokenOf(store, b);
}

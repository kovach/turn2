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
  // Universal trailing id slot — also serves as the do-agg ↔ agg-result
  // correlation key (one identifier suffices).
  id: Term;
  idTok: number;
  wrappedAtom: Atom;          // unwrapped from terms[1]
  l: Term;
  r: Term;
}

type Blocked =
  | { kind: "agg"; row: BlockedDoAgg }
  | { kind: "choose"; row: BlockedChoose };

// Scan store for do-agg rows lacking matching agg-result rows. The id at
// the trailing slot of each row is the correlation key.
export function collectBlockedDoAggs(store: Store): BlockedDoAgg[] {
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "_agg-result")) {
    const t = store.tuples[idx]!;
    const idTerm = t.atom.terms[t.atom.terms.length - 1];
    if (idTerm === undefined) continue;
    resolved.add(tokenOf(store, idTerm));
  }
  const out: BlockedDoAgg[] = [];
  for (const idx of candidatesByHead(store, "_do-agg")) {
    const t = store.tuples[idx]!;
    const wrappedTerm = t.atom.terms[1];
    const idTerm = t.atom.terms[2];
    if (wrappedTerm === undefined || idTerm === undefined) continue;
    const idTok = tokenOf(store, idTerm);
    if (resolved.has(idTok)) continue;
    const wrappedAtom = unwrapAtom(wrappedTerm, store);
    if (wrappedAtom === null) continue;
    out.push({ rowIndex: idx, id: idTerm, idTok, wrappedAtom, l: t.l, r: t.r });
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
  for (const idx of candidatesByHead(store, "_choose")) {
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

  // wrapped.terms layout: [headSym, k1, ..., kK, weight]. The reserved
  // Symbol `_free` acts as a wildcard, *recursively* — `(cell _free _free)`
  // at a top-level position means that position takes any cell value and
  // contributes the cell to the group key. A position is "free" if it
  // contains `_free` at any depth; otherwise its candidate value must match
  // the wrapped pattern by recursive token unification.
  const arity = wrapped.terms.length;
  if (arity < 2) return false;

  // Candidates: tuples with same head sym + arity, interval contains the
  // do-agg's interval, and each non-free wrapped position structurally
  // matches the candidate's term.
  type Cand = { idx: number; terms: readonly Term[] };
  const candidates: Cand[] = [];
  for (const idx of candidatesByHead(store, headTerm.name)) {
    const t = store.tuples[idx]!;
    // Stored candidates carry the universal trailing id slot; the wrapped
    // pattern doesn't (it's user-pattern + weight). Skip the id when
    // checking arity / matching positions.
    if (t.atom.terms.length !== arity + 1) continue;
    if (!intervalContains(store, t.l, t.r, blocked.l, blocked.r)) continue;
    let ok = true;
    for (let i = 0; i < arity; i++) {
      if (!matchFreePattern(wrapped.terms[i]!, t.atom.terms[i]!, store)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    candidates.push({ idx, terms: t.atom.terms });
  }

  // Group by positions whose wrapped term contains `_free` anywhere
  // (positions 1..arity-2; the weight position is excluded). Key signature
  // is a `|`-joined string of the candidate's full-position hashcons tokens.
  const keyPositions: number[] = [];
  for (let i = 1; i < arity - 1; i++) {
    if (containsFree(wrapped.terms[i]!, store)) keyPositions.push(i);
  }
  const groups = new Map<string, Cand[]>();
  for (const c of candidates) {
    const sig = keyPositions.map((p) => tokenOf(store, c.terms[p]!)).join("|");
    let bucket = groups.get(sig);
    if (bucket === undefined) { bucket = []; groups.set(sig, bucket); }
    bucket.push(c);
  }
  if (groups.size === 0) {
    // No contributions.
    //   - last fails (per spec, last on empty has no agg-result).
    //   - With free key positions (group-by), there are no groups — emit
    //     nothing. Otherwise the consumer's match against the agg-result's
    //     inner pattern would unify its key Variables against the literal
    //     `_free` Symbol, and that bogus binding would leak into downstream
    //     emissions.
    //   - With no free key positions, "empty" still means a single fully-
    //     specified group with count/sum zero — emit one zero row.
    if (aggName === "last") return false;
    if (keyPositions.length > 0) return false;
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
  const filledTerms: Term[] = [];
  for (let i = 0; i < arity - 1; i++) {
    const w = wrapped.terms[i]!;
    if (containsFree(w, store)) {
      if (rep === null) {
        // No representative — only reachable when groups.size === 0 and
        // there are no key positions, so this branch should never see a
        // free-containing position.
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
  const sym: Term = { tag: "Symbol", name: "_agg-result" };
  // Copy the source _do-agg's trailing id over so the consumer Match's
  // structural unification on idTpl finds this row.
  const atom: Atom = { terms: [sym, internedInner, blocked.id] };
  const inserted = addTuple(store, atom, blocked.l, blocked.r, store.tupleSource[blocked.rowIndex]);
  if (inserted) {
    addOrder(store, blocked.l, blocked.r);
  }
  return inserted;
}

// Recursive structural match where the reserved Symbol `_free` in `pat`
// stands for any value. Both `pat` and `val` are ground (no Variables).
// Returns true iff every non-`_free` position in `pat` matches `val` by
// hashcons-token equality, descending through Atom-tagged Refs / literal
// Atoms. `Id`-tagged terms are opaque per notes/v2-design.md — they're
// compared by token only.
function matchFreePattern(pat: Term, val: Term, store: Store): boolean {
  if (pat.tag === "Symbol" && pat.name === "_free") return true;
  if (tokenOf(store, pat) === tokenOf(store, val)) return true;
  const pTerms = atomChildren(pat, store);
  const vTerms = atomChildren(val, store);
  if (pTerms === null || vTerms === null) return false;
  if (pTerms.length !== vTerms.length) return false;
  for (let i = 0; i < pTerms.length; i++) {
    if (!matchFreePattern(pTerms[i]!, vTerms[i]!, store)) return false;
  }
  return true;
}

// True iff `t` contains the reserved Symbol `_free` at any depth, walking
// only through Atom-tagged compound structure (Id terms are opaque).
function containsFree(t: Term, store: Store): boolean {
  if (t.tag === "Symbol") return t.name === "_free";
  const children = atomChildren(t, store);
  if (children === null) return false;
  for (const c of children) if (containsFree(c, store)) return true;
  return false;
}

// Children of an Atom-tagged compound, or null for non-compound / Id terms.
function atomChildren(term: Term, store: Store): readonly Term[] | null {
  if (term.tag === "Atom") return term.atom.terms;
  if (term.tag === "Ref") {
    if (refTagOf(store.hash, term.id) !== "Atom") return null;
    const a = store.hash.refToAtom.get(term.id);
    return a ? a.terms : null;
  }
  return null;
}

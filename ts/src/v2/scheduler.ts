// v2 scheduler: the non-monotone part of a program, packaged as moment
// handlers for the moment walk (moment-walk.ts, plans/v2-moment-walk.md).
// Reads store contents at outer-loop quiescence to find blocked do-agg /
// choose rows and to fold reactive aggregates; the walk decides *when* each
// handler runs (at the minimal unresolved moments). Knows nothing about rule
// continuations — paused work lives entirely in the store.

import type { Atom, Term } from "./term.js";
import { hashconsTerm, refTagOf } from "./hashcons.js";
import { getAggregator } from "./aggregators.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  comparable,
  intervalContains,
  lessEq,
  tokenOf,
  type Store,
} from "./store.js";
import type { Actor, BlockedChoose, ComponentOptions, Rule, RuleAtom } from "./types.js";
import { isActor } from "./types.js";
import { closeDoAggC, collectBlockedDoAggCs, SYM_AGG_EMPTY } from "./comp-aggregate.js";
import type { MomentHandler } from "./moment-walk.js";

const SYM_AGGVAL: Term = { tag: "Symbol", name: "_aggval" };
const SYM_AGGVAL_ID: Term = { tag: "Symbol", name: "*aggval-id" };
const SYM_FREE: Term = { tag: "Symbol", name: "_free" };

// A do-agg row whose matching agg-result row does not yet exist.
export interface BlockedDoAgg {
  rowIndex: number;
  // Universal trailing id slot — also serves as the do-agg ↔ agg-result
  // correlation key (one identifier suffices).
  id: Term;
  idTok: number;
  wrappedAtom: Atom;          // unwrapped from terms[1]
  l: Term;
  r: Term;
}

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

// Dead-choice marker head: `_dead-choice <activeTerm>`, emitted by the
// fixpoint loop when an earliest-tier choice component has zero option
// tuples. Under the temporal-monotonicity assumption (a component's
// options are fixed once its moment is quiescent) such a component can
// never gain options, so its active terms are complete: they count as
// resolved everywhere — the owning choose rows stop blocking and their
// continuations simply never fire (no `is` row ever appears).
export const SYM_DEAD_CHOICE: Term = { tag: "Symbol", name: "_dead-choice" };

// Mark one active term dead. `(bot, top)` span, mirroring `is` commit
// rows: dead-ness is a resolution, visible for the rest of the run.
export function markDeadChoice(store: Store, activeTerm: Term): void {
  addTuple(store, { terms: [SYM_DEAD_CHOICE, activeTerm] }, store.bot, store.top);
}

// Resolved active-term tokens: `is` commits plus `_dead-choice` markers.
export function resolvedChoiceTokens(store: Store): Set<number> {
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "is")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    if (T === undefined) continue;
    resolved.add(tokenOf(store, T));
  }
  for (const idx of candidatesByHead(store, "_dead-choice")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    if (T === undefined) continue;
    resolved.add(tokenOf(store, T));
  }
  return resolved;
}

// Scan store for choose rows whose wrapped atom contains at least one
// non-Symbol term lacking a matching `is <activeTerm> _` row (or a
// `_dead-choice` marker).
export function collectBlockedChooses(store: Store): BlockedChoose[] {
  const resolved = resolvedChoiceTokens(store);
  const out: BlockedChoose[] = [];
  for (const idx of candidatesByHead(store, "_choose")) {
    const t = store.tuples[idx]!;
    const chooseId = t.atom.terms[1];
    const wrappedTerm = t.atom.terms[2];
    if (chooseId === undefined || wrappedTerm === undefined) continue;
    const wrappedAtom = unwrapAtom(wrappedTerm, store);
    if (wrappedAtom === null) continue;
    // Actor column (plans/v2-choice-actors.md): stored layout is
    // `_choose chooseId (atom) actor emitId`. Default `you` for rows that
    // predate the column (hand-built stores).
    const actorTerm = t.atom.terms[3];
    const actor: Actor =
      actorTerm !== undefined && actorTerm.tag === "Symbol" && isActor(actorTerm.name)
        ? actorTerm.name
        : "you";
    const active: Term[] = [];
    collectActiveTerms(wrappedAtom, store, resolved, active);
    if (active.length > 0) {
      out.push({ rowIndex: idx, chooseId, wrappedAtom, actor, activeTerms: active, l: t.l, r: t.r });
    }
  }
  return out;
}

// One committed rng binding (plans/v2-choice-actors.md).
export interface RngCommit {
  activeTerm: Term;
  value: Term;
}

// mulberry32: a small deterministic PRNG over a 32-bit seed. Used when the
// user program seeds the rng via `+ rng-seed <n>` (plans/v2-choice-actors.md).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Program-provided rng seed: the user relation `rng-seed` with one numeric
// argument (`+ rng-seed 42`, asserted once at startup — i.e. established
// before the first rng choice; the fixpoint loop latches the stream at its
// first roll and later seed tuples have no effect). Returns a mulberry32
// stream for the seed, or null when no `rng-seed` tuple exists. Duplicate
// assertions of the same value are fine (tuples dedup by value anyway);
// distinct values or a non-numeric argument are errors.
export function programSeededRandom(store: Store): (() => number) | null {
  let seed: number | null = null;
  for (const idx of candidatesByHead(store, "rng-seed")) {
    const t = store.tuples[idx]!;
    const arg = t.atom.terms[1];
    const n = arg !== undefined && arg.tag === "Symbol" ? Number(arg.name) : NaN;
    if (!Number.isFinite(n)) {
      throw new Error("rng-seed: argument must be a number");
    }
    if (seed !== null && seed !== n) {
      throw new Error(`rng-seed: asserted with multiple values (${seed} and ${n})`);
    }
    seed = n;
  }
  return seed === null ? null : mulberry32(seed);
}

// Auto-resolve one all-`rng` choice component: pick one of its option tuples
// uniformly at random (options are deduped joint assignments — the
// distribution is uniform over joint assignments, not per-column marginals)
// and commit every active term at once by asserting `is <term> <value>` rows
// at `(bot, top)` — the same span the UI's appended `^ is X V` rows get,
// which is what lets nested `is C M` blocks match under any anchor. Each row
// carries a `(*rng <activeTerm>)` trailing id so arity-saturated user
// matches (`is C M` ⇒ stored width 4) see it. Returns the commits made, or
// null when the component has no options (the caller falls back to
// surfacing it as an active choice).
export function resolveRngChoice(
  store: Store,
  comp: ComponentOptions,
  random: () => number,
): RngCommit[] | null {
  if (comp.options.length === 0) return null;
  const pick = Math.min(comp.options.length - 1, Math.floor(random() * comp.options.length));
  const row = comp.options[pick]!;
  const isSym: Term = { tag: "Symbol", name: "is" };
  const idHead: Term = { tag: "Symbol", name: "*rng" };
  const commits: RngCommit[] = [];
  for (let i = 0; i < comp.activeTerms.length; i++) {
    const activeTerm = comp.activeTerms[i]!;
    const value = row[i]!;
    const commitId: Term = { tag: "Id", atom: { terms: [idHead, activeTerm] } };
    addTuple(store, { terms: [isSym, activeTerm, value, commitId] }, store.bot, store.top);
    commits.push({ activeTerm, value });
  }
  return commits;
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

// ----- Moment handlers (plans/v2-moment-walk.md) -----

// Demand aggregates: `_do-agg` (schema reads `rel k -> V`) and `_do-aggc`
// (bracket `[ Q | ... ]`) rows are closed when the walk reaches their left
// endpoint, with today's fold semantics (containment of the producer's
// `[l, r]`, `*agg-empty` sentinel) untouched. A row whose moment is already
// resolved — late work through a same-moment `^` chain — is `demanded` and
// closed on the next round without waiting for the frontier.
export function demandAggHandler(schema: Map<string, string>): MomentHandler {
  return {
    name: "demand-agg",
    run(store, m) {
      const mTok = tokenOf(store, m);
      let progress = false;
      for (const a of collectBlockedDoAggs(store)) {
        if (tokenOf(store, a.l) !== mTok) continue;
        if (closeDoAgg(store, a, schema)) progress = true;
      }
      for (const c of collectBlockedDoAggCs(store)) {
        if (tokenOf(store, c.l) !== mTok) continue;
        if (closeDoAggC(store, c)) progress = true;
      }
      return { progress, blocked: false };
    },
    demanded(store) {
      const out = new Set<number>();
      for (const a of collectBlockedDoAggs(store)) out.add(tokenOf(store, a.l));
      for (const c of collectBlockedDoAggCs(store)) out.add(tokenOf(store, c.l));
      return out;
    },
  };
}

// Choices: a moment with an unresolved `_choose` row is blocked. Surfacing,
// dead-choice marking and rng resolution stay in fixpoint.ts — they need
// the whole blocked set and end the loop. A late choose row at a resolved
// moment is `demanded` so it surfaces instead of hiding behind the frontier.
export function choiceHandler(): MomentHandler {
  return {
    name: "choice",
    run(store, m) {
      const mTok = tokenOf(store, m);
      const blocked = collectBlockedChooses(store).some((c) => tokenOf(store, c.l) === mTok);
      return { progress: false, blocked };
    },
    demanded(store) {
      const out = new Set<number>();
      for (const c of collectBlockedChooses(store)) out.add(tokenOf(store, c.l));
      return out;
    },
  };
}

// Close one do-agg row by computing its aggregate and emitting agg-result.
// Always returns true: count/sum emit a result, `last` may legitimately have
// nothing to emit, and that case is closed with the `*agg-empty` sentinel so
// the producer stops blocking the outer loop (see SYM_AGG_EMPTY).
export function closeDoAgg(
  store: Store,
  blocked: BlockedDoAgg,
  schema: Map<string, string>,
): boolean {
  const wrapped = blocked.wrappedAtom;
  const results = aggregateOver(store, wrapped, blocked.l, blocked.r, schema);
  let any = false;
  for (const r of results) {
    if (emitAggResultRow(store, blocked, wrapped, r.rep, r.weight)) any = true;
  }
  if (!any) {
    const sym: Term = { tag: "Symbol", name: "_agg-result" };
    const atom: Atom = { terms: [sym, SYM_AGG_EMPTY, blocked.id] };
    if (addTuple(store, atom, blocked.l, blocked.r, store.tupleSource[blocked.rowIndex])) {
      addOrder(store, blocked.l, blocked.r);
      any = true;
    }
  }
  return any;
}

// Generic aggregation over candidates inside `[l, r]` matching the
// `_do-agg`-style wrapped pattern `[head, k1..kK, weight]`. Returns one
// result per group (sum/count) or one per maximal candidate per group
// (last). Each result carries the `filledTerms` for the wrapped-pattern
// positions (with free positions substituted by the representative
// candidate's actual values) plus the aggregated `weight`. Empty input:
// `last` -> []; sum/count with no free key positions -> one zero row;
// sum/count with free key positions -> [].
export interface AggregateResult {
  // Wrapped-pattern positions 0..arity-2 substituted with rep values where
  // the position contained `_free`. Length arity-1 (head + keys, no weight).
  filledTerms: Term[];
  // Aggregated weight (sum/count) or candidate weight (last).
  weight: Term;
  // Representative candidate (group's first; for `last`, the maximal
  // candidate this result corresponds to). null only for the zero-row case
  // with no free key positions and no contributions.
  rep: { terms: readonly Term[] } | null;
}

export function aggregateOver(
  store: Store,
  wrapped: Atom,
  l: Term,
  r: Term,
  schema: Map<string, string>,
): AggregateResult[] {
  const headTerm = wrapped.terms[0];
  if (headTerm === undefined || headTerm.tag !== "Symbol") return [];
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
  if (arity < 2) return [];

  // Candidates: tuples with same head sym + arity, interval contains
  // [l, r], and each non-free wrapped position structurally matches the
  // candidate's term.
  type Cand = { idx: number; terms: readonly Term[] };
  const candidates: Cand[] = [];
  for (const idx of candidatesByHead(store, headTerm.name)) {
    const t = store.tuples[idx]!;
    // Stored candidates carry the universal trailing id slot; the wrapped
    // pattern doesn't (it's user-pattern + weight). Skip the id when
    // checking arity / matching positions.
    if (t.atom.terms.length !== arity + 1) continue;
    if (!intervalContains(store, t.l, t.r, l, r)) continue;
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

  const out: AggregateResult[] = [];
  if (groups.size === 0) {
    // No contributions:
    //   - last: no result.
    //   - sum/count with free key positions: no groups -> no result.
    //   - sum/count with no free key positions: one zero-row result.
    if (aggName === "last") return out;
    if (keyPositions.length > 0) return out;
    out.push({ filledTerms: buildFilledTerms(wrapped, null, store), weight: aggregator.zero, rep: null });
    return out;
  }
  for (const group of groups.values()) {
    if (aggName === "last") {
      // `c` is dominated by `d` iff c started strictly before d (comparing
      // left endpoints). Right endpoints are unsuitable because `+` facts
      // extend to SYM_TOP, so c.r <= d.l is never true for persistent
      // facts even when c was emitted strictly before d.
      const maximal = group.filter((c) => {
        const ci = store.tuples[c.idx]!;
        for (const d of group) {
          if (d === c) continue;
          const di = store.tuples[d.idx]!;
          if (!comparable(store, ci.l, di.l)) continue;
          if (lessEq(store, ci.l, di.l) && !lessEq(store, di.l, ci.l)) return false;
        }
        return true;
      });
      for (const c of maximal) {
        out.push({ filledTerms: buildFilledTerms(wrapped, c, store), weight: c.terms[arity - 1]!, rep: c });
      }
      continue;
    }
    let acc = aggregator.zero;
    for (const c of group) {
      try { acc = aggregator.fold(acc, c.terms[arity - 1]!); } catch { /* skip */ }
    }
    const rep = group[0]!;
    out.push({ filledTerms: buildFilledTerms(wrapped, rep, store), weight: acc, rep });
  }
  return out;
}

// Fill the wrapped pattern's positions 0..arity-2 (head + keys, no weight):
// each free-containing position is replaced by the representative candidate's
// actual value at that index. Non-free positions are kept as-is.
function buildFilledTerms(
  wrapped: Atom,
  rep: { terms: readonly Term[] } | null,
  store: Store,
): Term[] {
  const arity = wrapped.terms.length;
  const filled: Term[] = [];
  for (let i = 0; i < arity - 1; i++) {
    const w = wrapped.terms[i]!;
    if (containsFree(w, store)) {
      if (rep === null) filled.push(w);
      else filled.push(rep.terms[i]!);
    } else {
      filled.push(w);
    }
  }
  return filled;
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
  const filledTerms = buildFilledTerms(wrapped, rep, store);
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

// ----- Reactive aggregates (recomputed at every moment) -----
//
// See plans/v2-moment-walk.md. A `#reactive` relation's value is a function
// of moments; the reactive handler materializes it at every moment the walk
// visits as point rows
//
//   _aggval head key... value <id>     at [m, m]
//
// folded by `aggregateOver` over the contributors alive at the point `m`. A
// reactive read (`decomposeReactiveRead` in expand.ts) matches the row at
// exactly its anchor's left endpoint, so it samples the value there and is
// blocked — has no candidate — until the walk resolves that moment. No
// breakpoints, join-closure or residual detection: every moment gets its
// rows, and re-folding at a moment is idempotent (deterministic ids).
//
// Same-moment ordering keeps the static strata (`computeAggStrata`): within
// a moment the handler folds the lowest stratum first and returns as soon as
// a stratum adds rows, so a consumer (`count` of a same-moment transitive
// closure) is folded only in a round where every lower stratum re-folded
// with nothing new — i.e. has settled at `m`.

// Fold every group of reactive relation `foo` alive at the point `m` and
// emit the rows; returns true iff a new row was added. Contributors are
// bucketed by stored width first (`SchemaDecl` records no arity, and the
// `*` in `#reactive at * -> last` is not one), so each width is folded with
// a matching `_free` pattern. A relation with no contributors at all is
// folded keyless (width 3: head, weight, id) so a keyless `sum`/`count`/
// `bool` still gets its zero row; keyed relations produce nothing for
// absent groups, per `aggregateOver`'s zero-row policy.
export function foldReactiveAt(
  store: Store,
  foo: string,
  m: Term,
  schema: Map<string, string>,
): boolean {
  const head: Term = { tag: "Symbol", name: foo };
  const widths = new Set<number>();
  for (const idx of candidatesByHead(store, foo)) widths.add(store.tuples[idx]!.atom.terms.length);
  if (widths.size === 0) widths.add(3);
  let any = false;
  for (const w of widths) {
    // Stored `[head, key..., weight, id]` → wrapped `[head, _free..., _free]`
    // of length `w - 1`: every key position free (group by all of them),
    // weight folded.
    const arity = w - 1;
    if (arity < 2) continue;
    const wrapped: Atom = { terms: [head, ...Array.from({ length: arity - 1 }, () => SYM_FREE)] };
    for (const res of aggregateOver(store, wrapped, m, m, schema)) {
      if (emitAggValRow(store, res.filledTerms, res.weight, m)) any = true;
    }
  }
  return any;
}

// The reactive moment handler. `strata` is `computeAggStrata`'s map; relations
// it does not mention are stratum 0. Never blocked.
export function reactiveHandler(
  reactive: Set<string>,
  schema: Map<string, string>,
  strata: Map<string, number>,
): MomentHandler {
  // Relations grouped by stratum, ascending.
  const byStratum = new Map<number, string[]>();
  for (const foo of reactive) {
    const s = strata.get(foo) ?? 0;
    let bucket = byStratum.get(s);
    if (bucket === undefined) { bucket = []; byStratum.set(s, bucket); }
    bucket.push(foo);
  }
  const levels = [...byStratum.keys()].sort((a, b) => a - b);
  return {
    name: "reactive",
    run(store, m) {
      for (const s of levels) {
        let progress = false;
        for (const foo of byStratum.get(s)!) {
          if (foldReactiveAt(store, foo, m, schema)) progress = true;
        }
        // A stratum that added rows must settle (the monotone part may derive
        // new contributors from them) before any higher stratum is folded.
        if (progress) return { progress: true, blocked: false };
      }
      return { progress: false, blocked: false };
    },
  };
}

// Static aggregate dependency strata over the `#reactive` relations, computed
// from the TIME-MARKED dependency graph (plans/v2-stratification-analysis.md).
//
// For each rule, link every READ head (a `match`/`aggregate` body atom) to every
// PRODUCED head, marking the edge by how the produce places its moment relative
// to the anchor:
//   - `^h`   (anchor):           no fresh moment, `h` at the anchor   -> `=`
//   - `+h`/`~h`/`?h` (fact/episode/ask): fresh, strictly-later moment -> `<`
// A consumer depends on a producer AT ONE MOMENT iff there is an all-`=` path
// between them; any `<` edge means the producer is at a strictly earlier moment,
// which the moment-primary scheduler already orders (no stratum needed). So the
// stratum graph keeps `=` edges ONLY — `<` producers are dropped here.
//
// Edges span ALL relations (not just reactive), so an all-`=` dependency can
// chain through intermediate plain relations: `A -> …, ^c …` then `c …, ^B -> …`
// gives `A =→ c =→ B`. SCCs of the reactive `=`-subgraph are the strata; the
// returned map gives each reactive relation a stratum index strictly greater
// than every relation it `=`-depends on (one SCC — incl. a same-moment self-loop
// like transitive closure `p =→ p` — shares an index). The outer loop finalizes
// the lowest stratum present at a moment first, so a consumer aggregate is never
// folded against a not-yet-settled same-moment source.
//
// NOTE: the `=` mark is a heuristic over-approximation — `^h` is marked `=`
// against every read though it only truly coincides with the anchor (latest)
// read (open question 2 of the plan). It is sound (only ever adds within-moment
// ordering) but may over-serialize, or treat a time-stratified loop as an
// all-`=` cycle.
export function computeAggStrata(rules: Rule[], reactive: Set<string>): Map<string, number> {
  const READ = new Set<string>(["match", "aggregate"]);
  // `=` producers only: `anchor` (`^`) emits at the anchor, the same moment as
  // its reads. `fact`/`episode`/`ask` (`+`/`~`/`?`) mint a fresh, strictly-later
  // moment (`<`) and are intentionally NOT edges in the stratum graph — the
  // moment order handles those dependencies.
  const EQ_PRODUCE = new Set<string>(["anchor"]);
  // General `=`-edge graph: read-head =→ produce-head, over ALL relations.
  const gsucc = new Map<string, Set<string>>();
  const addEdge = (r: string, h: string): void => {
    let s = gsucc.get(r);
    if (s === undefined) { s = new Set(); gsucc.set(r, s); }
    s.add(h);
  };
  const collect = (atoms: RuleAtom[], reads: string[], produces: string[]): void => {
    for (const a of atoms) {
      if (a.tag === "Sub") { collect(a.body, reads, produces); continue; }
      if (a.tag === "AggComp") {
        // Every atom head inside a bracket aggregation is a read.
        collectAggCompReads(a.body, reads);
        continue;
      }
      if (a.tag !== "Atom") continue;
      const head = a.atom.terms[0];
      if (head === undefined || head.tag !== "Symbol") continue;
      if (READ.has(a.marker)) reads.push(head.name);
      else if (EQ_PRODUCE.has(a.marker)) produces.push(head.name);
    }
  };
  for (const rule of rules) {
    const reads: string[] = [];
    const produces: string[] = [];
    collect(rule.body, reads, produces);
    for (const r of reads) for (const h of produces) addEdge(r, h);
  }

  function collectAggCompReads(body: RuleAtom[], reads: string[]): void {
    for (const b of body) {
      if (b.tag === "AggComp") { collectAggCompReads(b.body, reads); continue; }
      if (b.tag !== "Atom") continue;
      const head = b.atom.terms[0];
      if (head !== undefined && head.tag === "Symbol") reads.push(head.name);
    }
  }
  // Transitive reachability over the general graph.
  const allNodes = new Set<string>(reactive);
  for (const [r, hs] of gsucc) { allNodes.add(r); for (const h of hs) allNodes.add(h); }
  const greach = new Map<string, Set<string>>();
  for (const n of allNodes) greach.set(n, new Set(gsucc.get(n) ?? []));
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of allNodes) {
      const rn = greach.get(n)!;
      for (const m of [...rn]) {
        for (const w of gsucc.get(m) ?? []) {
          if (!rn.has(w)) { rn.add(w); changed = true; }
        }
      }
    }
  }
  // Reactive subgraph from general reachability: `succ` (excl. self) feeds the
  // level computation, `reaches` (incl. self) feeds the SCC test.
  const nodes = [...reactive];
  const succ = new Map<string, Set<string>>();
  const reaches = new Map<string, Set<string>>();
  for (const A of nodes) {
    const ga = greach.get(A) ?? new Set<string>();
    const s = new Set<string>();
    const rset = new Set<string>([A]);
    for (const B of nodes) {
      if (!ga.has(B)) continue;
      rset.add(B);
      if (B !== A) s.add(B);
    }
    succ.set(A, s);
    reaches.set(A, rset);
  }
  // SCC id by mutual reachability.
  const sccId = new Map<string, number>();
  let nextScc = 0;
  for (const n of nodes) {
    if (sccId.has(n)) continue;
    const id = nextScc++;
    sccId.set(n, id);
    for (const m of nodes) {
      if (sccId.has(m)) continue;
      if (reaches.get(n)!.has(m) && reaches.get(m)!.has(n)) sccId.set(m, id);
    }
  }
  // Longest-path level over the condensation DAG (A→B ⇒ level(B) > level(A)).
  const level = new Map<number, number>();
  for (let i = 0; i < nextScc; i++) level.set(i, 0);
  for (let changed = true; changed; ) {
    changed = false;
    for (const u of nodes) {
      const su = sccId.get(u)!;
      for (const v of succ.get(u) ?? []) {
        const sv = sccId.get(v)!;
        if (su === sv) continue;
        if (level.get(sv)! < level.get(su)! + 1) { level.set(sv, level.get(su)! + 1); changed = true; }
      }
    }
  }
  const strata = new Map<string, number>();
  for (const n of nodes) strata.set(n, level.get(sccId.get(n)!)!);
  return strata;
}

// Emit `_aggval head key... value <id>` at the point `[m, m]`. The id is a
// deterministic Id over the row contents + moment so re-folding the same
// moment dedups. `filledTerms` is `[head, key...]` from `aggregateOver`.
function emitAggValRow(
  store: Store,
  filledTerms: Term[],
  weight: Term,
  m: Term,
): boolean {
  const userTerms = [SYM_AGGVAL, ...filledTerms, weight].map((t) => hashconsTerm(t, store.hash));
  const idInner: Term = {
    tag: "Id",
    atom: { terms: [SYM_AGGVAL_ID, ...filledTerms, weight, m].map((t) => hashconsTerm(t, store.hash)) },
  };
  const id = hashconsTerm(idInner, store.hash);
  const atom: Atom = { terms: [...userTerms, id] };
  return addTuple(store, atom, m, m);
}

// Bracket aggregation `[ Q | op V ]` close logic
// (plans/v2-bracket-aggregation.md). The expansion pass
// (expand.ts / decomposeAggComp) lowers the whole expression tree into one
// producer `_do-aggc <cq> <cols> <id>` row plus a consumer `_agg-resultc`
// Match. This module finds the blocked producer rows at outer-loop
// quiescence, evaluates the wrapped conjunctive query — every candidate
// tuple restricted to intervals *containing* the producer's anchor
// `[l, r]`, exactly like `aggregateOver` — reduces per group, and emits
// `_agg-resultc (row v1..vm) <copied id>` rows at the producer's endpoints.
//
// Semantics (see the plan):
//   - the query produces a SET of bindings over its free variables
//     (`count`/`sum` dedup derivations over all columns before folding);
//   - a binding's *moment* is the least upper bound of the left endpoints
//     of all tuples that contributed to it — `last` selects maximal
//     derivations per group by that moment (incomparable maxima each
//     produce a row);
//   - nested `[...]` items are evaluated recursively inside this close and
//     join like virtual relations (columns = their free vars, with the
//     nested reduce var holding its aggregate value);
//   - empty query: `last` -> no rows; `count`/`sum` with a nonempty group
//     key -> no rows; with an empty key -> one zero row.

import type { Atom, Term } from "./term.js";
import { hashconsTerm, refTagOf } from "./hashcons.js";
import { getAggregator } from "./aggregators.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  comparable,
  intervalContains,
  leastUpperBound,
  lessEq,
  tokenOf,
  type Store,
} from "./store.js";

const SYM_BOT: Term = { tag: "Symbol", name: "bot" };
const SYM_AGG_RESULTC: Term = { tag: "Symbol", name: "_agg-resultc" };

// A do-aggc row whose matching agg-resultc row does not yet exist.
export interface BlockedDoAggC {
  rowIndex: number;
  // Universal trailing id slot — the do-aggc ↔ agg-resultc correlation key.
  id: Term;
  idTok: number;
  cq: Term;   // wrapped (*cq ...) query term
  cols: Term; // (*cq-cols ...) result-row layout
  l: Term;
  r: Term;
}

// Scan store for do-aggc rows lacking matching agg-resultc rows (mirror of
// scheduler.ts collectBlockedDoAggs).
export function collectBlockedDoAggCs(store: Store): BlockedDoAggC[] {
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "_agg-resultc")) {
    const t = store.tuples[idx]!;
    const idTerm = t.atom.terms[t.atom.terms.length - 1];
    if (idTerm === undefined) continue;
    resolved.add(tokenOf(store, idTerm));
  }
  const out: BlockedDoAggC[] = [];
  for (const idx of candidatesByHead(store, "_do-aggc")) {
    const t = store.tuples[idx]!;
    const cq = t.atom.terms[1];
    const cols = t.atom.terms[2];
    const idTerm = t.atom.terms[3];
    if (cq === undefined || cols === undefined || idTerm === undefined) continue;
    const idTok = tokenOf(store, idTerm);
    if (resolved.has(idTok)) continue;
    out.push({ rowIndex: idx, id: idTerm, idTok, cq, cols, l: t.l, r: t.r });
  }
  return out;
}

// Close one do-aggc row: decode the wrapped query, evaluate + reduce it at
// the row's anchor, and emit one `_agg-resultc` row per result. Returns
// true iff a new row was added.
export function closeDoAggC(store: Store, blocked: BlockedDoAggC): boolean {
  const cq = decodeComp(store, blocked.cq);
  const cols = decodeCols(store, blocked.cols);
  const results = evalComp(store, cq, blocked.l, blocked.r);
  let any = false;
  for (const row of results) {
    const rowTerms: Term[] = [];
    let ok = true;
    for (const n of cols) {
      const v = row.vals.get(n);
      if (v === undefined) { ok = false; break; }
      rowTerms.push(hashconsTerm(v, store.hash));
    }
    if (!ok) continue;
    const inner = hashconsTerm({ tag: "Atom", atom: { terms: rowTerms } }, store.hash);
    // Copy the source _do-aggc's trailing id over so the consumer Match's
    // structural unification on idTpl finds this row.
    const atom: Atom = { terms: [SYM_AGG_RESULTC, inner, blocked.id] };
    if (addTuple(store, atom, blocked.l, blocked.r, store.tupleSource[blocked.rowIndex])) {
      addOrder(store, blocked.l, blocked.r);
      any = true;
    }
  }
  return any;
}

// ----- Decoding the wrapped query -----
//
// Encoding produced by decomposeAggComp:
//   comp       := (*cq (*cq-red <op> (*fv :V)) item...)
//   atom item  := (*cq-atom t1 ... tk)
//   nested     := its own (*cq ...) term
//   free var   := (*fv :name)      wildcard := *cq-any
//   cols       := (*cq-cols (*fv :name)...)

interface CQ {
  op: string;
  varName: string;
  // Pattern unified against the folded value at close time. Its unbound
  // `(*fv :name)` positions become output columns; ground positions filter
  // (plans/v2-agg-output-var.md).
  out: Term;
  items: CQItem[];
}
type CQItem =
  | { kind: "atom"; terms: readonly Term[] }
  | { kind: "comp"; cq: CQ };

// Children of any compound term (Atom- or Id-tagged, literal or Ref), or
// null. The bracket-aggregation encoding uses Id-tagged wrappers that this
// module owns — the Id-opacity invariant of notes/v2-design.md targets
// fresh-id terms, not this private encoding.
function childrenOf(store: Store, t: Term): readonly Term[] | null {
  if (t.tag === "Atom" || t.tag === "Id") return t.atom.terms;
  if (t.tag === "Ref") {
    const a = store.hash.refToAtom.get(t.id);
    return a ? a.terms : null;
  }
  return null;
}

// Children of an Atom-tagged compound only (Id terms stay opaque — they
// compare by token in matchTerm, mirroring scheduler.ts matchFreePattern).
function atomKids(store: Store, t: Term): readonly Term[] | null {
  if (t.tag === "Atom") return t.atom.terms;
  if (t.tag === "Ref") {
    if (refTagOf(store.hash, t.id) !== "Atom") return null;
    const a = store.hash.refToAtom.get(t.id);
    return a ? a.terms : null;
  }
  return null;
}

function isSymNamed(t: Term, name: string): boolean {
  return t.tag === "Symbol" && t.name === name;
}

function headName(store: Store, t: Term): string | null {
  const kids = childrenOf(store, t);
  if (kids === null) return null;
  const h = kids[0];
  return h !== undefined && h.tag === "Symbol" ? h.name : null;
}

// `(*fv :name)` -> "name", else null.
function fvName(store: Store, t: Term): string | null {
  if (t.tag === "Symbol" || t.tag === "Variable" || t.tag === "Wildcard") return null;
  const kids = childrenOf(store, t);
  if (kids === null || kids.length !== 2) return null;
  if (!isSymNamed(kids[0]!, "*fv")) return null;
  const s = kids[1]!;
  if (s.tag !== "Symbol" || !s.name.startsWith(":")) return null;
  return s.name.slice(1);
}

function decodeComp(store: Store, t: Term): CQ {
  const kids = childrenOf(store, t);
  if (kids === null || kids.length < 3 || !isSymNamed(kids[0]!, "*cq")) {
    throw new Error("v2 bracket aggregation: malformed *cq term");
  }
  const redKids = childrenOf(store, kids[1]!);
  if (redKids === null || redKids.length !== 4 || !isSymNamed(redKids[0]!, "*cq-red")) {
    throw new Error("v2 bracket aggregation: malformed *cq-red term");
  }
  const opTerm = redKids[1]!;
  if (opTerm.tag !== "Symbol") {
    throw new Error("v2 bracket aggregation: *cq-red op must be a symbol");
  }
  const varName = fvName(store, redKids[2]!);
  if (varName === null) {
    throw new Error("v2 bracket aggregation: *cq-red var must be a (*fv :name) term");
  }
  const items: CQItem[] = [];
  for (let i = 2; i < kids.length; i++) {
    const it = kids[i]!;
    const h = headName(store, it);
    if (h === "*cq") {
      items.push({ kind: "comp", cq: decodeComp(store, it) });
    } else if (h === "*cq-atom") {
      items.push({ kind: "atom", terms: childrenOf(store, it)!.slice(1) });
    } else {
      throw new Error("v2 bracket aggregation: malformed query item");
    }
  }
  return { op: opTerm.name, varName, out: redKids[3]!, items };
}

function decodeCols(store: Store, t: Term): string[] {
  const kids = childrenOf(store, t);
  if (kids === null || kids.length < 1 || !isSymNamed(kids[0]!, "*cq-cols")) {
    throw new Error("v2 bracket aggregation: malformed *cq-cols term");
  }
  const out: string[] = [];
  for (let i = 1; i < kids.length; i++) {
    const n = fvName(store, kids[i]!);
    if (n === null) throw new Error("v2 bracket aggregation: malformed *cq-cols entry");
    out.push(n);
  }
  return out;
}

// The columns of what `joinItems` returns for a comp: the union of its
// items' output columns, in first-occurrence order.
function joinCols(store: Store, cq: CQ): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of cq.items) {
    if (it.kind === "comp") {
      for (const n of compOutCols(store, it.cq)) {
        if (!seen.has(n)) { seen.add(n); out.push(n); }
      }
    } else {
      for (const t of it.terms) collectFvs(store, t, out, seen);
    }
  }
  return out;
}

// The output columns of a comp — its result-row layout:
//
//   outCols(comp) = joinCols(comp) − {V} ++ unbound variables of `out`
//
// This must produce exactly the sequence `aggCompOutCols` in expand.ts
// produces for the same expression: that one writes the layout (the
// `*cq-cols` term and the consumer Match's row pattern), this one reads it.
function compOutCols(store: Store, cq: CQ): string[] {
  const out = joinCols(store, cq).filter((n) => n !== cq.varName);
  collectFvs(store, cq.out, out, new Set(out));
  return out;
}

function collectFvs(store: Store, t: Term, out: string[], seen: Set<string>): void {
  const n = fvName(store, t);
  if (n !== null) {
    if (!seen.has(n)) { seen.add(n); out.push(n); }
    return;
  }
  const kids = childrenOf(store, t);
  if (kids === null) return;
  for (const c of kids) collectFvs(store, c, out, seen);
}

// ----- Evaluation -----

// One derivation of the query: a binding of column names to (interned)
// values, plus the lub of its contributor moments.
interface Deriv {
  vals: Map<string, Term>;
  moment: Term;
}

function lubOf(store: Store, moments: Term[]): Term {
  if (moments.length === 0) return SYM_BOT;
  if (moments.length === 1) return moments[0]!;
  const lub = leastUpperBound(store, moments);
  if (lub === null) {
    throw new Error(
      "v2 bracket aggregation: no least upper bound for a binding's contributor moments " +
        "(moment order is not a lattice — see notes/moment-insertion.md)",
    );
  }
  return lub;
}

function evalComp(store: Store, cq: CQ, l: Term, r: Term): Deriv[] {
  return reduceRows(store, cq, joinItems(store, cq.items, l, r));
}

// Backtracking conjunctive join over the items in order. Atom items
// enumerate stored tuples (same head, same arity modulo the universal
// trailing id slot, interval containing the anchor `[l, r]`); comp items
// enumerate their recursively-evaluated result rows. Free-var positions
// bind/check against the running substitution.
function joinItems(store: Store, items: CQItem[], l: Term, r: Term): Deriv[] {
  // Nested comps are independent of the outer join state (shared vars join
  // through the substitution afterwards), so evaluate each once up front.
  const evaluated: (Deriv[] | null)[] = items.map((it) =>
    it.kind === "comp" ? evalComp(store, it.cq, l, r) : null,
  );
  const out: Deriv[] = [];
  const vals = new Map<string, Term>();
  const rec = (i: number, moments: Term[]): void => {
    if (i === items.length) {
      out.push({ vals: new Map(vals), moment: lubOf(store, moments) });
      return;
    }
    const it = items[i]!;
    if (it.kind === "comp") {
      for (const row of evaluated[i]!) {
        const undo: string[] = [];
        let ok = true;
        for (const [n, v] of row.vals) {
          const cur = vals.get(n);
          if (cur === undefined) {
            vals.set(n, v);
            undo.push(n);
          } else if (tokenOf(store, cur) !== tokenOf(store, v)) {
            ok = false;
            break;
          }
        }
        if (ok) rec(i + 1, [...moments, row.moment]);
        for (const n of undo) vals.delete(n);
      }
      return;
    }
    const head = it.terms[0];
    if (head === undefined || head.tag !== "Symbol") {
      throw new Error("v2 bracket aggregation: query atom head must be a symbol");
    }
    const arity = it.terms.length;
    for (const idx of candidatesByHead(store, head.name)) {
      const t = store.tuples[idx]!;
      // Stored candidates carry the universal trailing id slot; the
      // pattern doesn't.
      if (t.atom.terms.length !== arity + 1) continue;
      if (!intervalContains(store, t.l, t.r, l, r)) continue;
      const undo: string[] = [];
      let ok = true;
      for (let p = 0; p < arity; p++) {
        if (!matchTerm(store, it.terms[p]!, t.atom.terms[p]!, vals, undo)) {
          ok = false;
          break;
        }
      }
      if (ok) rec(i + 1, [...moments, t.l]);
      for (const n of undo) vals.delete(n);
    }
  };
  rec(0, []);
  return out;
}

// Structural pattern match with binding: `*cq-any` matches anything,
// `(*fv :name)` binds/checks the substitution, ground positions compare by
// hashcons token, descending only through Atom-tagged compounds (Id terms
// are opaque, per scheduler.ts matchFreePattern).
function matchTerm(
  store: Store,
  pat: Term,
  val: Term,
  vals: Map<string, Term>,
  undo: string[],
): boolean {
  if (isSymNamed(pat, "*cq-any")) return true;
  const fv = fvName(store, pat);
  if (fv !== null) {
    const cur = vals.get(fv);
    if (cur === undefined) {
      vals.set(fv, val);
      undo.push(fv);
      return true;
    }
    return tokenOf(store, cur) === tokenOf(store, val);
  }
  if (tokenOf(store, pat) === tokenOf(store, val)) return true;
  const pk = atomKids(store, pat);
  const vk = atomKids(store, val);
  if (pk === null || vk === null || pk.length !== vk.length) return false;
  for (let i = 0; i < pk.length; i++) {
    if (!matchTerm(store, pk[i]!, vk[i]!, vals, undo)) return false;
  }
  return true;
}

// ----- Reduction -----

function reduceRows(store: Store, cq: CQ, rows: Deriv[]): Deriv[] {
  const cols = joinCols(store, cq);
  const V = cq.varName;
  const keyCols = cols.filter((n) => n !== V);
  const outCols = compOutCols(store, cq);
  const aggregator = getAggregator(cq.op);

  const sigOf = (row: Deriv, names: string[]): string =>
    names.map((n) => tokenOf(store, row.vals.get(n)!)).join("|");

  // A result row carries the group key plus whatever unifying the folded
  // value against `out` binds — never `V`, which is internal to the query.
  // A group whose fold fails to unify with `out` produces no row.
  const resultRow = (rep: Deriv | null, value: Term, moment: Term): Deriv | null => {
    const vals = new Map<string, Term>();
    if (rep !== null) for (const n of keyCols) vals.set(n, rep.vals.get(n)!);
    if (!matchTerm(store, cq.out, value, vals, [])) return null;
    return { vals, moment };
  };

  if (rows.length === 0) {
    // Empty input: last -> no rows; count/sum with group columns -> no
    // rows; otherwise one zero row (mirrors scheduler.ts aggregateOver).
    if (cq.op === "last") return [];
    if (keyCols.length > 0) return [];
    const row = resultRow(null, hashconsTerm(aggregator.zero, store.hash), SYM_BOT);
    return row === null ? [] : [row];
  }

  if (cq.op === "last") {
    // Keep every derivation; per group select the maximal ones by moment
    // (a derivation is dominated iff another's moment is strictly
    // greater), then dedup surviving bindings.
    const groups = groupBy(rows, (rw) => sigOf(rw, keyCols));
    const out: Deriv[] = [];
    for (const group of groups.values()) {
      const maximal = group.filter((c) => {
        for (const d of group) {
          if (d === c) continue;
          if (!comparable(store, c.moment, d.moment)) continue;
          if (lessEq(store, c.moment, d.moment) && !lessEq(store, d.moment, c.moment)) {
            return false;
          }
        }
        return true;
      });
      // Dedup on *output* columns: two maximal derivations differing only
      // in a non-output column collapse to one row — the intended set
      // semantics of the expression's result.
      const seen = new Set<string>();
      for (const c of maximal) {
        const row = resultRow(c, c.vals.get(V)!, c.moment);
        if (row === null) continue;
        const s = sigOf(row, outCols);
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(row);
      }
    }
    return out;
  }

  // count / sum: set semantics — dedup derivations over ALL columns, then
  // group by the key columns and fold V.
  const seen = new Set<string>();
  const distinct: Deriv[] = [];
  for (const rw of rows) {
    const s = sigOf(rw, cols);
    if (seen.has(s)) continue;
    seen.add(s);
    distinct.push(rw);
  }
  const groups = groupBy(distinct, (rw) => sigOf(rw, keyCols));
  const out: Deriv[] = [];
  for (const group of groups.values()) {
    let acc = aggregator.zero;
    for (const rw of group) {
      try {
        acc = aggregator.fold(acc, rw.vals.get(V)!);
      } catch {
        /* skip non-foldable values, mirroring aggregateOver */
      }
    }
    const row = resultRow(
      group[0]!,
      hashconsTerm(acc, store.hash),
      lubOf(store, group.map((g) => g.moment)),
    );
    if (row !== null) out.push(row);
  }
  return out;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    let b = out.get(k);
    if (b === undefined) {
      b = [];
      out.set(k, b);
    }
    b.push(it);
  }
  return out;
}

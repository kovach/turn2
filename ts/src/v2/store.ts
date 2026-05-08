// v2 store: interval-bearing tuples + an output sink + the moment-order
// relation. All Term values pass through hashcons so identity comparison
// is just integer equality on Ref ids.

import type { Atom, Term } from "../types.js";
import type { OutputTuple, Tuple } from "./types.js";
import {
  createHashcons,
  hashconsAtom,
  hashconsTerm,
  tokenOfId,
  type HashconsState,
} from "../hashcons.js";

export interface Store {
  hash: HashconsState;
  tuples: Tuple[];
  // head-sym name -> tuple indices in `tuples` whose first term is that sym
  byHead: Map<string, number[]>;
  outputs: OutputTuple[];
  // Forward adjacency on the moment-order relation. Keyed and valued by
  // hashcons token (NodeId from tokenOfId). Closure is computed lazily by
  // BFS in `lessThan`.
  orderFwd: Map<number, Set<number>>;
  bot: Term;
  top: Term;
  botTok: number;
  topTok: number;
  // Dedup set for moment-order edges already asserted, keyed as
  // `${ltTok},${gtTok}`. Avoids re-walking the closure during inserts.
  edgeSet: Set<string>;
  // Dedup set for tuples, keyed as `${atomTok},${lTok},${rTok}`.
  tupleSet: Set<string>;
  // Dedup set for output tuples, keyed as `${atomTok}`.
  outputSet: Set<number>;
}

export function createStore(): Store {
  const hash = createHashcons();
  const bot = hashconsTerm({ tag: "Symbol", name: "bot" }, hash);
  const top = hashconsTerm({ tag: "Symbol", name: "top" }, hash);
  return {
    hash,
    tuples: [],
    byHead: new Map(),
    outputs: [],
    orderFwd: new Map(),
    bot,
    top,
    botTok: tokenOfId(bot, hash),
    topTok: tokenOfId(top, hash),
    edgeSet: new Set(),
    tupleSet: new Set(),
    outputSet: new Set(),
  };
}

export function intern(store: Store, term: Term): Term {
  return hashconsTerm(term, store.hash);
}

export function internAtom(store: Store, atom: Atom): Atom {
  return hashconsAtom(atom, store.hash);
}

export function tokenOf(store: Store, term: Term): number {
  return tokenOfId(term, store.hash);
}

// Add a tuple. Returns true iff the tuple was new. Assumes endpoints are
// already interned; the atom's `terms` may be a mix of Refs and atomic Terms
// (Symbol/Variable/Wildcard) — we re-hashcons to obtain a stable id.
export function addTuple(store: Store, atom: Atom, l: Term, r: Term): boolean {
  const atomRef = hashconsTerm({ tag: "Atom", atom }, store.hash);
  const atomTok = tokenOfId(atomRef, store.hash);
  const lTok = tokenOf(store, l);
  const rTok = tokenOf(store, r);
  const key = `${atomTok},${lTok},${rTok}`;
  if (store.tupleSet.has(key)) return false;
  store.tupleSet.add(key);
  const t: Tuple = { atom, l, r };
  const idx = store.tuples.length;
  store.tuples.push(t);
  const head = atom.terms[0];
  if (head !== undefined && head.tag === "Symbol") {
    let bucket = store.byHead.get(head.name);
    if (bucket === undefined) {
      bucket = [];
      store.byHead.set(head.name, bucket);
    }
    bucket.push(idx);
  }
  return true;
}

export function addOutput(store: Store, atom: Atom): boolean {
  const ref = hashconsTerm({ tag: "Atom", atom }, store.hash);
  const tok = tokenOfId(ref, store.hash);
  if (store.outputSet.has(tok)) return false;
  store.outputSet.add(tok);
  store.outputs.push({ atom });
  return true;
}

// Assert lt < gt. No-op if already known. Bot/top edges are implicit and
// not stored.
export function addOrder(store: Store, lt: Term, gt: Term): void {
  const ltTok = tokenOf(store, lt);
  const gtTok = tokenOf(store, gt);
  if (ltTok === gtTok) return;
  if (ltTok === store.botTok || gtTok === store.topTok) return;
  const key = `${ltTok},${gtTok}`;
  if (store.edgeSet.has(key)) return;
  store.edgeSet.add(key);
  let succs = store.orderFwd.get(ltTok);
  if (succs === undefined) {
    succs = new Set();
    store.orderFwd.set(ltTok, succs);
  }
  succs.add(gtTok);
}

// Strict less-than over the moment-order relation, with bot/top sentinels
// universally below/above every other moment.
export function lessThan(store: Store, a: Term, b: Term): boolean {
  const aTok = tokenOf(store, a);
  const bTok = tokenOf(store, b);
  return lessThanTok(store, aTok, bTok);
}

function lessThanTok(store: Store, aTok: number, bTok: number): boolean {
  if (aTok === bTok) return false;
  if (aTok === store.topTok) return false;
  if (bTok === store.botTok) return false;
  if (aTok === store.botTok) return true;
  if (bTok === store.topTok) return true;
  // BFS closure search.
  const stack = [aTok];
  const seen = new Set<number>([aTok]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const succs = store.orderFwd.get(cur);
    if (succs === undefined) continue;
    if (succs.has(bTok)) return true;
    for (const s of succs) {
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return false;
}

export function lessEq(store: Store, a: Term, b: Term): boolean {
  const aTok = tokenOf(store, a);
  const bTok = tokenOf(store, b);
  if (aTok === bTok) return true;
  return lessThanTok(store, aTok, bTok);
}

// Comparable: a < b, b < a, or a == b derivable.
export function comparable(store: Store, a: Term, b: Term): boolean {
  const aTok = tokenOf(store, a);
  const bTok = tokenOf(store, b);
  if (aTok === bTok) return true;
  return lessThanTok(store, aTok, bTok) || lessThanTok(store, bTok, aTok);
}

// Overlap match per spec: (l1, r1) overlaps (l2, r2) iff l1 <= r2 && l2 <= r1
// AND the endpoint pairs are each comparable.
export function intervalsOverlap(
  store: Store,
  l1: Term, r1: Term,
  l2: Term, r2: Term,
): boolean {
  if (!comparable(store, l1, l2)) return false;
  if (!comparable(store, r1, r2)) return false;
  if (!lessEq(store, l1, r2)) return false;
  if (!lessEq(store, l2, r1)) return false;
  return true;
}

// Aggregation containment: outer contains inner iff
// outer_l <= inner_l && inner_r <= outer_r, with comparability required.
export function intervalContains(
  store: Store,
  outerL: Term, outerR: Term,
  innerL: Term, innerR: Term,
): boolean {
  if (!comparable(store, outerL, innerL)) return false;
  if (!comparable(store, outerR, innerR)) return false;
  if (!lessEq(store, outerL, innerL)) return false;
  if (!lessEq(store, innerR, outerR)) return false;
  return true;
}

// Tuple candidates whose first term is the given symbol. Returned by index
// in `tuples` so callers can iterate without copying.
export function candidatesByHead(store: Store, head: string): readonly number[] {
  return store.byHead.get(head) ?? [];
}

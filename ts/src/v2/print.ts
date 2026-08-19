// Surface-syntax printer for hashconsed v2 terms. Used by tests, the editor,
// and the constraint-query module to round-trip terms back to text that
// `parse` will re-accept.
//
// >>> DEBUGGING: use `renderDebugDump` <<<
// Don't roll your own term renderer for ad-hoc scripts. Hashconsed terms
// share subterms in a DAG; naively expanding every Ref re-emits each shared
// subterm at every occurrence, producing megabytes of output for tiny
// stores. `renderDebugDump` returns a JSON-serializable object with each
// Ref body printed once in a `refs` map and per-tuple terms shown as
// shallow `*<id>` handles — total size linear in distinct Refs, and the
// caller can `console.log(dump.tuples)` alone if they don't need the map.
//
// Id-opacity invariant (notes/v2-design.md): printers must not recursively
// unfold `Id` terms — neither `Id`-tagged literals nor `Ref`s whose backing
// tag is `Id`. We render ids as opaque handles (`*<token>` for refs,
// `*<*…>` for literals showing the head symbol). A future folded display
// mode will resolve ids to human-readable labels via lookup; until then,
// the opaque handle is the contract.
//
// TODO: implement a folded display variant that maps an id token to a
// human-readable label (e.g. originating rule var name) without walking
// the id body.

import type { Atom, Term } from "./term.js";
import type { Rule } from "./types.js";
import { expandTerm, refTagOf } from "./hashcons.js";
import { tokenOf, type Store } from "./store.js";

// Token-level equality: two terms are equal iff their hashcons tokens agree.
// Hashconsed Refs share id, Symbols share name, compound Atom/Id literals
// share token via the store's intern table.
export function tokensEq(a: Term, b: Term, store: Store): boolean {
  return tokenOf(store, a) === tokenOf(store, b);
}

// Render an `Id`-tagged literal opaquely without descending into its body.
// Shows the head symbol if available so debug output remains useful.
function renderIdLiteral(atom: Atom): string {
  const head = atom.terms[0];
  if (head !== undefined && head.tag === "Symbol") {
    return `<id ${head.name}>`;
  }
  return "<id>";
}

export function renderTerm(store: Store, term: Term): string {
  // Stop at Id-backed Refs without expanding their body.
  if (term.tag === "Ref" && refTagOf(store.hash, term.id) === "Id") {
    return `*${term.id}`;
  }
  const t = term.tag === "Ref" ? expandTerm(term, store.hash) : term;
  switch (t.tag) {
    case "Symbol": return t.name;
    case "Variable": return `?${t.name}`;
    case "Wildcard": return "_";
    case "Ref": return `*${t.id}`;
    case "Id": return renderIdLiteral(t.atom);
    case "Atom":
      return `(${t.atom.terms.map((x) => renderTerm(store, x)).join(" ")})`;
  }
}

// --- Structural fingerprints (identity across runs, not display) ---
//
// A hashcons token (`*17`) identifies a term only within one run: it is an
// allocation counter, so it shifts whenever the program is re-evaluated over
// different content — a user edit, or an `is` row appended by a click. What
// IS stable is the *body* the evaluator built: an emitted tuple's trailing id
// slot fingerprints its firing structurally (rule name, atom index, chain of
// enclosing moments — see `freshIdTemplate` in expand.ts), so two runs that
// derive a tuple the same way build the same body.
//
// That body must never be expanded into a term or a string: it is a DAG whose
// shared subterms duplicate under expansion, so its printed size grows
// exponentially in derivation depth — far more expensive than running the
// program. Instead we hash it in place, memoized per `Ref`: each distinct ref
// is visited once and contributes its arity, making a fingerprint linear in
// the hashcons DAG the evaluator already built.
//
// The hash mixes symbol/variable *names* and structure only — never tokens —
// so it is comparable across runs. It is a fingerprint, not an injection:
// distinct tuples can in principle collide (64 bits, so not in practice), and
// tuples with identical derivations deliberately share one.

// FNV-1a; `seed` picks one of two independent 32-bit lanes.
function fnv1a(s: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const hex8 = (n: number): string => n.toString(16).padStart(8, "0");
// 64-bit fingerprint as 16 hex chars: two FNV lanes over the same input.
const fp = (s: string): string => hex8(fnv1a(s, 0x811c9dc5)) + hex8(fnv1a(s, 0x9e3779b1));

// One memo per Store: ref id → fingerprint. Keyed weakly so a superseded
// store's table is collectable with it.
const fpMemos = new WeakMap<Store, Map<number, string>>();

function termFp(store: Store, term: Term, memo: Map<number, string>): string {
  switch (term.tag) {
    case "Symbol":   return fp(`S${term.name}`);
    case "Variable": return fp(`V${term.name}`);
    case "Wildcard": return fp("W");
    case "Atom":     return fp("A" + term.atom.terms.map((t) => termFp(store, t, memo)).join(""));
    case "Id":       return fp("I" + term.atom.terms.map((t) => termFp(store, t, memo)).join(""));
    case "Ref": {
      const hit = memo.get(term.id);
      if (hit !== undefined) return hit;
      const body = store.hash.refToAtom.get(term.id);
      // No stored body — nothing structural to hash. Falling back to the
      // token is run-local, but this is unreachable for stored tuples.
      const out = body === undefined
        ? fp(`R${term.id}`)
        : fp((refTagOf(store.hash, term.id) === "Id" ? "I" : "A")
             + body.terms.map((t) => termFp(store, t, memo)).join(""));
      memo.set(term.id, out);
      return out;
    }
  }
}

// Fingerprint of a stored atom, including the trailing universal id slot —
// that slot is what makes distinct firings of one rule distinguishable.
export function atomFingerprint(store: Store, atom: Atom): string {
  let memo = fpMemos.get(store);
  if (memo === undefined) { memo = new Map(); fpMemos.set(store, memo); }
  return fp("T" + atom.terms.map((t) => termFp(store, t, memo)).join(""));
}

export function renderAtom(store: Store, atom: Atom): string {
  // Drop the trailing universal id slot (every emitted tuple's atom carries
  // one). Rendered separately by tuple printers when needed; users see only
  // the user-facing terms.
  return userTerms(atom).map((t) => renderTerm(store, t)).join(" ");
}

// Strip the trailing universal id slot from a stored atom's terms. The id
// slot is the last term of every emitted tuple's atom (added by wrapEmit
// in expand.ts). Returns the user-facing prefix.
export function userTerms(atom: Atom): readonly Term[] {
  if (atom.terms.length === 0) return atom.terms;
  return atom.terms.slice(0, atom.terms.length - 1);
}

// Shallow variant of `renderTerm`: stops at any `Ref` boundary, printing it
// as `*<id>` instead of recursively expanding the stored body. Used for
// moment/interval endpoints (the timeline's dot titles, the db view's
// `[l, r]` column), where the Ref *is* the moment identity and expanding its
// backing chain adds noise rather than information. Atom/fact content should
// use the full `renderAtom`/`renderTerm` so user data terms like `(s z)`
// display unfolded. Id literals are also rendered opaquely.
export function renderTermShallow(store: Store, term: Term): string {
  switch (term.tag) {
    case "Symbol": return term.name;
    case "Variable": return `?${term.name}`;
    case "Wildcard": return "_";
    case "Ref": return `*${term.id}`;
    case "Id": return renderIdLiteral(term.atom);
    case "Atom":
      return `(${term.atom.terms.map((x) => renderTermShallow(store, x)).join(" ")})`;
  }
}

export function renderAtomShallow(store: Store, atom: Atom): string {
  return userTerms(atom).map((t) => renderTermShallow(store, t)).join(" ");
}

// Share-aware reification of a set of root terms into a list of source-form
// `= V<i> (...)` bindings plus per-root rendered strings. Walks the
// hashcons DAG via `store.hash.refToAtom`, visiting each Ref at most once.
// Every Ref's stored body is emitted in exactly one place — as a `= V<i>`
// binding when shared (refCount ≥ 2 or root), or inlined at its sole use
// site otherwise. Linear in distinct Refs regardless of unfold size.
//
// Variable names `V1, V2, …` are assigned in ascending hashcons-id order.
// v2's hashcons allocates ids bottom-up, so this is a valid topological
// order over the sharing DAG (a binding for `Vk` only references prior
// `V<i>` for i<k). Names need only be locally unique to the appended
// rule, so this won't collide with a user-authored `V1` elsewhere.
//
// Output `bindings` and `results` are designed to be concatenated as
// source lines: caller emits `[...bindings, "+ is " + results[0] + " " +
// results[1], …]`.
//
// Id-opacity caveat: this printer *does* walk `Id`-backed Ref bodies, but
// only because it is share-aware — every Ref id is visited at most once
// (regardless of how many times it appears in `roots`) and emitted as a
// single `= V<i> (...)` binding. Output size is linear in distinct Refs,
// not in the unfolded tree size, so the exponential blowup that the
// id-opacity invariant guards against doesn't apply here. Surface form
// preserves Atom-vs-Id by using `*`-prefixed head symbols (parser maps
// compounds whose head Symbol starts with `*` back to `Id`).
export function compressRefs(
  roots: readonly Term[],
  store: Store,
): { bindings: string[]; results: string[] } {
  const refCount = new Map<number, number>();
  const visited = new Set<number>();

  function countRefs(t: Term): void {
    if (t.tag === "Ref") {
      refCount.set(t.id, (refCount.get(t.id) ?? 0) + 1);
      if (visited.has(t.id)) return;
      visited.add(t.id);
      const stored = store.hash.refToAtom.get(t.id);
      if (stored) for (const sub of stored.terms) countRefs(sub);
      return;
    }
    if (t.tag === "Atom" || t.tag === "Id") {
      for (const sub of t.atom.terms) countRefs(sub);
    }
  }
  for (const root of roots) countRefs(root);

  // Shared: refCount ≥ 2, plus any root that is itself a Ref.
  const shared = new Set<number>();
  for (const [id, count] of refCount) {
    if (count >= 2) shared.add(id);
  }
  for (const root of roots) {
    if (root.tag === "Ref") shared.add(root.id);
  }

  const sharedList = [...shared].sort((a, b) => a - b);
  const varMap = new Map<number, string>();
  sharedList.forEach((id, i) => varMap.set(id, `V${i + 1}`));

  function renderInner(t: Term): string {
    if (t.tag === "Ref") {
      const v = varMap.get(t.id);
      if (v !== undefined) return v;
      const stored = store.hash.refToAtom.get(t.id);
      if (!stored) return `*${t.id}`;
      return `(${stored.terms.map(renderInner).join(" ")})`;
    }
    if (t.tag === "Atom" || t.tag === "Id") {
      return `(${t.atom.terms.map(renderInner).join(" ")})`;
    }
    if (t.tag === "Symbol") return t.name;
    if (t.tag === "Variable") return `?${t.name}`;
    return "_";
  }

  const bindings: string[] = [];
  for (const id of sharedList) {
    const stored = store.hash.refToAtom.get(id);
    if (!stored) continue;
    bindings.push(`= ${varMap.get(id)} (${stored.terms.map(renderInner).join(" ")})`);
  }

  const results = roots.map(renderInner);
  return { bindings, results };
}

// Debug dump for ad-hoc scripts. Returns two flat strings:
//   - `hashConsStore`: one line per Ref body, `*<id> = (terms…)`. Nested
//     Refs in the body render as `*<id>` handles, not unfolded. Each Ref
//     body appears exactly once. Id-tagged bodies are signalled by the
//     `*`-prefixed head Symbol convention (e.g. `*mom`, `*id`), matching
//     the surface form parsers accept.
//   - `db`: one line per tuple, `<atom-terms> @ <l>..<r> #<id>`, where
//     `<id>` is the trailing universal id slot every emitted tuple carries.
//
// Why this shape: hashconsed terms share subterms in a DAG. Naive
// recursive rendering re-emits each shared body at every occurrence
// (megabytes for tens of tuples). Printing the store once and referencing
// Refs by id everywhere else is linear in distinct Refs.
export interface DebugDump {
  hashConsStore: string;
  db: string;
}

function shallowTerm(t: Term, used: Set<number>): string {
  switch (t.tag) {
    case "Symbol": return t.name;
    case "Variable": return `?${t.name}`;
    case "Wildcard": return "_";
    case "Ref": used.add(t.id); return `*${t.id}`;
    case "Id": return renderIdLiteral(t.atom);
    case "Atom":
      return `(${t.atom.terms.map((x) => shallowTerm(x, used)).join(" ")})`;
  }
}

export function renderDebugDump(
  store: Store,
  tuples: readonly { atom: Atom; l: Term; r: Term }[],
): DebugDump {
  const used = new Set<number>();
  const dbLines: string[] = [];
  for (const t of tuples) {
    const atomStr = userTerms(t.atom).map((x) => shallowTerm(x, used)).join(" ");
    const l = shallowTerm(t.l, used);
    const r = shallowTerm(t.r, used);
    const idTerm = t.atom.terms[t.atom.terms.length - 1];
    const idStr = idTerm === undefined ? "" : ` #${shallowTerm(idTerm, used)}`;
    dbLines.push(`${atomStr} @ ${l}..${r}${idStr}`);
  }
  const refLines = new Map<number, string>();
  while (true) {
    let added = false;
    for (const id of used) {
      if (refLines.has(id)) continue;
      const atom = store.hash.refToAtom.get(id);
      if (atom === undefined) continue;
      const body = atom.terms.map((x) => shallowTerm(x, used)).join(" ");
      refLines.set(id, `*${id} = (${body})`);
      added = true;
    }
    if (!added) break;
  }
  const sortedIds = [...refLines.keys()].sort((a, b) => a - b);
  return {
    hashConsStore: sortedIds.map((id) => refLines.get(id)!).join("\n"),
    db: dbLines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Per-tuple binding environment (plans/v2-live-values-in-editor.md).
//
// Every rule-emitted tuple ends in a universal id slot
// `(*id <ruleName> <lexPos> (*chain t1 … tn) …)` (wrapEmit in expand.ts),
// and the chain holds the value of every user variable bound before the emit
// — `noteVar` pushes each one at first occurrence and marks it essential, so
// chain pruning never drops it. The names are static: the expanded rule's
// Emit with the same `(head, ruleName, lexPos)` carries the unsubstituted
// template whose `*chain` lists the Variables in the same order. Zipping the
// two recovers the environment without any evaluator support.
//
// Returns `undefined` for tuples that carry no such slot (seeds, aggregate
// results, constraint-query rows) or whose rule/template cannot be found.
// Compiler-minted names (`_l_k`, `_r_k`, `_xl_k`, `_dot<n>`, fresh-id
// templates for wildcards, …) are dropped; what remains is exactly the
// source-level variables, in first-occurrence order. Values are the stored
// (hashconsed) terms — render them with `renderTermShallow` for the `*id`
// form.

export interface TupleBinding {
  name: string;
  term: Term;
}

export interface TupleBindingsResult {
  ruleName: string;
  bindings: TupleBinding[];
}

// One-level view of a compound: a `Ref`'s stored body (subterms stay Refs),
// or a literal's own atom. Never `expandTerm` here — the id slot's chain is
// the exponential DAG the id-opacity invariant guards against.
function shallowAtom(store: Store, t: Term): Atom | null {
  if (t.tag === "Ref") return store.hash.refToAtom.get(t.id) ?? null;
  if (t.tag === "Id" || t.tag === "Atom") return t.atom;
  return null;
}

function idSlotParts(store: Store, t: Term): { head: string; ruleName: string; lexPos: string; chain: readonly Term[] } | null {
  const id = shallowAtom(store, t);
  if (id === null) return null;
  const [head, rule, pos, chainT] = id.terms;
  if (head?.tag !== "Symbol" || !head.name.startsWith("*")) return null;
  if (rule?.tag !== "Symbol" || pos?.tag !== "Symbol" || chainT === undefined) return null;
  const chain = shallowAtom(store, chainT);
  if (chain === null) return null;
  const ch = chain.terms[0];
  if (ch?.tag !== "Symbol" || ch.name !== "*chain") return null;
  return { head: head.name, ruleName: rule.name, lexPos: pos.name, chain: chain.terms.slice(1) };
}

export function tupleBindings(
  store: Store,
  expandedRules: readonly Rule[],
  tupleIndex: number,
): TupleBindingsResult | undefined {
  const tuple = store.tuples[tupleIndex];
  if (tuple === undefined || tuple.atom.terms.length === 0) return undefined;
  const stored = idSlotParts(store, tuple.atom.terms[tuple.atom.terms.length - 1]!);
  if (stored === null) return undefined;
  for (const rule of expandedRules) {
    if (rule.name !== stored.ruleName) continue;
    for (const a of rule.body) {
      if (a.tag !== "Emit") continue;
      const last = a.atom.terms[a.atom.terms.length - 1];
      if (last === undefined) continue;
      const tmpl = idSlotParts(store, last);
      if (tmpl === null || tmpl.head !== stored.head || tmpl.lexPos !== stored.lexPos) continue;
      if (tmpl.chain.length !== stored.chain.length) return undefined;
      const bindings: TupleBinding[] = [];
      tmpl.chain.forEach((v, i) => {
        if (v.tag === "Variable" && !v.name.startsWith("_")) bindings.push({ name: v.name, term: stored.chain[i]! });
      });
      return { ruleName: stored.ruleName, bindings };
    }
  }
  return undefined;
}

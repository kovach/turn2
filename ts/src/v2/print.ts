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
// as `*<id>` instead of recursively expanding the stored body. Useful for
// info-panel display where deeply nested moment chains explode visually.
// Id literals are also rendered opaquely.
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

import type { Term } from "./types.js";
import type { HashconsState } from "./hashcons.js";
import { idKey, type NodeRow, type RefStore } from "./refstore.js";

// Walk a term and call `visit` once for each terminal occurrence (every
// non-Atom term, including the term itself when it is non-Atom). Atom and
// Ref bodies are descended into. Hashcons trees are acyclic by construction
// (a Ref's body only references previously-allocated, smaller-id Refs), so
// no seen-set is needed for termination — but `visit` is invoked once per
// occurrence in the tree, so shared subterms reachable along multiple paths
// are visited once per path.
//
// Exposed for callers that need to enumerate the deep structure of a term
// uniformly (constraint-query.ts uses it to find every unresolved choice
// term mentioned anywhere in a Constrain row's atom).
export function walkTermDeep(term: Term, hc: HashconsState, visit: (t: Term) => void): void {
  if (term.tag === "Atom") {
    for (const t of term.atom.terms) walkTermDeep(t, hc, visit);
    return;
  }
  visit(term);
  if (term.tag === "Ref") {
    const atom = hc.refToAtom.get(term.id);
    if (atom) for (const t of atom.terms) walkTermDeep(t, hc, visit);
  }
}

// Rows whose atom transitively contains `value`. Recurses through Atom
// subterms and Ref bodies; comparison is at the hashcons-token level so a
// Ref and the equivalent expanded Atom match. Top-level *and* compound
// matches both count: `(card (cell C))` is in the fringe of `C`.
//
// O(rows × avg-atom-size) per call; callers that need many lookups against
// the same value can cache.
export function fringeOf(store: RefStore, value: Term, hc: HashconsState): NodeRow[] {
  const target = idKey(value, hc);
  const out: NodeRow[] = [];
  for (const row of store.nodes.values()) {
    let hit = false;
    for (const t of row.atom.terms) {
      walkTermDeep(t, hc, (sub) => {
        if (!hit && idKey(sub, hc) === target) hit = true;
      });
      if (hit) break;
    }
    if (hit) out.push(row);
  }
  return out;
}

import type { Term } from "./types.js";
import { refTagOf, type HashconsState } from "./hashcons.js";

// Walk a term, calling `visit` once at each terminal occurrence and at every
// `Id` boundary, then descending only through `Atom` bodies (and `Atom`-bodied
// `Ref`s). `Id` terms are deliberately visited but NOT descended — the
// `(id name idN previousVars…)` shape is shared exponentially via the
// previousVars chain, so a naive deep walk would do exponential work and
// wouldn't surface anything user-meaningful that isn't already at the Id's
// surface elsewhere in the term.
//
// Hashcons trees are acyclic by construction (a Ref's body only references
// previously-allocated, smaller-id Refs), so no seen-set is needed for
// termination. `visit` is invoked once per occurrence in the tree, so shared
// subterms reachable along multiple paths are visited once per path.
//
// Exposed for callers that need to enumerate the deep structure of a term
// uniformly (constraint-query.ts uses it to find every unresolved choice
// term mentioned anywhere in a Constrain row's atom).
export function walkTermDeep(term: Term, hc: HashconsState, visit: (t: Term) => void): void {
  if (term.tag === "Atom") {
    for (const t of term.atom.terms) walkTermDeep(t, hc, visit);
    return;
  }
  if (term.tag === "Id") {
    visit(term);
    return;
  }
  visit(term);
  if (term.tag === "Ref") {
    if (refTagOf(hc, term.id) === "Id") return;  // Id body: stop here.
    const atom = hc.refToAtom.get(term.id);
    if (atom) for (const t of atom.terms) walkTermDeep(t, hc, visit);
  }
}

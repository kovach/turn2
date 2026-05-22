# `is`-substitution during constraint queries

Today a partial commit (binding some but not all active terms of a multi-
slot component) leaves the component in a dead state: the constraint
query still matches the original `*id` template literally against stored
tuples, so it finds no options even though the user-visible values exist
under the bound name.

The fix: when running constraint queries, treat any active term `X` for
which `is X V` exists in the store as equal to `V` — substitute `V` for
`X` everywhere the query inspects.

## Where the gap is today

1. `gatherChoiceContext` (`ts/src/v2/constraint-query.ts:43`) reads `is`
   rows to build a `resolved: Set<number>` of resolved active-term tokens,
   then drops them from `activeSet`.
2. `activeTokensIn` walks each constrain row's wrapped atom; resolved
   tokens are simply absent from `activeSet`, so they're invisible to
   `touched`.
3. `runComponent` / `matchTerm` treats *any* token not in `activeSet` as
   a literal: at `matchTerm`'s second branch (`if (ptok === tokenOf(store, val))`)
   it demands literal token equality against the candidate slot. The
   stored candidates carry the *value* `V`, not the id template `X`, so
   the match fails.
4. `runAggRow` rewrites only `activeSet` tokens to `_free`; resolved
   tokens stay as-is in the agg pattern, with the same wrong-token
   problem.

## Design

Introduce a substitution map alongside the resolved set, and apply it
during query and aggregation. Two implementation choices:

- **(A) Substitute at match time** — patch `matchTerm` to consult the
  substitution before falling through to literal equality. Small diff but
  needs threading the map through `runComponent` / `matchTerm` /
  `runAggRow`. Aggregation's `aggPattern` construction also needs
  substitution since `aggregateOver` is opaque.
- **(B) Substitute the wrapped atom once, up-front** — produce a
  substituted copy of each row's `wrapped` atom (via a recursive walk
  that re-interns compound subterms) and run the existing code against
  that. Localizes the change: `matchTerm` and `runAggRow` need no
  knowledge of the substitution; everything works on a clean atom that
  contains values, not id templates.

Plan goes with **(B)**. The recursive rewrite is cheap (one walk per
constrain row per surfaced component) and avoids fragmenting "is this
position substituted" knowledge across all the match sites.

### Substitution map

`gatherChoiceContext` already iterates `is` rows. Extend it to also
record `boundValues: Map<number, Term>` keyed by `tokenOf(store, X)`,
value = `is`-row's `terms[2]` (`V`).

Transitive closure: when `is A B` and `is B C` both exist, callers
expect `A` to resolve to `C`. After the initial pass, walk the map and
collapse: for each entry `(k, v)`, if `tokenOf(v)` is itself a key,
replace `v` with the deeper value. Iterate until no key's value is
itself a key, or detect a cycle (shouldn't happen, but throw if it
does — cycles are a program error).

### Term substitution helper

New (or extended) helper in `constraint-query.ts`:

```ts
function substResolved(t: Term, bound: Map<number, Term>, store: Store): Term;
```

Walks the term:
- If `tokenOf(store, t)` is a key in `bound`, return `bound.get(...)` (no
  further descent — the value is opaque and may already be ground).
- If `t.tag === "Atom" | "Id"`: recurse on each child term; if any child
  changed, build a new Atom and `internAtom` it (Atom vs Id preserved).
- If `t.tag === "Ref"`: look up the body in `store.hash.refToAtom`;
  recurse into its terms. If any child changed, build a new Atom and
  intern it as `Atom` (we don't reconstruct Id-tagged Refs through this
  path, since Ids are opaque — but the only Id terms a constrain wrapped
  atom contains are active-term templates, which would have been hit at
  the top by the `bound` check). Otherwise return `t` unchanged.
- `Symbol` / `Variable` / `Wildcard`: return as-is.

Reuse `internAtom` from `store.ts` for re-hashconsing.

### Apply during constraint-row gather

After `gatherConstrainRows` produces the row list, post-process each
row's `wrapped` by `substResolved(wrappedTerm, bound, store)`. Store the
substituted atom alongside the original (or replace in place — the
original isn't needed downstream). The `touched` set is unchanged since
substitution doesn't introduce or remove unresolved-active tokens.

### `runAggRow`

The current code walks `wrapped.terms` to build `aggPattern`. After
substitution, the wrapped atom already contains values where bound, so
the existing logic ("active tokens → `_free`, else keep") works
unmodified. Same for the post-aggregate `matchTerm` checks against the
substituted wrapped atom.

## Net diff

- `ts/src/v2/constraint-query.ts`:
  - `ChoiceContext` gains `boundValues: Map<number, Term>`.
  - `gatherChoiceContext` populates `boundValues` from `is` rows; builds
    transitive closure.
  - New `substResolved(t, bound, store)` helper.
  - `gatherConstrainRows` (or the caller) substitutes each `wrapped`
    atom once via `substResolved`.
  - `runComponent` / `matchTerm` / `runAggRow` unchanged.
- `ts/src/v2/store.ts`: no change expected; reuse `internAtom`.
- Tests: extend `v2_constraint_query.test.ts` (or add new) with a
  partial-bind case — two-slot component, commit one slot via `is`, then
  verify the second slot's options are computed against the substituted
  value.

## Open questions

- **Bound term shape.** `is X V` is parsed as a regular row, so `V` can
  be any term — Symbol, Ref, compound. The substituted wrapped atom may
  end up with sub-Refs that didn't exist before; `internAtom` handles
  this. No special case needed.
- **Cycles in `is`.** `is A B, is B A`? Treat as a program error and
  throw during closure construction. Easy to detect (visited-set DFS).
- **`is` rows whose left-hand side is not an active term.** A user might
  write `is foo bar` for their own purposes. The map should only contain
  entries whose key is an active-term token from some blocked choose row.
  Restrict at gather time: only add `(tokenOf(X), V)` if `tokenOf(X)` is
  in the union of all `BlockedChoose.activeTerms`' tokens (or simpler:
  only if `X`'s expanded head is `*id` / `*choose`).
- **Interaction with the empty-fringe check.** After substitution, a
  component whose only constraint mentioned now-bound terms could in
  principle have all its rows "still touching" unresolved terms; the
  current check looks at `comp.rows.length === 0`, which is unaffected.
  No change needed.
- **Display side.** Once the engine substitutes, my default-display's
  length-1 intents for one slot of a wider component become valid; no
  change to default-display.ts beyond verifying behavior in practice.

# v2 — global design notes

Living document. Pin invariants here that span more than one v2 file. Plans
under `plans/v2-*.md` may extend or refine these but should not contradict
them silently — flag the conflict.

## Term taxonomy

`Term` (defined in `ts/src/types.ts`) has six tags:

- `Symbol` — interned atomic name.
- `Variable` — rule-body bind site. Resolved to a ground term by the unifier
  before tuples are written to the store.
- `Wildcard` — anonymous match position; never bound, never serialized.
- `Atom { terms }` — compound *data* term. The arguments of stored tuples
  are `Atom`-tagged. Sub-structure is meaningful and may be inspected by
  rules (matched, destructured, unified term-by-term).
- `Id { terms }` — compound *identity* term. Constructed by the compiler /
  evaluator to name something that the runtime needs to refer to by
  identity but never by structure: fresh moments, choice ids, the
  `_choose` / `do-agg` / `agg-result` correlation keys, and the static
  `id.chain` template that `expand` attaches to each rule-body atom.
- `Ref` — hashcons handle. Every compound term seen by `addTuple` /
  trail / store traversal is canonicalized to a `Ref` whose body lives in
  `store.hash.refToAtom` and whose backing tag (`Atom` or `Id`) is
  recoverable via `refTagOf`.

`Atom` and `Id` are **disjoint tag classes**. The unifier (v1
`unifyTerms`, reused by v2) refuses to unify an `Atom`-tagged term with an
`Id`-tagged term even if their bodies match element-wise. That separation
is what makes the next invariant tractable.

## Invariant: ids are opaque to execution

> **Execution never recursively unfolds an `Id` term.**
>
> An `Id`-tagged `Ref` is compared by token (`tokenOfId` / pointer
> equality on the hashcons handle). An `Id`-tagged literal compares
> against another `Id` only via interning to a `Ref` and comparing
> tokens. Code that walks term structure — unification, dependency
> tracing, component-graph construction, output reification — must
> stop the walk at any `Id` boundary.

### Why this matters

Compiler-generated identity terms have nontrivial nested structure: a
fresh-id atom built by `eval.freshIdTerm` is roughly

```
(*id <ruleName> <lexPos> <prevVarValue₁> <prevVarValue₂> … <varName>)
```

and each `prevVarValueᵢ` is itself a fresh-id atom from an earlier
binding in the same rule. Rule firings chain: the id produced for the
nth binding contains the ids of all (n-1) prior bindings as sub-terms.
Lengths grow linearly per rule body but the underlying bodies share via
hashcons — so the *DAG* describing one id is small while the *tree* you
get by recursively unfolding it is exponential in the depth of the
chain.

Any code path that recursively descends through id sub-terms therefore
risks turning a polynomial computation into an exponential one,
silently. The invariant above is the only thing keeping that from
happening. It must hold universally — a single non-conformant traversal
elsewhere in the pipeline reintroduces the blowup.

### What this means for specific code

- **Unification.** `unifyTerms` short-circuits on `Ref`-vs-`Ref` token
  equality (the common case for ids), and the `refTagOf` check refuses
  Atom-vs-Id mismatches *before* descent. As long as ids are tagged
  `Id`, the unifier will never enter the per-element loop on them.
- **Hashcons sharing.** `hashconsAtom` interns sub-terms before
  installing the parent. Two ids that share a prefix share their
  prefix's `Ref` id, so `Ref`-vs-`Ref` equality is the right test —
  *but only* if we never unfold those refs and re-walk their bodies.
- **Constraint-graph queries.** `activeTokensIn` walks a constrain
  row's wrapped atom to discover which active terms (choice ids) it
  mentions. It descends through `Atom`-tagged refs (data structure)
  but stops at `Id`-tagged refs (identity, opaque). Mentions of an
  active-term id show up as a token-equality hit at *some* level of
  the walk; descending past that point would only revisit
  already-counted structure.
- **Print / debug.** Printers must follow the same rule: do not
  recursively unfold `Id` terms. Render an id as an opaque handle
  (e.g. its hashcons token, or a short stable hash) and stop the
  walk at the id boundary. The exponential-blowup risk applies to
  any traversal, not just the fixpoint hot path — a debug print of
  a deeply chained fresh-id can hang the UI just as easily as a
  miswritten unifier can hang the engine.
  - **TODO:** implement a *folded* display variant that resolves an
    id to a human-readable label by table-lookup (e.g. mapping
    chooseId → the user-visible variable name from the rule that
    produced it) without touching the id's body. Until that exists,
    printers should bottom out at the opaque handle.

### Tagging discipline

Every compiler-generated identity term must be constructed with
`{ tag: "Id", … }` (or built via a helper that does so) and immediately
hashconsed. Specifically:

- fresh moment ids (`*mom …`)
- fresh-id atoms for unbound assert / ask / constrain variables (`*id …`)
- fresh choose-correlation ids (`*choose …`)
- the static `id.chain` template attached by `expand.assignIds`
- aggregate correlation keys (`do-agg` / `agg-result` `aggId`)

Data-bearing compound terms — user-written nested patterns, the
`wrapped` atom inside `choose` / `constrain` / `do-agg` rows, the
inner atom of `agg-result` — remain `Atom`-tagged. The wrapper rows
themselves (`(choose <chooseId> <wrapped>)`, `(constrain <wrapped>)`,
…) are tuples, not terms; their `terms` array mixes a `Symbol` head,
an `Id`-tagged correlation, and an `Atom`-tagged payload.

Anything that looks like an "id" but is *user-supplied* (e.g. a domain
atom that the user happened to assert as a key) is data, not identity:
keep it `Atom`-tagged. The boundary is "did the compiler construct
this to name something" — not "is it ground" or "is it nested."

# js-def relations inside `!(...)` constrain blocks

## Problem

A js relation (`#js-def`, plans/v2-js-relations.md) appearing as a sub-atom of a
`!(...)` block is currently rejected at expand time (`decomposeJsRel`,
expand.ts): constrain sub-atoms are not evaluated by the rule engine — they are
serialized into `(_constrain (*conj (*c-plain …) …))` rows that
constraint-query.ts later replays as a backtracking conjunctive join against
`store.byHead`, and js relations never populate the store, so a js sub-atom
would silently match nothing.

This plan teaches the constraint-query join to call the compiled generator
clauses directly, mirroring what `evalJsIterate` (eval.ts) does in the rule
engine. Motivating use: letting a generator enumerate or filter an option
domain for a choice, e.g. `!(range 1 10 N)` constraining an active term `N`.

## Semantics

A js sub-atom participates in the component's conjunctive query as a
generator-backed relation: its `+`-position args are decoded to JS values, the
selected clause's generator runs, and each yielded row unifies against the
`-`-position patterns as a backtracking choice point (a bound `-` position
filters, as in `evalJsIterate`). Js relations are timeless — the choice
component moment `M` does not gate them.

### Dynamic clause selection

The static `resolveJsModes` pass (js-rel.ts) cannot apply here: inside
constraint-query, what is bound depends on the join order over `_constrain`
rows discovered at runtime, not on a lexical rule body. Instead, when the join
reaches a js sub:

1. Apply the current substitution to each arg term (recursively — see
   `applySub` below).
2. A position is `+` iff the substituted term is fully ground (no remaining
   active-term or `*var` tokens, no unbound structure).
3. Pick the *earliest declared* clause whose mode vector is ≤ the call's,
   pointwise under `- < +` — the same rule `resolveJsModes` applies statically.
4. No matching clause → runtime error naming the relation and the call's
   modes.

### Scheduling: js subs run last, component-wide

The whole component is semantically one conjunction (rows only package
sub-atoms for connectivity/moment purposes), so evaluation order affects only
which modes are available at each js call, never the result set. To maximize
boundness and make behavior independent of store discovery order:

- Partition the component's sub-atoms: all plain and agg subs first (in their
  existing row/sub order), then all js subs (stable — two js subs keep their
  relative order).
- This keeps the common "match something, then js-filter it" pattern working
  regardless of where the user wrote the js sub inside the block, and
  regardless of `comp.rows` insertion order.

Per-row partition was considered and rejected: rows within a component are
ordered by store discovery, so a per-row scheme would make mode availability
depend on evaluation-order accidents across rows.

## Changes by file

### expand.ts — representation and validation

- New reserved wrapper head `*c-js` alongside `*c-plain` / `*c-agg` (constant
  `SYM_C_JS` next to the others).
- `buildConstrainRowAtom`: a sub whose head Symbol names a relation in
  `state.jsRels` is wrapped with `*c-js` instead of `*c-plain`. The existing
  `rewrite` walk (free vars / wildcards → per-block `*var` templates, bound
  vars left for the trail) needs no js-specific casing.
- `decomposeJsRel`: delete the subAtoms rejection loop. Replace with
  validation on js-rel subs:
  - `kind === "agg"` (a trailing `-> weight`) is an error — there are no store
    rows to aggregate.
  - Arity check against the relation's declared arity (all clauses of a name
    share arity — enforced at parse), for an early compile error instead of a
    silent runtime mode failure.
- The `isJsHead` rejection inside `buildConstrainRowAtom`'s `rewrite` (a `#js`
  *function* call in a `!(...)` term position) stays as-is: this plan covers js
  *relations* only.

### constraint-query.ts — evaluation

- `ConstrainSub.kind` gains `"js"`; `gatherConstrainRows` recognizes the
  `*c-js` wrapper head. `collectActiveAndExistTokens` already walks sub-atoms
  generically, so js subs contribute their active/existential tokens to
  component connectivity (and the empty-fringe check) for free.
- `runComponent`: before the backtracking join starts, split the component's
  subs into `storeSubs` (plain + agg, existing order) and `jsSubs`; run
  `storeSubs` through the existing `goRow`-style recursion, then thread the
  continuation through `jsSubs`.
- New `runJsSub(s, sub, store, slotSet, jsRels, after)`, modeled on
  `evalJsIterate`:
  - `applySub(t)`: recursively rewrite a pattern term by the current `sub`
    (note: `runAggSub`'s existing lookup is top-level-only; this helper must
    recurse through Atom/Ref-with-Atom-body structure, respecting Id opacity —
    same shape as `substResolved`).
  - Compute call modes; select the clause (see above).
  - Decode `+` args with `decodeTerm(term, store.hash)`; run the generator;
    step the iterator manually so errors surface as `` #js-def <name> threw:
    <msg> ``; enforce `JS_REL_YIELD_CAP`.
  - For each yielded array (validated: array of length = number of `-`
    positions), `encodeTerm` each value and match it against the corresponding
    pattern arg via the existing `matchTerm` (which already threads active and
    existential slots through `sub`); call `after(trial)` on success.
- `computeComponents` signature gains
  `jsRels: Map<string, CompiledJsRel[]>` — `CompiledJsRel` (js-rel.ts) already
  carries `modes` and the compiled generator, which is everything dynamic
  selection needs. Pass it down to `runComponent`.

### fixpoint.ts — plumbing

Pass the already-computed `jsRelFuncs` (built by `compileJsRels` in
`runFixpoint`) through to the `computeComponents` call at outer-loop
quiescence.

### print.ts / timeline.ts — rendering

`_constrain` rows are pulled into the timeline sidebar and rendered by the
printers; wherever `*c-plain` / `*c-agg` wrappers are matched, handle `*c-js`
the same as plain (likely a one-line addition; verify nothing crashes on the
new head).

### Docs

- `ts/src/v2/overview.md`: add `*c-js` to the reserved-symbols list; update
  the `decomposeJsRel` paragraph (js relations now allowed in `!(...)`,
  agg-kind and off-arity subs still rejected) and the constraint-query section
  (js subs, dynamic clause selection, js-last scheduling).
- `discussions/turn-tutorial.md`: extend the js-relation section with the
  `!(...)` usage and its rules (no `-> weight`, clause selection is dynamic,
  ensure some clause serves the modes your block produces).

## Out of scope / unchanged

- Js relations in exception LHS and `[ ... ]` bracket-aggregation queries stay
  rejected (`applyExceptions`, `aggCompOutCols`).
- No change to the rule-engine `JsIterate` path or to static
  `resolveJsModes`.

## Tests

Extend `ts/src/tests/v2_compound_constraints.test.ts` or add
`v2_js_rel_constrain.test.ts` (run via ./run-tests.sh):

1. Enumeration: `!(range 1 3 N)` on an active `?N` yields exactly options
   1, 2, 3.
2. Filter: a js relation with a `+ +` clause pruning options produced by a
   plain sub in the same block — verifies dynamic selection picks the bound
   clause.
3. Join through an existential shared between a plain sub and a js sub.
4. Ordering robustness: js sub written *before* the plain sub that binds its
   `+` arg still works (component-wide js-last scheduling).
5. Multi-clause selection: a relation with both `- -` and `+ -` clauses; a
   bound first arg picks the `+ -` clause (observable via clause bodies that
   yield distinguishable values).
6. Errors: no clause serves the runtime modes; `-> weight` on a js sub
   (compile error); arity mismatch (compile error); yield-cap exceeded.
7. Entanglement: a js sub touching two active terms from different `?` atoms
   merges their components.

---
Plan author: Claude Fable 5 (claude-fable-5)

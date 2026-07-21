# v2 bracket aggregation: separate the reduced variable from its output

Refactor of plans/v2-bracket-aggregation.md. Prerequisite for
plans/v2-aggregation-synonyms.md.

Today `[ Q | sum Y ]` makes `Y` do double duty: it is both the column of `Q`
being folded *and* the name the fold's result is bound to outward. The two
are conceptually distinct, and conflating them is what blocks any form of
substitution into a bracket expression. Split them:

```
[ Q | Out = op V ]
```

`V` is the query-side column being reduced — internal to `Q`, invisible
outward. `Out` is a *pattern* unified against the reduced value and visible to
the enclosing context. The bare form `[ Q | op V ]` stays legal and desugars
by **freshening the query side**: the occurrences of `V` inside the query are
renamed to a compiler-fresh `V′`, giving `[ Q[V ↦ V′] | V = op V′ ]`. `Out`
is then the plain Variable `V`, so the fold's result binds outward under the
original name — today's behavior exactly — and the disjointness rule below
holds for desugared code by construction. This is a semantics-preserving
generalization, and the existing test suite is the regression check.

```
[ p X Y | S = sum Y ]                  -- columns (X, S); Y is gone outward
[ [ at A B | L = last B ] | N = count A ]
[ p X Y | 3 = sum Y ]                  -- Out as a filter: groups summing to 3
```

`Out` may be an unbound Variable (binds), a variable already bound earlier in
the rule (filters), or a ground/compound term (filters). It unifies; it does
not assign.

## Semantics (decisions)

- `V` is unchanged: it must occur as a column of `Q` and must not be bound
  earlier in the rule.
- `Out` may filter or bind — that is the point. Its unbound variables become
  output columns of the expression.
- **Disjointness (error):** a variable of `Out` must not occur *unbound*
  anywhere in the query subtree — not as `V`, not as a column of any level,
  and not as a nested level's reduction variable. Prefix-bound variables are
  fine in both positions (they are filters either way). There is thus no
  legal way to write an `Out` variable that is also a query variable, and
  desugared code satisfies the rule by construction (`V′` is compiler-fresh).
  Consequences: the output-column list below never contains duplicates; every
  variable name in a bracket expression has exactly one role; and `matchTerm`
  at close time only ever binds an `Out` variable fresh or checks a
  bound/ground one — it never reconciles an `Out` variable with a group
  value. `V` is not in scope outward.
  **Amended during implementation:** the rule as stated above rejects code
  that plans/v2-aggregation-synonyms.md requires. `land:count X X` expands
  to `[[at A_1 B_1 | X = last B_1] | X = count A_1]`, where the outer `Out`
  variable `X` *is* a column of the outer query — it is the inner level's
  `Out`. So the check forbids an `Out` variable only in **genuine query
  positions**: an atom column at any level, or any level's reduction
  variable. Coinciding with a nested level's `Out` variable is allowed, and
  is meaningful rather than confused: the name is already in `keyCols`, so
  `matchTerm` *checks* the folded value against the group's value for that
  column instead of binding it — exactly "the location equals the count".
  The consequences below hold with that reading; in particular the output
  column list still has no duplicates, since both `aggCompOutCols` and
  `compOutCols` seed the `out` walk with the key columns already collected.

- **Output columns** of `[ Q | Out = op V ]` = (columns of `Q`) − {`V`} +
  (unbound variables of `Out`), in first-occurrence order — the disjointness
  rule guarantees the two parts never overlap, so no dedup is needed. A nested
  expression contributes *its* output columns to the enclosing query, so an
  inner reduction variable no longer leaks outward — the fix that makes this
  worth doing.
- Reduction proceeds as today (group by output-columns-of-`Q` minus `V`, fold
  `V`), then the folded value is unified against `Out`; a group whose fold
  fails to unify produces no row. `last` is the same with "the selected
  maximal derivation's `V` value" in place of the fold.
- Empty-input policy is unchanged, with `Out` unified against the
  aggregator's zero in the empty-group-key case.

## Pipeline changes

### 1. types.ts

```ts
reduce: { op: string; varName: string; out: Term }
```

### 2. parse.ts — `parseAggCompText`

Right of the top-level `|`, look for a top-level `=` (depth counted over
`(...)`/`[...]`):

- absent: parse `op V` as today and set `out = { tag: "Variable", name: V }`,
  then apply the bare-form desugar: rename `V`'s occurrences inside the comp's
  items (at this level only) to a fresh `V′` and set `reduce.varName = V′`.
  The fresh name must avoid the whole rule's used names, which
  `parseAggCompText` cannot see — so do the rename as a small pass where the
  used-name set already lives (alongside `desugarBody`'s `_dotN` minting via
  `collectUsedNames`), not inside `parseAggCompText` itself.
- present: `parseTerms` the left side into exactly one Term (`out`); parse
  `op V` from the right side with the existing checks (known op; `V` a named
  Variable, not `_`).
- Error here if `out` mentions `V`. The rest of the disjointness rule (no
  `Out` variable unbound in the query subtree) needs prefix-binding info and
  lands in `decomposeAggComp`'s validation.

Also update the `aggcomp` branch of `collectUsedNames` (parse.ts, the
`it.kind === "aggcomp"` case) to walk `reduce.out` — today it only recurses
into `it.items`. It seeds fresh-name minting, and a name occurring only in an
`out` position must not be reused. Note this fix lands on the parse-stage
`BodyItem`, not on the `AggComp` RuleAtom. `saturateAggComp` needs no
change (`out` is a value pattern, not an atom, so head arity does not apply);
`remapAggCompLines` likewise.

### 3. expand.ts — `decomposeAggComp`

The current `validateAndCollect` computes one set (all free vars of the
subtree) and uses it both as the join columns and as the result-row layout.
Those now differ. Restructure it to return, per level, the level's **output
columns** in first-occurrence order:

```
outCols(atom item) = its non-prefix-bound variable names
outCols(comp)      = (⋃ outCols(item) over items, in order) − {V}
                     ++ unbound variables of `out`, in order
```

Validate per level: `V ∈ ⋃ outCols(item)`; `V ∉ prefixSeen`; and the
disjointness rule — no variable of `out` occurs unbound anywhere in the
query subtree (as any level's column or reduction variable).

Encoding gains a slot:

```
comp := (*cq (*cq-red <op> (*fv :V) <encoded-out>) item...)
```

`out` is encoded with the existing `encodeTerm`, so an unbound variable
becomes `(*fv :name)`, a prefix-bound variable stays a Variable (the trail
substitutes its value at Emit-intern time), and ground terms pass through.
That single reuse is what gives bound-variable and ground-term `Out` for free.

The top-level `cols` term and the consumer `Match` pattern use
`outCols(topComp)` instead of the old `free` list.

**Ordering is load-bearing**: `outCols` in expand.ts and
`collectCompColumns` in comp-aggregate.ts must produce identical sequences,
since one writes the result-row layout and the other reads it. Keep the two
traversals adjacent in review, and add a test that a comp with several
columns round-trips positionally.

### 4. comp-aggregate.ts

- `CQ` gains `out: Term`; `decodeComp` expects 4 children under `*cq-red`.
- Replace `collectCompColumns` with the `outCols` recursion above. Introduce
  a separate `joinCols(cq)` = ⋃ output columns of its items, in order —
  these are the columns of what `joinItems` returns. `keyCols = joinCols −
  {V}`.
- `reduceRows`:
  - group by `keyCols` (unchanged), fold `V` (unchanged); the count/sum
    pre-fold set-semantics dedup stays on `joinCols` — it deduplicates
    *query bindings*, and today's `cols` equals `joinCols`, so this is
    unchanged in substance even though the `cols` name is being repurposed;
  - build the result row from `keyCols` only, then
    `matchTerm(store, cq.out, foldedValue, vals, undo)`; on failure, drop the
    group. `matchTerm` already handles `*cq-any`, `(*fv :name)` bind/check,
    and structural descent, so all three `Out` shapes work through one call.
  - `last`: same, unifying `out` against the selected derivation's `V` value;
    dedup on output columns rather than on `cols`. Note the consequence: two
    maximal derivations differing only in a non-output column collapse to one
    row — that is the intended set semantics, not an accident.
  - empty input: unchanged branches, with `out` unified against
    `aggregator.zero` in the empty-key case (a failed unification there means
    no rows).
- `joinItems`' comp branch needs no change: a nested comp's rows now carry its
  output columns, and `V` is already absent from them.

### 5. print-ir.ts

Print `AggComp [items | <out> = <op> ?<V>]`. Keep the bare form when `out` is
the Variable `V`, so existing IR-diff expectations stay readable.

### 6. Tests

Extend `ts/src/tests/v2_bracket_agg.test.ts`:

- **Regression is the main assertion**: every existing case must pass
  unchanged — the bare-form desugar (fresh `V′` on the query side, `V` as
  `Out`) is observationally identical to today's behavior.
- Distinct output variable: `[ p X Y | S = sum Y ]` binds `S`, and `Y` is
  *not* bound after the expression (a later atom mentioning `Y` sees a fresh
  unbound variable).
- Nested non-leaking: `[ [ p X Y | S = sum Y ] | N = count X ]` — the inner
  `Y` does not become a column of the outer query.
- Bound `Out` as a filter: `q S, [ p X Y | S = sum Y ]` keeps only groups
  whose sum is the bound `S`.
- Ground `Out`: `[ p X Y | 3 = sum Y ]`; and a compound `Out` pattern.
- Empty input with a bound/ground `Out` (unification against zero).
- All-filter expression with **zero output columns**
  (`[ q X | 3 = count X ]`): the result row is a zero-term Atom — nothing
  today emits or matches an empty row atom, so assert both the nonempty and
  empty-input behavior explicitly.
- Errors: `Out` mentions `V`; an `Out` variable that is also a query column
  (or a nested level's reduction variable) — the disjointness rule; `V` bound
  earlier; `V` not a column of `Q`.
- Column-order round-trip with ≥3 output columns.

### 7. Docs

Update `ts/src/v2/overview.md` (parse, expand, comp-aggregate sections and the
types key-terms list) and add a note to plans/v2-bracket-aggregation.md
pointing here, since that plan's `reduce` shape and column rules are
superseded.

## Out of scope

- Multiple reductions in one bracket (`[ Q | S = sum Y, N = count Y ]`).
- Reducing a compound expression rather than a single column.

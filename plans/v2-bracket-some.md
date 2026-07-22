# v2 bracket aggregation: the `some` / `none` existence reductions

## Goal

Add two reduction ops to bracket aggregation `[ Q | ... ]`, alongside
`count`/`sum`/`last`: the existence reduction `some` and its negation `none`.
`some` is the bracket-level counterpart of the `bool` schema aggregator, but with
two differences that make it a *guard* rather than a value-producing fold:

- **No output pattern.** The syntax is only `[ Q | some V ]` — never
  `[ Q | Out = some V ]`. `some` produces no folded value, so there is nothing
  for an output pattern to receive.
- **Its variable is eliminated from scope.** `some V` removes `V` from the
  result-row layout and binds nothing in its place, so:
  - `[ p X | some X ]` binds nothing — a pass/fail guard: it succeeds iff at
    least one `p X` tuple exists in scope, and binds no variable outward.
  - `[ p X Y | some Y ]` binds only `X` — one binding of `X` per group for which
    some `Y` exists.

Empty input is *false*: unlike `count`/`sum` (which emit a zero row for an empty
group key), `some` over nothing produces no result row, so the guard fails.

`none` is the exact negation of `some`: it succeeds (emits one result row that
binds nothing) precisely when `some` would fail — i.e. when the query has no
derivations at the anchor. Because a negated query has no bindings to group by,
`none` **binds nothing at all**: it forbids any leftover group column, so every
query variable must be the reduction variable or bound before the aggregate.
This supports the two natural forms:

- `[ p X | none X ]` — a guard that passes iff there is no `p X`.
- `monster X` then `[ it:at X L | none L ]` — with `X` prefix-bound (substituted
  into the query, not a group key), passes for each monster with no location.

`some` and `none` partition: for a given prefix binding, exactly one fires.

## Design

`some` reuses the entire existing bracket-aggregation pipeline. The reduction is
represented as `{ op: "some", varName: V, out: Wildcard, bare: false }`:

- `out` is a `Wildcard`, which the term encoder already lowers to the `*cq-any`
  sentinel. `*cq-any` contributes no output column (`collectFvs`/`noteFreeVars`
  ignore it) and always unifies in `matchTerm`. So the output columns are exactly
  `joinCols − {V}`, and unifying the (irrelevant) folded value against `out`
  always succeeds and binds nothing.
- No freshening (`bare: false`). Because `out` carries no variable name, there is
  no output-name/query-column collision to avoid — the collision the bare
  `count`/`sum`/`last` freshening exists to prevent. `V` is a plain query column,
  removed from the output layout, so it never leaks; the usual reduction-variable
  checks (`V` occurs in the query and is not prefix-bound) apply unchanged.

`none` shares the same representation (`out` = `Wildcard`, no freshening); it
adds one static check (no leftover group column) and inverts the reduction:
`rows.length === 0` → one empty row (succeed), else no rows (fail). This is the
same zero-output-column path the existing `[ q X | z = count X ]` emptiness guard
already uses, so it inherits that path's stratification behavior — `none` is
ergonomic sugar for a count-emptiness test, not new evaluation semantics.

`some`/`none` are deliberately **not** added to the aggregator registry, so they
stay bracket-only and are not exposed to `#agg`/`#reactive` (which keep `bool`).

## Changes

- `parse.ts`: add `some`/`none` to `AGG_COMP_OPS`; in `parseAggCompText`, reject
  an output pattern for them and set `out` to a `Wildcard`.
- `expand.ts` (`aggCompOutCols`): reject a non-empty output column list for
  `none` (it binds nothing). Otherwise no change — `decomposeAggComp` already
  handles a `Wildcard` `out` via `noteFreeVars`/`encodeTerm`.
- `comp-aggregate.ts` (`reduceRows`): skip the registry lookup for `some`/`none`;
  `some` emits one row per non-empty group (empty input → no rows, like `last`);
  `none` emits one empty row on empty input and no rows otherwise.
- `print-ir.ts`: render `some`/`none` as `[ Q | op ?V ]` (no `_ =` prefix).
- Tests in `ts/src/tests/v2_bracket_agg.test.ts`; overview note in
  `ts/src/v2/overview.md`.

# Plan: `constrain-aggregate` node

A `!` atom whose body is weighted (`! foo C -> w`) should evaluate as an
aggregate at constraint-query time: take the tuples whose interval *contains*
the constrain-aggregate's interval (just like `_do-agg`), fold them per the
relation's declared aggregator, and use the resulting value(s) as the
substitution for active vars / weight slot in the wrapped pattern. No
`_do-agg` / `_agg-result` rows are inserted into the store.

## 1. Surface syntax & parse (`v2/parse.ts`)

- Extend the marker→aggregate promotion at `parse.ts:491`: also promote
  `marker === "constrain" && weight !== undefined` to a new marker
  `"constrain-aggregate"`.
- No grammar change beyond that — `! foo C -> w` already tokenizes.

## 2. Types (`v2/types.ts`)

- Add `"constrain-aggregate"` to the `Marker` union.
- Reserve a new internal head symbol `_constrain-agg`.
- Add it to `INTERNAL_HEADS` in `timeline.ts:97` and to the reserved-name
  comment in `parse.ts:481`.

## 3. Expand (`v2/expand.ts`)

- In the endpoint switch (`~line 474`), give `"constrain-aggregate"` the same
  `l = fresh moment, r = top` treatment as `"constrain"` — same temporal
  semantics ("from this point onward, top-relative").
- In the wrap section (`~539`), wrap as
  `(_constrain-agg wrappedFreePattern idTpl)`. The wrapped pattern uses the
  same `freeify` rule as `decomposeAggregate` (`expand.ts:395`): variables
  not in `prefixSeen` and `Wildcard`s become `_free`; weight slot included
  as the trailing position. Active vars introduced by the choice naturally
  end up in the wrapped pattern as `_free` placeholders, just like
  `_do-agg`.
- Do **not** emit a paired `_agg-result` Match — there is no consumer;
  active terms get bound by the constraint-query enumerator instead.
- Skip the universal trailing-id paired-Match (no consumer needs chain
  recovery).

## 4. Shared aggregation core

Extract the candidate-collection + grouping + fold from `closeDoAgg`
(`scheduler.ts:171–270`) into a helper:

```
aggregateOver(store, wrapped, l, r, schema)
  -> Array<{ filledTerms: Term[], weight: Term }>
```

Same `intervalContains`, same `containsFree` / `matchFreePattern`, same
`last`-vs-`sum/count` branch, same empty-group rules. `closeDoAgg` becomes
a thin wrapper that converts the result list into `_agg-result` emits.

## 5. Constraint-query integration (`v2/constraint-query.ts`)

- `gatherConstrainRows`: also iterate
  `candidatesByHead(store, "_constrain-agg")` and tag each `ConstrainRow`
  with `kind: "plain" | "agg"`. Continue to filter by `touched.size > 0`
  (same as plain constrain): an agg-constrain mentioning no active var is
  dropped, just like today's plain case.
- Thread the `schema` map through `computeComponents` (callers in
  `fixpoint.ts` already have `expanded.schema`).
- In `runComponent`'s `go(rowIdx, sub)`:
  - **plain row** (existing): unchanged.
  - **agg row**: call
    `aggregateOver(store, row.wrapped, row.l, row.r, schema)`. For each
    `{ filledTerms, weight }` produced, structurally unify the wrapped
    pattern positions against `[...filledTerms, weight]` via the existing
    `matchTerm` (so `_free` slots that were originally active vars get
    bound in `trial`). Recurse `go(rowIdx + 1, trial)` per result.
- Empty results → that branch contributes no options, matching
  `closeDoAgg`'s `last` empty-group behavior. `sum`/`count` with no key
  positions still yields one zero-row option.
- `last` with multiple maximal candidates → multiple results from
  `aggregateOver`, so the component multiplies options accordingly (mirrors
  how `_agg-result` emits multiple rows today).

## 6. Schema requirement & errors

Same check as `closeDoAgg`: head sym must have a `% rel … -> agg` schema;
reuse the existing missing-schema error message.

## 7. Scheduling concern

Component options are computed at quiescence after all `_do-agg` rows have
been closed, so any candidates the agg-constrain wants to read are already
in the store. Add an assertion in `computeComponents` that no `_do-agg`
rows remain blocked when an `_constrain-agg` row is evaluated, to catch
ordering regressions.

## 8. Tests (`ts/src/v2/tests/`)

- Fixture: choice `? N` constrained by `! score N -> N` against a few
  asserted `score k -> v` rows; verify option set equals `{sum of v's}`
  rather than overlap-of-individuals.
- `last` variant: multiple maximal candidates → multiple options.
- Empty-fringe interaction: `! score N -> N` with no `score` tuples →
  component yields no options for `last`; sum/count with no free key
  positions yields the zero option.
- Group-by case: free key position alongside an active weight var.

## 9. Files touched (rough)

- `ts/src/v2/parse.ts` — marker promotion (~5 lines)
- `ts/src/v2/types.ts` — `Marker` union
- `ts/src/v2/timeline.ts` — `INTERNAL_HEADS`
- `ts/src/v2/expand.ts` — new marker case + wrap (~30 lines)
- `ts/src/v2/scheduler.ts` — extract `aggregateOver` helper
- `ts/src/v2/constraint-query.ts` — gather + per-row dispatch (~40 lines)
- `ts/src/v2/fixpoint.ts` — pass `schema` into `computeComponents`
- new tests under `ts/src/v2/tests/`

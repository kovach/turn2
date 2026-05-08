# Aggregate blocking — sub-plan of redo-choice

## Approach: rule-split into producer + consumer; no firing identity

Same shape as v1: a rule containing a weighted match is split at the
match into a *producer* rule that emits a `do-agg` row and a
*consumer* rule that reads the corresponding `agg-result` row. The
inner fixpoint loop knows nothing about aggregates — it just runs
rules. The outer loop is the only thing that closes aggs.

This avoids the firing-identity problem from the previous draft:
firings aren't paused mid-rule. The "paused agg" lives in the store
as a `do-agg` row. Re-running the producer rule on later passes is
idempotent because `do-agg`'s `aggId` is constructed deterministically
and dedup'd.

## Term shapes

Mirroring the choice/constrain shapes (see redo-choice plan):

- `do-agg <aggId> (foo X)` — emitted by the producer half of a split
  rule. `aggId` is `(*agg <ruleName> <position> ...boundVarValues)`
  hashconsed. The wrapped atom `(foo X)` is the weighted-match
  pattern with bindings substituted in. The row's *interval* equals
  the firing's anchor at the weighted-match position.
- `agg-result <aggId> N` — emitted by the scheduler when it closes
  the agg. `N` is the aggregated value; for `last`, multiple
  `agg-result` rows may be emitted (one per maximal candidate).
  Interval matches the `do-agg`'s.

`do-agg` and `agg-result` are reserved head syms; user rules cannot
emit them directly.

## Rule splitting

For a rule body `... weighted-match foo X -> N ; rest`:

- **Producer rule**: original prefix, then `^ do-agg <aggId> (foo X)`
  (anchor-matching emit; the row inherits the firing's anchor as its
  interval).
- **Consumer rule**: original prefix, then a literal-moment match
  against the producer's `do-agg` row (so the consumer only sees the
  *same* firing's emission), then `agg-result <aggId> N`, then `rest`.

The literal-moment threading is the same mechanism the existing
plan uses for splitting `~`/`+` (`lLit`/`rLit` on `RuleAtom`).

A rule with multiple weighted matches splits into more pieces
recursively — same recursion as v1.

This is a real change to `ts/src/v2/expand.ts`, which is currently a
stub identity function.

## Outer loop

```
inner(): run all rules until store size is stable
        (size = tuples.length + edgeSet.size)

inner()
loop:
  blocked = (do-agg rows with no matching agg-result)
          ∪ (choose rows with at least one unresolved active term)
  if blocked empty: status = "done"; break
  earliest = selectEarliestTier(blocked)
  aggsInTier = earliest filtered to do-agg rows
  if aggsInTier non-empty:
    for each row in aggsInTier:
      compute aggregate value(s) over store; emit agg-result row(s)
    inner()           # new agg-results may unblock consumer rules
    continue
  else:               # earliest is all choices
    components = computeComponents(constrain rows, choose rows)
    status = "active-choices"; break
```

The inner loop does not know about aggs; it just runs rules to
quiescence under the current store.

`selectEarliestTier` ranges over interval-bearing things. For a
`do-agg` row the interval is the row's stored interval. For a
`choose` row likewise. The `prior` relation is the moment-order
analog defined in the redo-choice plan.

## Computing the aggregate

Closing a `do-agg <aggId> (foo X)` row at interval `(l, r)`:

1. Schema lookup: `% foo -> sum|count|last`.
2. Gather `foo X -> w` tuples whose interval *contains* `(l, r)`,
   with `X` consistent with the wrapped atom's bindings.
3. Fold per the schema function, or emit per maximal element for
   `last`.
4. Emit `+ agg-result <aggId> <value>` per result. (Interval: same as
   the `do-agg`'s; consumer rule's literal-moment match enforces
   match.)

Empty reductions: `count`/`sum` emit zero; `last` emits no
`agg-result` row, which means the consumer rule can never match —
correctly modelling "fail the firing".

## Idempotence

- `aggId` is deterministic in `(ruleName, position, boundVarValues)`,
  so re-running the producer always emits the same `do-agg` row;
  dedup makes it a no-op.
- The scheduler emits `agg-result` rows that depend only on the
  current store contents at close time. The condition "no matching
  `agg-result`" is the only gate for closing again, so closing is
  itself idempotent.

## Files touched

- `ts/src/v2/expand.ts` — replace stub with rule-splitting at
  weighted-match boundaries. Threads literal-moment info on the
  consumer side.
- `ts/src/v2/types.ts` — drop the in-eval `weight` query path's
  reliance on `evalWeightedMatch` returning a value; weighted match
  becomes a producer-side `do-agg` emit.
- `ts/src/v2/eval.ts` — remove `evalWeightedMatch` aggregation logic.
  The producer-side weighted match becomes an ordinary `^` emit of a
  `do-agg` row with the wrapped pattern atom.
- `ts/src/v2/scheduler.ts` (new, also from redo-choice) — scans for
  `do-agg`/`agg-result`/`choose`/`constrain`/`is` rows; runs
  `selectEarliestTier`; closes earliest aggs.
- `ts/src/v2/fixpoint.ts` — outer loop above.

## Tests

- Producer rule and consumer rule, registered in either order: the
  consumer's weighted query sees all producer tuples regardless of
  iteration order (currently fails).
- Two consumers at different anchor scopes: each aggregates over its
  own enclosing window; the inner one fires first.
- Empty `count`/`sum` returns zero; empty `last` blocks the firing
  (no agg-result, consumer never matches).
- Agg whose anchor is enclosed by a `choose`-row anchor: agg fires
  before the choice surfaces.

## Open items

- Reserved head syms — `do-agg`, `agg-result`, `choose`, `constrain`,
  `is` should all be reserved against user emission. Worth adding a
  parser pass that rejects user rules with these as the *outermost*
  head sym. (User rules can still mention `(foo bar)` nested inside,
  e.g. as the wrapped atom of a constrain.)
- Schema lookup semantics for an aggregator whose head sym appears in
  no schema decl — error at expand time vs. at close time. Default:
  expand time, since splitting needs to know whether the atom is
  weighted.

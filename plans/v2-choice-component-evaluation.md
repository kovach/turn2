# Choice component evaluation at a canonical moment

## Goal

When evaluating a choice component (the per-component conjunctive query in
`ts/src/v2/constraint-query.ts`), evaluate every `_constrain` / `_constrain-agg`
row against a single canonical moment `M` shared across the component, rather
than each row using its own stored interval `[row.l, row.r]`.

`M` is defined as `leastUpperBound(store, [row.l for row in component])` — the
LUB of every constrain/constrain-agg row's left endpoint in the component
(see [[v2-moment-lub]]).

## Why

Today, plain rows filter candidates by `intervalsOverlap(row.l, row.r, cand.l, cand.r)`
and agg rows fold candidates whose interval contains `[row.l, row.r]`. When
several `_constrain` rows in one component live at different moments, the
per-row filters can each admit candidates that don't coexist at any single
moment, yielding spurious option tuples.

A canonical `M` makes the semantics of a component crisp: "the unique moment
at which the user is being asked to choose"; every constraint is interpreted
at `M`.

## Behavior change vs today

Even for single-row components, the admission rule changes (asymmetrically
between plain and agg):

- **plain** rows: old `intervalsOverlap(row.l, row.r, cand.l, cand.r)` →
  new `intervalContains(cand.l, cand.r, M, M)`. With single-row `M = row.l`,
  the new rule additionally requires `cand.l ≤ row.l`. **Strictly stricter**
  than today: a candidate starting *after* `row.l` but still overlapping
  `[row.l, row.r]` is admitted by old, rejected by new.
- **agg** rows: old `aggregateOver(..., row.l, row.r, ...)` (cand ⊇
  `[row.l, row.r]`) → new `aggregateOver(..., M, M, ...)` (cand ⊇ `{M}`).
  With single-row `M = row.l`, the new rule drops the `cand.r ≥ row.r`
  requirement. **Strictly weaker** than today: a candidate ending inside
  `[row.l, row.r]` is rejected by old, admitted by new.

This is intentional — `M` is *the* moment the choice happens at; `row.r`
was always a stale upper bound. But it does mean the change is more than
"consolidate multiple rows into one"; expect some single-row behavior to
shift too.

## Algorithm

In `runComponent` (ts/src/v2/constraint-query.ts:190):

1. Collect `lefts = comp.rows.map(r => r.l)`.
2. Compute `M = leastUpperBound(store, lefts)`.
   - The moment graph is a lattice (see `notes/moment-insertion.md`:
     every moment is introduced by subdivision, which preserves
     lattice-ness from the initial `bot < top` chain), so `M` is
     guaranteed non-null whenever the component has at least one row.
     If `M === null`, `throw` with "moment graph invariant violated —
     expected lattice"; this is a defensive assertion, not an expected
     code path.
3. For each row in the component, evaluate against `M`:
   - **plain**: replace `intervalsOverlap(store, row.l, row.r, cand.l, cand.r)`
     with `intervalContains(store, cand.l, cand.r, M, M)` — i.e. `M` lies
     within the candidate's interval.
   - **agg**: in `runAggRow`, replace the `row.l, row.r` passed to
     `aggregateOver` with `M, M`. `aggregateOver` already filters to
     tuples whose interval *contains* `[l, r]`; with `l = r = M` this
     reduces to "tuples that contain `M`".

Only `row.l` is still used (as LUB input). `row.r` is no longer read by
anything — drop it from `ConstrainRow` in `gatherConstrainRows`.

If the component has zero rows, `runComponent` is unreachable (the
empty-fringe check above intercepts it). Assert this with a `throw` rather
than calling `leastUpperBound([])` (which would return `bot` and yield
nonsense admissions).

## Implementation notes

- Lives in `ts/src/v2/constraint-query.ts`. Drop `r` from `ConstrainRow`
  and from the `gatherConstrainRows` constructor; only `l` is needed.
- `runComponent` gains a `momentM: Term` parameter computed by the caller
  (`computeComponents`) once per component; passed through to `runAggRow`.
- Add `intervalContains` and `leastUpperBound` to the imports from
  `./store.js` (both already exported).

## Return value & host contract

No change to `ComputeComponentsResult`. The defensive `throw` on a `null`
LUB is unreachable under the lattice invariant; if it ever fires, the bug
is in moment insertion, not in choice evaluation.

## Existing tests

`v2_ttt.test.ts` and `v2_constrain_agg.test.ts` test 5 are the existing
tests most likely to shift behavior:

- **`v2_ttt.test.ts`** explicitly tests "constraint-query interval scoping"
  via the 9 → 8 → 7 eligible-option counts. The new "cand.l ≤ M"
  requirement for plain rows could change which `eligible` facts are
  admitted per turn.
- **`v2_constrain_agg.test.ts` test 5** (`at e -> last` with `~a; ~a'; ~b`)
  could newly admit contributions whose interval ends inside `~b`,
  changing the `last`-aggregated set.

`v2_choice.test.ts` tests 3–7 all rely on top-level `+ cell …` facts whose
interval has `cand.l = bot`, so `cand.l ≤ M` is trivially satisfied; they
should be unaffected.

If any existing test fails after the change, **pause and surface the
diff** rather than committing to a fix — the failure tells us whether the
new admission rule matches the intended semantics.

## New tests

Add to existing constraint-query test file (or a new one if none exists):

- **Single moment, multiple rows.** All rows share `l`; behavior unchanged
  from today's per-row evaluation. Regression check.
- **Different moments, comparable.** Two rows with `r1.l < r2.l`; `M = r2.l`.
  Candidate that overlaps `r1` but does not contain `r2.l` is correctly
  excluded under the new rule (would have been admitted by the old per-row
  overlap rule).
- **Different moments, LUB is a third moment.** Rows at incomparable `l_a`,
  `l_b` with a common descendant `m`; component evaluates at `m`. (The
  subdivision-only construction means `m` must already exist whenever
  `l_a` and `l_b` are both reachable from a shared ancestor — in fact
  the lattice gives uniqueness for free.)
- **Agg row at a different moment.** `_constrain-agg` and `_constrain` rows
  in one component at different lefts; the agg fold restricts to tuples
  containing `M`.
- **Mixed with [[v2-earliest-tier-choices]]:** an entangled component that
  pulled in a later-tier choose via a constrain edge — verify the chosen
  `M` reflects the entangling constrain's `l`, not the seed choose's.

## Out of scope

- Recomputing `row.l`/`row.r` themselves; the LUB only changes evaluation,
  not the stored intervals.
- Using the LUB for any anchor-narrowing inside `expand.ts` (tracked
  separately under "Next steps" of [[v2-moment-lub]]).
- Handling `_constrain-agg` rows whose schema aggregator is non-commutative
  and intersects across moments — orthogonal; today's `aggregateOver`
  already linearizes via `before`/`prior`, and we trust it to do the right
  thing once given the right interval.

## Open questions

- Does `M` need to be reachable (`tokenOf(store, M) ∈ store.momentTerms`)?
  `leastUpperBound` already only returns terms it recovered from
  `momentTerms`, so this is guaranteed.

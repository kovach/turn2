# v2 semi-naive evaluation

Port the v1 semi-naive scheme (`plans/seminaive.md`, `expand.ts:507`,
`unify.ts:152`, `step.ts`, `fixpoint.ts`) to the v2 evaluator. v2 already
dedups tuples on `(atom, l, r)` (`store.ts:98`) and fresh moments are
deterministic functions of rule + bound vars (`eval.ts:336`), so re-derivations
are silently dropped today. Semi-naive is therefore a *performance* change,
not a correctness change: each round, every match-position should see only
delta tuples in exactly one rule variant, instead of every rule re-enumerating
every prior tuple at every position.

## Scope

- Applies to `match` atoms only. v2's IR has a single match-like leaf
  (`evalMatch` in `eval.ts:112`); `assert`, `agg`, `ask`, `constrain`
  are positive and not delta-filtered.
- Order edges (`addOrder` / `edgeSet`) are not gen-tracked. Adding a new
  edge does not retrigger rules through the delta machinery; the existing
  inner loop's quiescence test handles those.
- Aggregate folds reset the round boundary, matching v1.

## Plan

### 1. Generation stamp on tuples

- `Store` (`ts/src/v2/store.ts`): add `iteration: number` (current round,
  bumped by the inner/outer loop) and either a `gens: number[]` parallel
  array or a `gen` field on `Tuple`. Parallel array preferred, to avoid
  changing the public `Tuple` shape.
- `addTuple`: on insert, push `store.iteration` into `gens`.
- Initial value: `iteration = 1` to match v1.

### 2. Match constraint annotation

- `ts/src/v2/types.ts`: add `MatchConstraint = "any" | "delta" | "old"`
  and a `constraint?: MatchConstraint` field on the `match`-marker
  variant of `RuleAtom`. `undefined` means `"any"` (back-compat for
  ad-hoc rule construction in tests).

### 3. Delta variant generation

- `ts/src/v2/expand.ts`: add `generateDeltaVariants(rule)` that
  - counts match atoms in `rule.body`,
  - returns `[rule]` if the count is 0,
  - otherwise emits one variant per match position `j`, with constraints
    `< j → "old"`, `=== j → "delta"`, `> j → "any"`.
- Apply at the end of `expand` so the returned `Program.rules` is the
  flattened delta-variant list. The scheduler/eval don't need to know
  variants apart from the per-atom constraint.
- Rule name: append `#dN` to the rule name for diagnostics.

### 4. Per-candidate filter in `evalMatch`

In the candidate loop of `evalMatch` (`eval.ts:116`), immediately after
fetching `gen = store.gens[idx]`, apply the bucket filter:

- `"delta"`: keep only `gen === iteration - 1` (strict — exactly one
  round's insertions; this is what guarantees each new derivation is
  reached by exactly one variant per round).
- `"old"`:   keep only `gen < iteration - 1`.
- `"any"`:   no filter.

Note: this departs from v1's strict three-bucket scheme. v1 also
excluded `gen === iteration` from `any`/`old`, hiding within-sweep
inserts. v2's evaluator already permits within-sweep cascade
visibility (rule N+1 in a sweep sees what rule N just asserted), and
forcing strict semantics costs ~60% more rounds on ttt-scale fixtures.
We keep `delta` strict so the variant scheme still partitions new
derivations across one iteration, but loosen the other two buckets so
existing programs converge in the same iteration count as before.

### 5. Iteration bumping

- `ts/src/v2/fixpoint.ts`:
  - `innerLoop`: bump `store.iteration` once per sweep (after running
    every rule, before re-checking quiescence). The current `before/after`
    `storeSize` test stays — replacing it with a `changed` flag is a
    nice-to-have but out of scope.
  - `runLoop`: after a successful `closeDoAgg`, bump `store.iteration`
    so newly emitted agg-result rows become the next round's `delta`.
    This matches v1's `iteration++` after `closeAggregates`
    (`fixpoint.ts:80`).

### 6. Tests

- Adapt the v1 semi-naive tests (`ts/src/tests/...`) to the v2 surface
  if there are direct ones; otherwise just rerun the existing v2 suite
  and confirm no regressions.
- Add a focused test that asserts: for a rule with two matches, after a
  first inner-loop sweep produces one new tuple, the second sweep fires
  the rule with that tuple in the `delta` slot (and only that slot per
  variant). Inspect via tuple counts or a counter hooked into
  `evalMatch`.
- Performance smoke check on `ts/data/v2/ttt.t`: tuple count unchanged;
  iteration count unchanged or lower; per-iteration match-candidate
  visits should drop substantially.

## Open questions / ambiguities

- **Where to bump `iteration` in the inner loop.** v1 increments after
  each sweep that produced a change; we could match that exactly, or
  always bump and live with empty-delta rounds (no-op cost). Matching
  v1 is safer.
- **Edge insertions as deltas.** Today `addOrder` doesn't participate
  in the delta machinery. If any rule's match set depends on a newly
  derived `lessThan` (via `intervalsOverlap`), semi-naive could miss
  matches *within an iteration* — but the inner loop will retry next
  sweep with `"any"` constraint on that match position, so it's at
  worst a one-iteration delay, not unsoundness. Worth a comment in
  `evalMatch` and maybe a follow-up plan if it turns out to matter.
- **`Program.schema` use after expansion.** The schema is currently
  read in `closeDoAgg`; expanding to N variants doesn't change schema
  identity. Worth a sanity check that nothing keys off `Program.rules`
  length.
- **Reporting.** `iterations` in `FixpointResult` currently counts
  inner sweeps; with delta variants the per-sweep cost drops but the
  sweep count is roughly unchanged. No reporting change needed, but
  callers comparing iteration counts pre/post should be aware.

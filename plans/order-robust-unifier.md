# Order-robust unifier

## Goal

Decouple the unifier's correctness from `lower.ts`'s emission order. Today
the unifier silently relies on several positional invariants of the
constraint list (e.g. "the parent's `Match` precedes its child's
`IntervalRel{contains}`"). Reordering by even a single swap in `lower.ts`
can produce wrong answers or runtime errors, even though the IR itself
has no documented order requirement.

We want: the unifier produces the same solution set for any *semantically
equivalent* permutation of the constraint list, and either (a) handles all
orderings directly or (b) deterministically renormalizes the list before
walking it. Wrong orderings (e.g. an edge whose endpoints aren't yet
ids of any row) become explicit errors rather than silent miscompiles.

## Current implicit invariants

Listed so the plan has something concrete to dismantle. Each is an
assumption the unifier makes that *isn't* part of the IR's stated contract.

1. **Match precedes its IntervalRel.** `checkIntervalRelBound` requires
   both endpoints to substitute to non-`Variable`. For `before:after`,
   `overlap`, and `prior`, lowering ordering is the only thing that
   guarantees this — the unifier has no enumerator for those kinds.
2. **Matching prefix precedes assertion suffix.** `unifyConstraintsAt`
   triggers `visit(suffixStart)` the first time it sees a positive
   constraint and stops walking matching. An interleaved list would skip
   matching constraints that come after a positive.
3. **Within the suffix, an `Assert` precedes any `AssertIntervalRel`
   referencing its id.** `runAssertIntervalRel` does
   `hasNode(reference, …)` and silently returns when the row is absent.
   This isn't a unifier invariant, it's a `refstore.ts` implementation
   detail: `addParentChild` requires both endpoint rows to exist
   because it eagerly updates `children: Map<NodeId, NodeRow[]>`, which
   stores `NodeRow` *references*. Make `children` id-keyed and the
   ordering requirement disappears entirely — see "Phase 2" below.

4. **Equal precedes (or is unordered with) the Match that uses its
   binding.** Actually robust today via the trail — leaving as a baseline.

## Design

The IR is conjunction-shaped with two declared phases: a `matching`
list and an `assertions` list. Both are physically arrays — the
unifier treats them as unordered for correctness, but emission order
is preserved as a stable tie-break for the scheduler's selection
policy and for output reproducibility.

### Phase split is explicit

Replace the positional `[matching..., assertion...]` flat list with a
two-field IR shape:

```ts
export interface TurnExpr {
  matching: Constraint[];
  assertions: PositiveConstraint[];
}
```

The unifier never has to scan for `isPositiveConstraint`. `visit()` fires
when `matching` is exhausted, and the suffix is dispatched in phase 2
under a separate ordering policy.

This subsumes invariant #2 by construction.

### Each constraint declares its readiness

Define `ready(c, boundVars): Mode`, returning one of:

- `"check"` — every term `c` references is bound; the constraint is a
  yes/no test against the store.
- `"enumerate"` — at least one term is unbound, but the constraint can
  iterate candidates that satisfy it (e.g.
  `IntervalRel{contains, bound, unbound}` enumerates descendants).
- `"blocked"` — the constraint cannot be evaluated yet without
  enumerating against an effectively unbounded set; defer until more
  bindings appear.

For each kind:

- `Match` — always `enumerate` if `id` is unbound (iterate symbol-index
  bucket / `allCandidates`); `check` if `id` is bound (single-row
  lookup).
- `IntervalRel{contains, a, b}` — `check` if both bound, `enumerate`
  forward (descendants of `a`) or backward (ancestors of `b`) if exactly
  one is bound.
- `IntervalRel{before:after, a, b}` — same shape; enumeration walks the
  lifted closure of `beforeAfter` from the bound side. (Implementation
  effort: see "Open work" below.)
- `IntervalRel{overlap, a, b}` — symmetric; enumeration is descendants
  of the bound side filtered by `overlap`.
- `IntervalRel{prior, a, b}` — `check` only for now; document and throw
  if reached in `enumerate` mode (only used by aggregate-fold scheduling
  today, never with unbound endpoints).
- `Equal{lhs, rhs}` — `check` if both are ground or unify directly;
  otherwise `enumerate` over the trivial single binding (i.e. just
  `unifyTerms`). It's never `blocked` — `unifyTerms` handles every
  combination.

### Scheduler

`unifyConstraintsAt` becomes a small fixed-point loop:

```
loop:
  pick a constraint whose readiness is "check" or "enumerate"
  if "check":   evaluate; on success drop it from the set, continue loop
  if "enumerate": iterate candidates; for each, push trail, recurse, unwind
  if no constraint is ready and the set is non-empty: programmer error
```

Selection policy (correctness is independent of policy; the policy is a
perf knob):

1. Prefer `check` over `enumerate`. Checks prune cheaply and never
   branch.
2. Among `enumerate` choices, prefer the one with the smallest
   estimated candidate count: compare `index.get(headSymbol)?.length`
   for `Match`, `descendantsOf(parent).size` for `IntervalRel{contains}`,
   etc. This is what gives us the "pick the smaller iterator" behavior
   the user flagged as the perf reason for keeping ordering visible to
   the unifier.
3. Among ties, prefer the constraint earliest in the (array-shaped)
   matching list. Emission order serves as a stable tie-break — cheap,
   deterministic, no extra metadata.

This costs one selection pass per constraint resolved — `O(n²)` worst
case where `n` is the per-rule constraint count, which is small (a
handful per rule body). Acceptable.

### Enumerators for every IntervalRel kind

Until enumeration exists for `before:after` and `overlap`, the unifier
is order-robust only for `contains` — those kinds still require their
`Match` to run first. To close invariant #1 fully, implement
enumeration for both kinds, with caching mirroring `descendantsCache`.

#### `before:after` enumeration

Lifted definition: `beforeAfter(a, b)` holds iff some ancestor-or-self
of `a` reaches some ancestor-or-self of `b` via one or more
`before:after` edges (see `refstore.ts`).

For *predecessors of `b`* (enumerate `a` given bound `b`):

1. Compute `bAncestors = ancestorsOf(b)`.
2. From each `x ∈ bAncestors`, walk *backward* via `afterBefore` to
   collect the set `R` of nodes reachable.
3. Predecessors = `R ∪ descendantsOf(r) for r ∈ R` (lift through
   containment on the `a` side, mirroring how `beforeAfter()` lifts
   through ancestors of `a`).

For *successors of `a`* (enumerate `b` given bound `a`): symmetric —
ancestors of `a`, walk forward via `beforeAfter`, lift through
descendants on the `b` side.

Cache shape: two `Map<NodeId, Set<NodeId>>` on the store —
`predecessorsCache` and `successorsCache` — populated lazily on first
query. Maintenance: monotone (edges and rows are never removed), so an
edge or row insert only needs to extend each cached entry whose set
already contains the affected end.

#### `overlap` enumeration

`overlap(a, b)` holds iff `∃ c. contains(a, c) ∧ contains(b, c)` —
they share a descendant (including either end being a descendant of the
other).

For *overlap candidates of `b`* (enumerate `a` given bound `b`):

1. `bDescendants = descendantsOf(b)`.
2. For each `c ∈ bDescendants`, collect `ancestorsOf(c)` — these are
   the nodes that contain `c`, i.e. all candidate `a`s.
3. Union the results.

Already-bound case is symmetric since `overlap` is symmetric in its
arguments.

Cache shape: `overlapsOf: Map<NodeId, Set<NodeId>>`. Lazy; same
monotone-update story.

#### `prior` enumeration

`prior(a, b) = beforeAfter(a, b) ∨ contains(b, a)`. Enumerator =
union of the two underlying enumerators. No new cache needed.

### Phase 2 (assertions): just iterate

Make `addParentChild` id-pure (re-key `children` from
`Map<NodeId, NodeRow[]>` to `Map<NodeId, NodeId[]>`, drop the
"endpoint rows must exist" check). After that, the suffix is one
unordered loop:

```
for c in te.assertions:
  dispatch(c)  // insertRow | addParentChild | addBeforeAfter
```

Each op is idempotent and id-only. Order doesn't matter.

### RefStore equality for tests

Tests that compare engine output today materialize the store via
`refStoreToTree` and compare the resulting tree. That comparison leaks
two pieces of incidental order: insertion order of `children` (driven
by the order `addParentChild` was called) and insertion order of the
forest roots (driven by the order parentless rows were inserted into
`store.nodes`). Once the suffix becomes unordered, both shift, and
tests fail for reasons unrelated to the engine's behavior.

Replace tree-shape equality with a `refStoreEquals(a, b, hc)` that
compares stores by their explicit content:

- Node set: same set of ids; for each id, same `tag`, same hashconsed
  `atom`. Skip `gen` and `span` — they're evaluation artefacts, not
  part of the declared semantics. Any test that genuinely checks `gen`
  was never using tree-based equality (the tree shape doesn't expose
  it cleanly), so it won't be migrating to `refStoreEquals` and isn't
  affected.
- `parentChild` relation: same id-keyed set of edges (compare as
  `Set<(parent, child)>`).
- `beforeAfter` relation: same id-keyed set of edges.
- Symbol-index buckets are derived from the node set; don't compare.
- `descendantsCache` is a memo; don't compare.

The function returns `true | { reason: string }` so failed assertions
report the first divergence (e.g. `"node N123 present in a, missing in
b"`, `"parentChild edge (P, C) only in b"`).

Migrate the tests:

- `unify.test.ts:collectMatches` consumers — they compare bindings, not
  store shape, so they're unaffected. Keep as-is.
- Any test currently doing `assert.deepEqual(refStoreToTree(s), ...)` —
  rewrite to construct an *expected* `RefStore` (via the same
  `insertRow` / `addParentChild` / `addBeforeAfter` API) and call
  `refStoreEquals`. Audit `tests/fixpoint.test.ts` and the engine-level
  tests for these.

`refStoreToTree` itself stays — it's used by `web.ts` for rendering and
by tests that genuinely care about a hierarchical view. It just stops
being the equality oracle.

### Differential testing

For each rule in the test corpus:

1. Lower it normally.
2. Permute `te.matching` (random shuffle, fixed seed).
3. Run the fixpoint against a fixed reference store.
4. Compare the resulting store against the unpermuted run with
   `refStoreEquals`.

Bake this into a single `tests/order-robust.test.ts` that reuses the
fixpoint corpus.

## Migration

Stage 1 — split `TurnExpr`:
- Update the interface in `types.ts`.
- Update `lower.ts` to emit `{matching, assertions}` directly (it
  already separates them internally).
- Update `unifyConstraintsAt` and `step.ts` to consume the new shape.
  Drop the `suffixStart` parameter.

Stage 2a — IntervalRel enumerators:
- Implement `before:after` predecessor/successor enumeration in
  `refstore.ts` with `predecessorsCache`/`successorsCache`.
- Implement `overlap` enumeration with `overlapsOf` cache.
- Wire `prior` enumeration as the union of the contains-reverse and
  before:after enumerators.
- Extend `enumerateIntervalRel` to dispatch on every kind; remove the
  current "throws on non-contains" guard.
- Add unit tests covering each enumerator independently of the
  scheduler.

Stage 2b — readiness-driven scheduler:
- Add `ready(c, boundVars)` and the selection loop in
  `unifyConstraintsAt`.
- Remove the bound-id fast path from `matchAt` — it's now expressed as
  `Match` with `id` already bound returning `"check"` from `ready`.

Stage 2c — RefStore equality + test migration:
- Add `refStoreEquals(a, b, hc)` (and an `assertRefStoreEquals`
  wrapper) in `refstore.ts`. Equality is part of the type's declared
  semantics — it lives next to the type, not in test utils.
- Audit tests for `refStoreToTree`-based equality assertions and
  migrate them to `refStoreEquals`. Run the full test suite —
  *before* landing Stage 3 — so any pre-existing dependence on
  insertion order surfaces here, against the unchanged engine, rather
  than mixed in with the suffix-ordering change.

Stage 3 — id-keyed `children`, drop suffix ordering:
- Re-key `RefStore.children` from `Map<NodeId, NodeRow[]>` to
  `Map<NodeId, NodeId[]>`. Update call sites (`refStoreToTree`,
  `checkIntegrity`, `addParentChild`'s incremental logic).
- Drop existence checks from `addParentChild`; it becomes id-pure.
- `step.ts` runs the suffix as one unordered loop (no insert/edge
  partition).
- Convert `runAssertIntervalRel`'s silent return into a throw.

Stage 4 — fuzz harness:
- Add the permutation-fuzzing test described above.
- Run it as part of CI.

Each stage compiles and passes tests independently.

## Open work / unknowns

- The constraint-set abstraction may complicate the
  mutation-during-iteration story. Today every same-iteration row is
  filtered by `passesConstraint(gen === iteration)`, which fires inside
  `matchAt`. If the scheduler routes a candidate-bound row to a `check`
  constraint that doesn't apply `passesConstraint`, we could see a
  same-iteration row in a way the existing model forbids. Audit:
  `IntervalRel` checks consult only structural relations (parent:child,
  before:after) — those reflect store edges, not row gen. So checks are
  safe; the gen filter only matters for `Match`'s candidate enumeration,
  which already lives in `matchAt`. Fine, but worth a comment in the
  scheduler that this is the only place gen filtering is needed.

- The phase split assumes a clean two-phase semantics. If we ever want
  to interleave inserts with matching (e.g. derive a fact mid-rule and
  match against it in the same fixpoint pass), the interface needs to
  grow. Outside scope for now.

## Non-goals

- Performance parity with the pre-TE matcher. The scheduler's smaller-
  iterator policy is a step toward that, but a full query planner is
  out of scope. We accept that some patterns will pick the symbol-index
  bucket and others will pick the descendant set; correctness is the
  bar.
- Eliminating `lower.ts` entirely. Lower stays — it just stops being
  the load-bearing component of correctness.

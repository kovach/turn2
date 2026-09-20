# moment walk — an interface for calculating things along the moment order

Section: `# interface for calculating things along the moment order` in
notes/overview.md.

A Turn program has two parts. The **monotone part** is the rule set the
inner loop runs to quiescence; it grows the store and, through `AssertLt`
edges, the moment order. The **non-monotone part** is everything that must
observe a *complete* state at a moment: aggregate folds, choice resolution,
and (later) conflicts and subscriptions. Today each of those has its own
collector, its own notion of "pending", and its own place in `runLoop`
(`collectAllBlocked` + `collectReactiveFinalizations` + `selectEarliestTier`
+ the stratum filter + the choice branch). This change replaces that with
one mechanism: after every monotone fixpoint the scheduler takes the
**minimal unresolved moments** and runs every registered **moment handler**
at each of them. A handler may add tuples, may report that it is blocked
(waiting on the outside world), or may report nothing to do. A moment is
**resolved** once a round at it produces no progress and no handler is
blocked there. The scheduler knows nothing about aggregates or choices —
those are handlers.

First pass: `#reactive` is ported to the interface (its value is simply
recomputed at every moment, no breakpoints, no join-closure, no residual
detection), reactive reads become *point reads at the anchor's left
endpoint* that block until that moment is resolved, and choices and the
demand aggregates (`_do-agg` / `_do-aggc`) are wrapped as handlers so there
is a single scheduler. Fold semantics of `#agg` and `[...]` are untouched.

**Relation to the in-progress proposals.** This plan is meant to be the
aggregation approach, superseding the others once its details settle:

- plans/v2-aggregates-concluded.md ("stuck moments", status "not
  adequate?"): its one good idea — a single kind of obstruction, resolved
  earliest-first — *is* the moment walk; its per-`do-agg` breakpoint
  bookkeeping and `_agg-done` pairs are not needed when moments themselves
  carry the resolved mark. Mark it superseded.
- plans/v2-timestamped-reactive-aggregates.md and
  plans/v2-two-level-timestamps.md (bump the int component of a result's
  left endpoint): unimplemented; not needed. Same-moment ordering is
  handled by the handler protocol (§2) plus the existing strata (§3.1),
  and a reactive read now samples at a point, so nothing has to be placed
  "strictly after its inputs but before the next base moment". Mark both
  superseded.
- plans/v2-reactive-aggregates.md: its production side (breakpoints as a
  join-closure, residual re-finalization, per-group materialization) is
  replaced by §3.1; its consumption side (overlap match of over-persisting
  `[bp, top]` rows) by §4. The `#reactive` declaration and `_aggval` row
  shape survive.
- discussions/aggregation-and-conflicts.md §C.4 (samples vs.
  subscriptions, conflicts): compatible. Samples are what §4 implements;
  subscriptions and conflicts are the follow-up handlers in §10.

## 1. The model

**Moments.** The moment set is every endpoint the store has seen:
`store.momentTerms` (populated by `addTuple` and `addOrder`), minus `top`.
`bot` is a moment (rule-initial `^` emits live at `(bot, top)` and a
rule-initial read samples there). Right endpoints are moments too — after a
sequence sub `(…);` the running anchor's left is the previous episode's
right endpoint, so a read can be anchored at one.

**Resolved.** `store.resolved: Set<number>` of moment tokens (in-memory:
the harness rebuilds the store on every run, including the choice-commit
flow in web-v2.ts, so nothing needs persisting). Invariant maintained by
the scheduler: `resolved` is a **down-set** of the moment order — a moment
is only ever marked when everything strictly below it is already marked.

**Frontier.** `F = minimal(U)` where `U = moments − resolved`. Under the
down-set invariant this is computable from asserted edges alone: `m ∈ F`
iff `m` is unresolved and every immediate predecessor of `m` is resolved,
where the predecessors are `store.orderBwd.get(tok(m))` plus the implicit
`bot` for every `m ≠ bot`. (Proof: if some unresolved `u < m` existed, walk
the edge path `u → … → p → m`; `p` resolved with `u < p` unresolved
contradicts the down-set invariant.) `orderBwd` exists today but is only
populated under `ORDER_STRATEGY === "eager"`; the `"old"` branch of
`addOrder` must also record `orderBwd[gt] ∪= {lt}`. Hand-built test stores
whose moments carry no asserted edges (bare Symbols `m1`, `m2`) get only
the implicit `bot` predecessor, which is the correct order for them.

**Handlers.**

```ts
// moment-walk.ts
export interface MomentHandler {
  name: string;
  // Run at moment `m` (a frontier moment, or a resolved moment this handler
  // demanded — see `demanded`). Must be idempotent: a second call at the
  // same store state adds nothing. `progress` is true iff at least one
  // addTuple returned true. `blocked` is true iff the handler is waiting
  // on external input at `m` (a `you` choice) — `m` cannot resolve.
  run(store: Store, m: Term): { progress: boolean; blocked: boolean };
  // Optional: moment tokens where this handler has pending work regardless
  // of the frontier. Used by demand-style handlers (a `_do-agg` row whose
  // left endpoint is *already resolved* — late work that arrived through a
  // same-moment `^` chain). Such moments are run alongside the frontier
  // without re-opening them: everything below them is settled, so the
  // answer is as final as it will get.
  demanded?(store: Store): Iterable<number>;
}
```

Handlers are constructed once per `runFixpoint` (they may close over the
schema, the reactive set, the strata map, and the js tables) and passed to
`runLoop` as an ordered list. Order within a moment matters only for which
handler's rows land first in the same round; the protocol below re-runs all
handlers at a moment until nothing changes, so results do not depend on it.

## 2. The scheduler (fixpoint.ts `runLoop`)

```
outer:
  iters += innerLoop(...)                      # monotone part to quiescence
  walk:
    U = unresolvedMoments(store)               # momentTerms − resolved − {top}
    F = frontier(store, U)
    D = ∪ h.demanded?.() ∩ resolved            # late work at settled moments
    if F ∪ D is empty: return done
    progress = false; blocked = ∅
    for m in F ∪ D: for h in handlers:
        r = h.run(store, m)
        progress ||= r.progress
        if r.blocked: blocked ∪= {m}
    if progress:
        store.iteration++; swapHeads(store)    # new rows are next round's delta
        goto outer                             # rules must see the new tuples
    toMark = F − blocked
    if toMark nonempty:
        mark toMark resolved                   # nothing changed: no inner loop
        goto walk
    # every frontier moment (and every late demanded one) is blocked
    surface(blocked)                           # existing choice branch, seeded
                                               # by blocked chooses at `blocked`
```

Rules of the protocol:

- **Progress before marking.** A moment is marked only after a round at it
  in which *no* handler at *any* frontier moment made progress. This is what
  lets same-moment chains resolve: a read closes at `m`, its suffix
  `^`-emits at `m`, another rule's read at `m` becomes pending, the next
  round closes it — all before `m` is marked. Marking a moment while a
  handler elsewhere on the frontier is still progressing would be premature
  only in the incomparable-branch case, where nothing produced on the other
  branch can land at `m` (anchor intersection with an incomparable moment
  fails or moves strictly up), so it is safe either way; the simple rule is
  chosen for predictability.
- **Marking needs no inner loop.** If nothing was added, re-running the
  rules is a no-op; the walk advances the frontier directly. This is what
  keeps programs without reactive relations cheap: the walk crosses a
  chain of moments with nothing pending in one pass of frontier
  computations, entering `innerLoop` only when a handler adds rows.
- **Surface when the frontier is fully blocked.** Blocked moments are
  skipped over as long as *some* frontier moment is unblocked: the walk
  keeps advancing incomparable branches, closing their aggregates and
  reaching their choices, so that every choice that is minimal among
  pending choices surfaces together — today's "earliest tier is all
  choices" behaviour, reconstructed. Only when `F ⊆ blocked` does the
  loop hand off to the choice branch.
- **The choice branch is today's code**, seeded differently: `seedChoices`
  = blocked `_choose` rows whose left endpoint is in `blocked`;
  `computeComponents`, the empty-fringe error, dead-choice marking
  (`markDeadChoice` → progress → `goto outer`), rng auto-resolution
  (commits → `goto outer`), and the `active-choices` return are unchanged.
  Dead-choice rows and `is` commits make the blocked chooses unblocked, so
  the next round at those moments proceeds.
- **Gas.** `innerLoop` is bounded by `gas` as today; `GasError` from any
  handler's `addTuple` propagates to `runFixpoint` as today.
- **Termination.** Each `walk` iteration either adds a tuple (bounded by
  `tupleGas`), marks at least one moment (moments are finite for a finite
  store; new moments only arrive with new tuples), or returns. Handlers
  are idempotent, so a round with nothing new is guaranteed after finitely
  many rounds at a moment.

The old `!progressed → done` safety net disappears: "no progress" now
simply means "resolve this moment", which is the correct reading of an
aggregate with an empty fold.

`FixpointResult` is unchanged; `store.resolved` is available to callers
(the timeline may later draw resolved vs. pending moments — not this plan).

## 3. Handlers

### 3.1 Reactive aggregates — recompute at every moment

For each `#reactive` relation `foo` and each moment `m` the handler folds
the contributors **alive at the point `m`** and materializes one row per
group:

```
_aggval foo key… value <id>      at [m, m]
id = (*aggval-id foo key… value m)     -- deterministic, so re-runs dedup
```

- The fold is `aggregateOver(store, [foo, _free × k, _free], m, m, schema)`
  per **user arity** present among `foo`'s stored tuples (bucket the
  candidates by `terms.length` first; `SchemaDecl` records no arity and
  the `*` in `#reactive at * -> last` is not parsed as one). `aggregateOver`
  already implements point containment for `l == r`.
- Zero rows follow `aggregateOver`'s existing policy: a keyless `sum` /
  `count` / `bool` relation with no contributors alive at `m` yields one
  zero row at every moment; a keyed relation yields nothing for absent
  groups (see §5, negation).
- `last` with incomparable maximal contributors yields several rows for one
  group at `m` — the same ambiguity as today; the conflicts work in
  discussions/aggregation-and-conflicts.md (Part A) is where that goes.
- **Strata stay.** `computeAggStrata` (the `=`-edge same-moment analysis)
  is kept unchanged and the ordering it computes is applied *inside* the
  handler: iterate strata in ascending order; fold every relation of the
  stratum at `m`; if any row was new, return `{progress: true}` without
  folding higher strata. A higher stratum is folded only in a round where
  every lower stratum re-folded with nothing new — i.e. has settled at `m`.
  Re-folding a settled stratum is idempotent (deterministic ids). This
  reproduces today's `minStratum` filter with no scheduler involvement and
  is what makes `count` of a same-moment transitive closure fold once, at
  9, instead of leaving `3`, `6`, `9` rows at the same point (§6, test 10).
- No `demanded`: pendingness for this handler *is* "the moment is
  unresolved". Never `blocked`.
- Rows count against `tupleGas`. This is the deliberate cost of the first
  pass: one row per (moment × reactive relation × live group). §7 lists
  the compression options; none is taken here.

### 3.2 Demand aggregates — `_do-agg` and `_do-aggc`

One handler wrapping the existing closers, so the legacy tier machinery can
be deleted rather than coexist with the walk:

- `run(m)`: `collectBlockedDoAggs` / `collectBlockedDoAggCs`, keep rows with
  `tok(l) == tok(m)`, close each with `closeDoAgg` / `closeDoAggC`.
  `progress` = any returned true. Fold semantics (containment of the
  producer's `[l, r]`, `*agg-empty` sentinel) are untouched.
- `demanded()`: left-endpoint tokens of all blocked rows. A row whose
  moment is already resolved is closed in the next round without waiting
  for the frontier.
- Never `blocked`.

Behavioural difference from today's `selectEarliestTier`: a `_do-agg` at
`m` now waits for *every* moment below `m` to be resolved, not just for
blocked rows below `m`. Moments with nothing pending resolve in the same
walk pass at no cost, so the observable difference is only that an
aggregate at `m` is not closed while an unresolved choice sits strictly
below it — which is also today's behaviour (the choice is prior).

### 3.3 Choices

- `run(m)`: `blocked = true` iff some row of `collectBlockedChooses(store)`
  has `tok(l) == tok(m)`; never `progress`. (`collectBlockedChooses`
  already treats `is` rows and `_dead-choice` markers as resolutions.)
- `demanded()`: left tokens of blocked choose rows (a late choose at a
  resolved moment should surface, not hide behind the frontier).

The surfacing, dead-choice, and rng code stays in `runLoop` (§2) rather
than in the handler: it needs the whole blocked set and returns from the
loop.

## 4. Reactive reads — sample at the anchor's left, block until resolved

`decomposeReactiveRead` (expand.ts) changes from "plain match of `_aggval`
at the running anchor" to a **point match at the anchor's left endpoint**:

```
Match { atom: [_aggval, head, pat…, weight, Wildcard], l: XL, r: XL }
```

- `l` and `r` are the running anchor's `XL` term itself (a Variable bound
  earlier in the body, or the literal `bot` at rule start). `evalMatch`
  unifies `a.l` against the row's left first, so rows at other moments are
  rejected before atom unification. No `_l_k` / `_r_k` slots, no `Le`, no
  `Max`/`Min`: the running anchor is **unchanged** by the read (`return
  {XL, XR}`), exactly like `decomposeAggregate`'s consumer. Threading the
  point row's interval through `Max`/`Min` would collapse the anchor to
  `[XL, XL]` and make every later `+` emit assert a cycle.
- `collectVarsTerm` on `pat` and `weight` as today (they enter the chain;
  `XL` is already in it), so firing identity is intact without endpoint
  slots.
- **Blocking is free.** The row at `[XL, XL]` exists iff `XL` has been
  visited by the reactive handler. Until then the Match has no candidate
  and the rule does not fire; when the rows land, semi-naive delta variants
  with the `_aggval` Match tagged `delta` wake the rule. Nothing in the
  evaluator changes.
- Check that no post-expand pass assumes `Match.l` is a Variable
  (`pruneChains`, `splitRule`, `filterDead`, `resolveJsModes`, the
  delta-variant cloner, `print-ir`). `decomposeAggregate` already emits
  Matches whose `l`/`r` are chain Variables rather than fresh slots, and
  rule-initial reads will carry the literal `bot`; `resolveJsModes` treats
  everything a Match mentions as bound, which is right.

## 5. Semantic consequences (read these before touching tests)

1. **Reactive reads are samples, not subscriptions.** `foo k -> V` yields
   the value of `foo` at the *start* of the running anchor. A rule-initial
   read (`dmg -> 7, + lethal x` at column 0) samples at `bot` and fires at
   most once; it no longer fires "whenever the sum becomes 7". The
   event-driver use (N3 in discussions/aggregation-and-conflicts.md §C.3)
   is **not expressible** after this change. It comes back as a further
   handler on the same interface — a subscription handler that, at each
   `m`, re-folds every subscription request whose window contains `m` and
   emits an observation row at `m` (the `->>` proposal, §C.4). Out of
   scope here; the interface is built so that it slots in.
2. **A rule does not read its own write.** `move A B, at A -> C, +at A -> B`
   reads `at A` at the move's left endpoint; the `+at` lands strictly
   inside the move, above the read point. This is the corpus idiom
   (dungeon's read-then-write) and the reason `#reactive`'s old
   overlap-match read was wrong (`test.t`'s `huh` saw its own move).
3. **Negation via a keyed reactive read does not work** (unchanged from
   today, now documented): `downs Q -> 0` with `Q` bound needs a zero row
   for an absent group, and materialization cannot enumerate an open key
   space. Use `#agg` (whose demand row carries the bound key) for negation.
   A future fix: lower a reactive read whose key positions are all
   prefix-bound (`prefixSeen` knows this statically) to a demand request
   closed at the point `[m, m]` by the demand handler.
4. **Same-moment `^` feedback into a folded relation** after its moment is
   resolved (the CHAR 14 class) is still silent. Strata cover the cases the
   `=`-edge analysis sees; nothing else changes here.
5. **Cost.** Programs with reactive relations enter `innerLoop` once per
   frontier advance (each moment mints rows). Programs without them walk
   the moment order in one pass per pending event.

## 6. Tests

`ts/src/tests/v2_reactive_aggregate.test.ts` — the file encodes
subscription semantics and breakpoint-only materialization; rewrite:

- **1 (join):** keep, via a new `driveWalk(store, handlers)` helper that
  runs §2's walk on a hand-built store. Expect `_aggval dmg 7` at `j` only,
  `3` at `m1` only, `4` at `m2` only, and a zero row `_aggval dmg 0` at
  `bot`. (Rows are now `[m, m]`; assert lefts as today.)
- **2 (sequential):** keep: `3` at `m1`, `7` at `m2`, never `4`.
- **3 / 3b / 4 / 8 (rule-initial subscription reads):** rewrite as samples
  with an explicit anchor: an episode whose start lies after the
  contributions it should see. With `~a (+dmg -> 3, ~b (+dmg -> 4, ~c))`,
  `c, dmg -> 7, +lethal x` fires and `c, dmg -> 99, +impossible x` does
  not; `b, dmg -> N, +seen N` sees `3` only (the `4` lands inside `b`,
  above its start). Test 8 becomes: two incomparable `+p` under `c`, then
  an episode `d` sequenced after `c` (`~c; ~d`) reads
  `p -> (s (s (s (s z))))` — `d` starts at `c`'s right endpoint, above both
  contributions.
- **5 / 6 (keyed sum, last):** rewrite to read at a later episode; `last`
  under `~check` after two moves sees the second.
- **7 (coexistence with `#agg`):** keep; both paths run through the walk.
- **9 (single-moment transitive closure):** keep as is — works through
  residual re-materialization at `bot` (round `k` adds the groups derived
  in round `k−1`; rows dedup by id).
- **10 (same-moment `count` folds once):** add a reader `q -> N, ^total N`
  and assert exactly one `_aggval q` row and `total (s^9 z)`; guards the
  in-handler strata.
- **per-group breakpoints:** delete — rows are re-stamped at every moment
  by design. Replace with a value-read test: `check, at X -> L, ^seen X L`
  after `move me a; move it a; check; move me b; check;` yields exactly
  `seen me a`, `seen it a` at the first check and `seen me b`, `seen it a`
  at the second.
- New: **blocking** — a read whose anchor left is a moment with a pending
  `you` choice below it does not fire before the choice is committed
  (status `active-choices`, no `_aggval` at or above that moment), and
  does after.
- New: **late demand** — a `#agg` read whose request row appears at an
  already-resolved moment through a same-moment `^` chain is closed on the
  next round (no stall, status `done`).
- New: **frontier** — unit test of `frontier(store, U)` on a hand-built
  diamond (`bot < a, b < j`): `{bot}` → `{a, b}` → `{j}`.

`ts/src/tests/v2_stratification.test.ts`: the `computeAggStrata` unit tests
stay. Runtime test 2 (through-plain `=` chain) gets a `q` reader like test
10. Runtime test 3 (the `<` ping-pong) depends on rule-initial subscription
reads (`a -> 1, go, +b -> 2` sampled at `bot` sees nothing): rewrite so
each step is anchored after the write — `go, +a -> 1, ^a-set` then
`a-set, a -> 1, +b -> 2, ^b-set`, `b-set, b -> 2, +a -> 3` — and assert
`_aggval a 3` exists at some moment and the run is `done`.

`ts/data/v2/test.t` is the only program using `#reactive`; re-check its
output by hand (`huh A B C` must now report the location *before* the move).

Everything else (`v2_dungeon`, `v2_ttt`, `v2_choice*`, `v2_dead_choice`,
`v2_bracket_agg`, `v2_constrain_agg`, `v2_exceptions`, …) must pass
unchanged: they exercise `#agg`, `[...]`, and choices through the new
scheduler with the same fold semantics.

## 7. What is removed

scheduler.ts: `ReactiveFinalization`, `Blocked`, `collectAllBlocked`,
`selectEarliestTier`, `isPrior`, `collectReactiveFinalizations`,
`finalizeReactive`, `foldGroupAt`, `groupKeyOf`, `joinClosure`, the
per-group-breakpoint machinery and its comments. Kept: `aggregateOver`,
`closeDoAgg`, `collectBlockedDoAggs`, `collectBlockedChooses`,
`resolvedChoiceTokens`, `markDeadChoice`, `resolveRngChoice`,
`programSeededRandom`, `computeAggStrata`, `emitAggValRow` (now taking `m`
and emitting `[m, m]`). `leastUpperBound` stays in store.ts (comp-aggregate
and constraint-query use it). scratch/scratch_ab.ts imports only
`computeAggStrata` and keeps working.

## 8. Files

- **new** `ts/src/v2/moment-walk.ts` — `MomentHandler`, `unresolvedMoments`,
  `frontier`, `markResolved`, and `runWalkRound(store, handlers)` (one
  round of §2: returns `{progress, blocked, frontier, demanded}` so
  fixpoint.ts owns only the loop and the choice branch, and tests can
  drive rounds directly).
- `ts/src/v2/store.ts` — `resolved: Set<number>` on `Store`; populate
  `orderBwd` in the `"old"` `addOrder` branch (bot/top edges stay
  implicit).
- `ts/src/v2/scheduler.ts` — deletions in §7; `reactiveHandler(reactive,
  schema, strata)`, `demandAggHandler(schema)`, `choiceHandler()`
  factories; `emitAggValRow` at `[m, m]`.
- `ts/src/v2/fixpoint.ts` — `runLoop` per §2; handler list built in
  `runFixpoint`; `strata` passed to the reactive handler instead of the
  loop.
- `ts/src/v2/expand.ts` — `decomposeReactiveRead` per §4.
- tests per §6; `ts/data/v2/test.t` re-checked.

No parser change: `#reactive rel -> agg` is the same declaration with new
scheduling and read semantics.

## 9. Docs

- `ts/src/v2/overview.md`: rewrite the scheduler.ts and fixpoint.ts
  sections around the moment walk (moments, resolved down-set, frontier
  from `orderBwd`, the handler protocol, the three handlers, `_aggval` at
  `[m, m]`, point reads); add a moment-walk.ts section; note in store.ts
  that `orderBwd` is now maintained under both strategies and that
  `resolved` lives on the store.
- `discussions/turn-tutorial.md` (Aggregates section): one paragraph on
  `#reactive` as "the value at the start of the current anchor, available
  once that moment is resolved", and that negation should use `#agg`.
- notes/overview.md: `plan: plans/v2-moment-walk.md`.

## 10. Follow-ups this interface is meant to carry (not in this change)

- **Subscriptions** (`->>`, §C.4 of the aggregation discussion): a handler
  that at each `m` re-folds every open subscription window containing `m`
  and emits an observation row at `m`. Restores the event-driver use lost
  in §5.1 with the schedule-independent "every moment" observation set the
  discussion argues for.
- **`#agg` / `[...]` as point folds** (`[XL, XL]` instead of containment of
  `[XL, XR]`): a one-line change in the demand handler once the corpus is
  checked against it.
- **Conflicts** (Part A of the discussion): a handler that detects
  incomparable maximal `last` contributors at `m` and emits `_conflict`
  rows; a blocked-style outcome could hold `m` until a rule resolves it.
- **Materialization cost**: per-relation heads (`_aggval:foo`) to shrink
  the Match scan; skipping moments no reactive read can be anchored at;
  value-change compression with a maximal-row read (the previous design)
  if row counts bite in practice.
- **Timeline**: draw `store.resolved` to show how far a stalled run got.

---
plan author: Claude Fable 5.1 (claude-fable-5-1), 2026-09-13

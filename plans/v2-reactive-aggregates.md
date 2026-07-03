# v2 reactive aggregates (axis-2: eager breakpoint evaluation)

This plan is about **when/where** an aggregate is evaluated, not how it is
*defined*. Defining aggregates (arbitrary bodies, nesting, params) is
[plans/v2-aggregate-comprehensions.md](v2-aggregate-comprehensions.md) — call
that **axis-1**. The two are orthogonal and compose: axis-1 says *what* a
group's contributors are; this plan says the aggregate's value is materialized
as a relation, eagerly, at exactly the moments it can change, so downstream
rules react promptly.

It supersedes the demand-driven half of the current `_do-agg` / `_agg-result`
mechanism (`scheduler.ts`, `expand.ts:decomposeAggregate`). The fold engine
(`aggregateOver`, `aggregators.ts`) is reused essentially unchanged — only its
*driver* changes.

## Opting in: `#reactive foo -> sum`

Reactivity is requested per relation by a new schema command, a sibling of
`#agg`:

```
#agg      foo -> sum      # demand-driven (today's behavior, unchanged)
#reactive foo -> sum      # eager breakpoint materialization (this plan)
```

`#reactive` parses identically to `#agg` (same `parseSchemaText`, same
`relation -> aggregator` shape) but records the relation as reactive. A relation
declared `#reactive` is materialized into `_aggval` at breakpoints and consumed
per the two-variant join above; a relation declared `#agg` keeps the
`_do-agg` / `_agg-result` demand path. The two coexist in one program.

## Motivating shape

```
#reactive at -> last
#reactive n-here -> count
#reactive damage-taken -> sum

# last position of each token, then count tokens at each location
at T L      := last( T -> L | move T L )        # reactive value relation
n-here L N  := count( L -> N | at T L )          # consumes `at`, also reactive

# react to a derived scalar crossing a threshold
hp H        := H = max-health - damage-taken     # damage-taken is a sum(...)
hp 0 -> die                                       # must fire AT the moment hp hits 0
```

The hard case (the reason event-driven re-eval is insufficient): `damage-taken`
can cross the lethal threshold at `lub(m1, m2)` of two **incomparable** damage
events, a moment where *neither* event individually occurs. The reaction `hp 0`
must fire at that join moment even though no atom is asserted there.

## Semantic model: an aggregate is a step function over the moment lattice

For a fixed group key `k`, an aggregate is a function
`agg_k(m) = fold { contributor i in group k : interval_i contains m }`.
This is a step function over the moment partial order. We want to materialize
it as stored tuples that downstream rules can match.

**Breakpoints.** The value can change only where the active-contributor set
changes. For `+`-fact contributors (`r_i = TOP`, monotone accumulation) the
active set at `m` is `{ i : l_i ≤ m }`, which changes exactly at elements of the
**join-closure** of the contributor left endpoints `{ l_i }`. (Finite-`r`
episode contributors also turn *off*; see "Episodes / turn-off" below — phase 1
targets the `+`-fact case first.)

**The join-closure is a sub-semilattice, and that is what makes consumption
well-defined.** The set of breakpoints `≤ m` is closed under join (join of two
breakpoints `≤ m` is itself `≤ m` and a join of contributor endpoints, hence a
breakpoint), so it has a unique top element = `lub` of all contributor
endpoints `≤ m`. The value there equals `agg_k(m)`. So "the value at `m`" is
always "the value at the greatest breakpoint `≤ m`" — a `last`-by-left-endpoint
selection (exactly `aggregateOver`'s existing `last` logic).

**Every breakpoint already exists as a moment** (the subdivision-lattice
property, notes/moment-insertion.md — trusted, no audit): `leastUpperBound`
*finds* `lub(l_i, l_j)`, never mints, never returns `null`. This is the load-
bearing assumption that makes the whole plan cheap; if `leastUpperBound` ever
returns `null` at runtime it is an invariant violation and should hard-error.

## Representation: a materialized value relation, `[bp, TOP]` + last-read

Each reactive aggregate materializes one **value relation** `_aggval`:

```
_aggval <head> <key...> <value>     at interval [bp, TOP]
```

emitted once per breakpoint `bp` where the group's value *changes* to `<value>`
(value-change compression — skip a breakpoint whose value equals the value at
the breakpoints just below it). Interval is `[bp, TOP]`: the value "holds from
`bp` onward" the same way a `+` fact does. This deliberately **over-persists**
(an old value's tuple still contains higher moments where the value has since
changed); over-persistence is resolved at *read* time, not by trying to bound
the interval — the region where a value is *current* is `up(bp) \ ∪ up(higher
bps)`, which is not a single interval in a lattice, so no honest `r` exists.

**Consumption is uniform: always a reactive `last`-read.** A consumer — whether
`foo -> X` (bind) or a literal `foo 0` (filter) — lowers to `last( key -> V |
_aggval foo key V )` at the consumer's anchor, then unifies the value slot with
the user's term. A **variable binds** the current value for further use; a
**literal filters**, so the firing proceeds only where the current value equals
it. The literal case is not a separate mechanism: `hp 0 -> die` is "read last
hp, require it `= 0`, proceed" — the *same* `last`-read as `hp H` with `H` then
constrained.

There is deliberately **no** "does an `hp 0` tuple exist" plain match. `_aggval`
over-persists (`[bp, TOP]`), so a bare existence match would fire at moments
where hp has since changed; `last`-select discards the superseded tuples, so it
is correct at the trigger moment *and* everywhere above. Always-`last` is
uniformly correct, so it is the only consumption mode.

**Reading a reactive aggregate's value is itself a reactive `last`-aggregate**
(scheduled like any other). This is the composition the user asked for (last →
count): consuming a value nests uniformly with no special case.

This is the concrete meaning of "`foo -> X` will match changes to aggregate
values rather than rewriting to `_do-agg`/`_agg-result`": the consumer side
stops minting a per-firing `_do-agg`/`_agg-result` pair and instead reactively
`last`-reads the standing `_aggval` relation.

## Consuming in a join: the two delta variants

Consider a body `foo, bar -> X` (a `foo` match conjoined with a read of the
reactive aggregate `bar`). Semi-naive splits it into two delta variants, and
they are **asymmetric** — only one side carries `last`.

Setup: a new `bar` breakpoint is `bp = lub(m_new, m)`, where `m_new` is a new
`bar` *input* tuple's moment and `m` a pre-existing `bar` breakpoint (the
incremental join-closure step). Its value tuple `_aggval … X` lives at
`[bp, TOP]`.

- **foo-delta** (new `foo` at `foo_l`): `last`-read `bar` at the *point*
  `foo_l` — among `bar` value tuples containing `foo_l` (those with
  `bp' ≤ foo_l`), take the maximal-left one. That is `bar`'s *current* value at
  the moment `foo` becomes active. (Many bar tuples contain `foo_l` because of
  over-persistence; `last` keeps exactly the current one.)

- **bar-delta** (new `bp`): join with `foo` tuples **whose interval contains the
  point `bp`** — `foo_l ≤ bp ≤ foo_r` — and fire **at `bp`**.

**Containment, not overlap.** The bar-delta condition is interval *containment*
of `bp` by `foo`, **not** overlap of `foo` with `[bp, TOP]`. Overlap with
`[bp, TOP]` is nonempty whenever `lub(foo_l, bp) ≤ foo_r` — for `+`-facts,
essentially always — so it would also match `foo` that started *after* `bar`
moved past `bp` (`foo_l > bp`). Those firings are both **stale** (at the firing
moment `μ = lub(foo_l, bp) ≥ foo_l > bp`, `bar`'s current value is some later
`bp'`, not `X`) and **double-counted** (that pair is already produced by the
foo-delta/`last` variant at `foo_l`). And the staleness can't be screened out by
a `last`-check when `bp` is processed, because the superseding `bp'` is *later*
than `bp` and, under earliest-first scheduling, isn't emitted yet.

Containment (`foo_l ≤ bp`) excludes exactly that case and yields a clean
partition of the `(foo, bar-value)` pairs, with **no `last`-check on the bar
side**:

- `bar` changes **at or before** `foo` starts (`bp ≤ foo_l`) → foo-delta,
  resolved by `last`. (bar-delta's `foo_l ≤ bp` fails, so it stays out.)
- `bar` changes **within** `foo`'s life (`foo_l ≤ bp ≤ foo_r`) → bar-delta,
  fires at `bp`.

Because `foo_l ≤ bp` forces `μ = lub(foo_l, bp) = bp`, and `bp` is trivially the
latest `bar` breakpoint `≤ bp`, the value `X` is current at the firing moment by
construction. The `foo_l == bp` boundary is the ordinary semi-naive new×new
case, counted once by the delta/old generation tags — not a moment inequality.

**The symmetry worth noticing.** Both variants are the *same* primitive —
`intervalContains` at a **point** (precisely `aggregateOver`'s candidate test):

- foo-delta: `bar` tuples containing the point `foo_l`, **`last`-selected**
  (many contain `foo_l`; only the latest is current).
- bar-delta: `foo` tuples containing the point `bp`, plain (no `last` — `bp` is
  already the latest at `bp`).

So the only real asymmetry is *which side needs `last`*: the side you read the
standing value *from* (`bar`) needs it when the *other* side supplies the delta;
when `bar` itself supplies the delta, the answer is pinned to the delta and
`last` collapses to identity.

**Why containment still matters even though reads are `last`.** A final
leaf consumer `last`-reads, so a stale *value* would be masked there. But a
stale bar-delta firing still produces a stale tuple in the *head* relation,
which (a) double-counts the pair already produced by foo-delta and (b) pollutes
that head's own breakpoint enumeration — every stale tuple contributes a
spurious left endpoint, hence spurious downstream breakpoints. So the
containment predicate is load-bearing for correctness of the breakpoint
structure, not just an efficiency nicety.

## Production: a standing aggregation driven by the scheduler

Replace the per-firing producer (`Emit _do-agg ... at the consumer's anchor`)
with a **standing registration**: each reactive aggregate declares
`(head, fold, keyPositions, source-relation)` once. The aggregated
source-relation is either a user relation directly or, under axis-1, the
materialization relation `_aggsrc_N` the comprehension lift produces. The
scheduler watches the source relation and emits `_aggval` rows at breakpoints.

Params (an aggregate correlated to enclosing-bound variables) are **just extra
key columns** of `_aggval` — `keyPositions` ⊇ params ∪ group-by-keys. The
consumer binds params from its prefix when it `Match`es / `last`-reads
`_aggval`. This unifies params and keys (the axis-1 plan's param/key split
collapses to "all leading columns are keys").

Internally `closeDoAgg` / `aggregateOver` are reused to compute one group's fold
*at a given breakpoint moment* — that primitive ("fold the contributors whose
interval contains `m`") is unchanged. What changes is that the driver calls it
at breakpoint moments we enumerate, instead of at one demanded anchor.

### Breakpoint enumeration (per aggregate, per group, incremental)

At outer-loop quiescence, for each registered reactive aggregate:

1. Gather current contributor tuples of the source relation, bucket by key
   signature (the existing `keyPositions` grouping in `aggregateOver`).
2. Per group, the candidate breakpoints = **join-closure of contributor left
   endpoints**, computed with `leastUpperBound`. Crucial cost lever:
   **joins of comparable moments collapse** (`lub(a,b)=max(a,b)` when ordered),
   so in a mostly-linear timeline the closure is ≈ the raw event set and only
   genuinely-concurrent events generate new join moments — which is exactly
   when the join is wanted. Worst case is the `2^n` subset-join lattice;
   bound it by (a) only enumerating joins that produce a *new* moment, (b) the
   value-change compression below, and (c) reactivity being opt-in per relation.
3. For each candidate breakpoint `bp` not yet finalized for this group, the
   value is `aggregateOver` folded at `[bp, bp]`. Emit `_aggval head key... v`
   at `[bp, TOP]` iff `v` differs from the value at the maximal already-emitted
   breakpoints strictly below `bp` (value-change compression). Dedup on
   `(head, key..., bp)` makes re-running idempotent.

## Scheduling: earliest breakpoint first (the crux)

Aggregation is **non-monotone** (a later contributor can lower a `last`, raise a
`sum`, flip a threshold), so a breakpoint's value must be **finalized in
moment order** — never compute a value at `m` while a contributor at-or-below
`m` may still appear. The existing outer loop already does this by tiers
(`selectEarliestTier` over the `prior` interval-start order, `scheduler.ts:137`);
we generalize the tier elements from "blocked `_do-agg` rows" to "pending
(aggregate, group, breakpoint) finalizations".

Outer loop (extends `fixpoint.ts:runLoop`):

```
inner loop to quiescence            # monotone rules only; no agg knowledge
collect pending finalizations:
    for each reactive aggregate, each group, each not-yet-finalized breakpoint bp
    → item with prior-key = bp
collect blocked chooses (unchanged)
if none: done
tier = selectEarliestTier(all items)          # minimal bp under `prior`
if tier has finalizations:
    finalize every item in the tier:          # all share the minimal bp rank
        emit _aggval (value-change compressed)
    bump generation, re-enter inner loop       # _aggval deltas propagate
else: surface choices (unchanged)
```

**Why earliest-first is sufficient (stratification).** When we finalize the
globally-earliest pending breakpoint `bp`, every contributor with left endpoint
`≤ bp` is already present, because:

- monotone derivations are at quiescence (inner loop ran to fixpoint), and
- any *new* contributor produced by re-entering the inner loop after this
  finalization arrives via downstream rules firing on the new `_aggval` delta;
  by the temporal-stratification assumption those derived tuples have left
  endpoints `≥ bp` (effects are not strictly-earlier than their cause). This is
  the same assumption today's scheduler already relies on to close the earliest
  tier and re-enter.

So `bp`'s value is final when finalized, and downstream aggregates (whose
breakpoints are joins of `bp` and other already-finalized breakpoints, hence
`≥ bp`) are only finalized in later tiers — after their inputs. Composition
(`last` → `count`) falls out: `count`'s breakpoints can't precede the `at`
breakpoints they are joins of, so they land in strictly-later tiers.

**Same-moment composition needs an extra mechanism — see the next section.**
An earlier draft claimed this "falls out with no extra mechanism": finalize A at
`m`, re-enter the inner loop, B's `m`-breakpoint appears, finalize B at `m`. That
argument silently assumes A reaches its *final* value in **one** finalization at
`m`. Two cases break that assumption — a recursive aggregate (A's own
contributors at `m` depend on A's `_aggval` at `m`) and a same-moment consumer
(B reads A while A is still growing). Both are addressed below.

## Single-moment stratification (recursion & same-moment consumers)

Stratification-by-time is the load-bearing trick everywhere else: a `last`-read
disambiguates competing values by their left endpoints, and earliest-first
finalization guarantees inputs precede outputs. **At a single moment all of that
collapses** — every breakpoint is the same moment, every `_aggval` shares one
left endpoint, and "earliest-first" no longer separates a producer from its
consumer. A non-temporal program (e.g. a Datalog-style transitive closure that
lands entirely at one moment) exercises this directly. Two failures:

**1. Recursive aggregate (one aggregate, one moment).** Take transitive closure

```
#reactive p * * -> bool
e A B, ^p A B -> 1
e A B, p B C -> 1, ^p A C -> 1
```

over a cycle `a→b→c→a`. The reaching-pairs of `p` are derived *from reads of
`p`'s own `_aggval`*, all at the same moment `m`. `p` must iterate
finalize → inner-loop → finalize until its fixpoint (all 9 pairs, incl.
self-loops). A `(relation, m)`-keyed "already finalized" dedup stops this after
the **first** round — only the three base edges get an `_aggval`, the recursive
read `p B a` sees nothing, and `p a a` is never derived. (Observed: the closure
is missing every self-loop.)

*Fix: residual-driven re-finalization.* A breakpoint is pending while its
**residual** is nonempty: fold the group at `[m,m]` and compare against the
materialized `_aggval` rows; list it iff some group/value is missing. Emit is
idempotent (deterministic `_aggval` Id over `head,key…,value,bp`), and the store
grows monotonically, so this terminates. This is safe for `p` specifically
because each reaching-pair `(A,B)` is a **distinct group** folded to `bool=1`
exactly once — a group's value never *changes*, new groups merely appear.

**2. Same-moment consumer (distinct aggregates).** Now also `count` the pairs:
`np` reads `p` and lives at the same moment `m`. `np`'s breakpoint at `m` becomes
enumerable as soon as `p` has *any* contributor at `m` — i.e. while `p` is still
growing. Finalizing `np` against a partial `p` folds a wrong intermediate count,
and the count *changes across rounds* (3 → 6 → 9), emitting several
`_aggval np m _` rows **with the same left endpoint `m`**. A `last`-read
disambiguates by left endpoint, so same-left rows are genuinely **ambiguous** —
there is no honest way to pick the final one. We must not finalize `np` at `m`
until `p` has settled at `m`.

*Fix: stratify finalization by `(moment, dependency-stratum)`.*

- **Aggregate dependency graph** over reactive relations: edge `A → B` when a
  rule that *contributes* to `B` (its head asserts a `B` tuple, `^B …`) *reads*
  `A` in its body (a reactive read, lowered to a `_aggval A` match). This is
  static, derivable from the decomposed rules + the `reactive` set. SCCs are the
  strata; a self-recursive aggregate (`p → p`) is a singleton SCC that is
  iterated to fixpoint, and a mutually-recursive cluster is one SCC iterated as a
  unit.
- **Scheduling order is lexicographic `(earliest moment, lowest stratum)`.**
  `selectEarliestTier` already yields the earliest moment; within that moment,
  finalize only items whose relation is in the **lowest stratum (SCC) that has
  pending items**, then re-enter the inner loop and repeat. A stratum is
  *drained at `m`* when no member has a pending residual at `m`; only then may
  the next stratum finalize at `m`. So `p` iterates to its fixpoint at `m`
  (residual-driven) before `np` is ever folded at `m`, and `np` is then folded
  **once**, against the settled `p`, producing a single unambiguous value.

**Why moment-primary is still correct.** A read of `A` at `m` sees only
`A`-breakpoints `≤ m` (over-persistence + last-`≤`), so `B@m` never depends on
`A@m′` with `m′ > m`. Earliest-moment-first therefore never starves a needed
input, and the stratum order only has to resolve ties *within* a moment.

**Scope limit — non-monotone self-recursion.** The residual fix is safe when a
self-recursive aggregate's per-group value is monotone (bool transitive closure;
or a count/sum consumed only in a *strictly higher* stratum, so it is folded once
after its source settles). A `sum`/`count` whose **own** value feeds its **own**
contributors would change a single group's value across rounds at one moment —
the same ambiguous same-left `_aggval` as case 2, but now unavoidable. Phase 1
requires self-recursive reactive aggregates to be monotone (reject or document
otherwise); see open question 5.

## Termination & idempotence

- Breakpoints are a subset of existing moments (finite store) ⇒ finitely many
  per group. Each `(head, key..., value, bp)` `_aggval` row is emitted at most
  once (deterministic Id dedup), and — for monotone aggregates — a group passes
  through finitely many values, so the outer loop adds finitely many `_aggval`
  rows and reaches quiescence. Gas still bounds pathological join-closure blowup.
- Re-running enumeration is idempotent but **not** keyed on mere breakpoint
  existence: a breakpoint is re-listed while its **residual** is nonempty (the
  fold at `[bp,bp]` produces a group/value not yet materialized). This is what
  lets a recursive aggregate iterate to fixpoint at one moment (single-moment
  stratification, above) instead of being skipped after the first touch — the
  coarse `(relation, bp)`-exists dedup is exactly the bug. Once the fold matches
  the materialized rows the breakpoint drops out, mirroring how
  `collectBlockedDoAggs` skips `_do-agg` rows that already have an
  `_agg-result`.

## Episodes / turn-off (phase 2, deferred)

Finite-`r` contributors turn *off* above `r_i`, so the active set is non-monotone
in `m` and the breakpoint set must include structure around `{ r_i }`, not just
the join-closure of `{ l_i }`. Phase 1 ships the `+`-fact (turn-on-only) case,
which covers the motivating examples (`last` of positions, cumulative `sum`,
`count` of current locations). Phase 2 extends enumeration to interval *exit*
moments. Land phase 1 first; keep the demand-driven `_do-agg` path available for
relations that need finite-interval aggregation until phase 2.

## Coexistence / migration

- Keep the current `_do-agg` / `_agg-result` path working; reactivity is
  **opt-in per relation** via `#reactive` (vs `#agg`). Relations declared `#agg`
  keep today's demand-driven behavior unchanged, so existing `.pres` files are
  untouched.
- Internally both share `aggregateOver`; the only divergence is the driver
  (per-firing demand anchor vs. enumerated breakpoints).

## Files to change

- `types.ts` — reserved head `_aggval`; a `reactive` flag on `SchemaDecl` (or a
  separate reactive-relation set on `Program`); breakpoint/finalization item
  types for the scheduler.
- `parse.ts` — add a `#reactive` command in `parseCommand` (`tok.name ===
  "reactive"`), reusing `parseSchemaText`, producing a `SchemaDecl` tagged
  reactive. Grammar otherwise unchanged (`foo -> X` already parses).
- `expand.ts` — `decomposeAggregate` for reactive relations: emit no per-firing
  `_do-agg`; instead register the standing aggregation and lower the consumer to
  (mode 1) a nested `last` over `_aggval`, or (mode 2) a plain `Match` of
  `_aggval`. Non-reactive path unchanged. Compose with the axis-1
  `_aggsrc_N` materialization (the source relation of a reactive aggregate may
  be an `_aggsrc_N`).
- `scheduler.ts` — breakpoint enumeration (join-closure via `leastUpperBound`,
  comparable-collapse, value-change compression), generalize
  `collectAllBlocked` / `selectEarliestTier` to pending finalizations, add a
  `finalizeBreakpoint` emitting `_aggval`. `aggregateOver` unchanged (call it at
  `[bp,bp]`). **Pending detection is residual-based**, not `(relation,bp)`
  existence: factor a `foldReactiveAt(store, head, bp, schema)` helper shared by
  the pending check and `finalizeReactive`, and list a breakpoint iff some folded
  group/value is not yet a materialized `_aggval` row (single-moment recursion).
- `expand.ts` / `types.ts` — compute the **aggregate dependency strata** (SCCs of
  the `A → B` "B contributes, reads A" graph over reactive relations) from the
  decomposed rules and attach a `aggStrata: Map<string, number>` (or SCC id) to
  `Program`, so the scheduler can order same-moment finalizations.
- `fixpoint.ts` — outer loop consumes the generalized tier items, and within the
  earliest-moment tier finalizes only the **lowest pending stratum**, re-entering
  the inner loop until that stratum's residual is drained at the moment before
  advancing (single-moment stratification).
- `store.ts` — make a runtime `leastUpperBound` → `null` a hard error under a
  dev assertion (the canary); no other change (joins already exist).
- `timeline.ts`, `default-display.ts` — hide `_aggval` as internal (like
  `_do-agg`/`_agg-result`).

## Tests (new `v2_reactive_aggregate.test.ts`)

- **Join breakpoint:** two incomparable `+` contributors; assert a value tuple
  exists at their `lub` and at neither input moment alone (the core case).
- **Threshold reaction:** cumulative `sum` crossing a threshold at a join
  moment fires a reaction (`hp 0 -> die`) anchored exactly at that join.
- **Composition (last → count):** `count` over a `last`-materialized relation;
  assert `count`'s breakpoints are finalized in tiers strictly after the `last`
  breakpoints they derive from.
- **Earliest-first / non-monotonicity:** a configuration where finalizing out of
  moment order would give a wrong intermediate value; assert the scheduled order
  yields the correct final relation.
- **Value-change compression:** a contributor that doesn't change the value
  emits no new `_aggval` row.
- **Comparable collapse:** a fully linear timeline produces ≈ one breakpoint per
  event (no join blowup).
- **Single-moment recursion:** transitive closure `p` over a cycle `a→b→c→a`,
  entirely at one moment; assert the full closure including self-loops
  (`p a a`, `p b b`, `p c c`) — guards the residual-driven re-finalization.
- **Single-moment consumer stratification:** `count`/`sum` of a same-moment
  recursive relation; assert exactly the *final* aggregate value is read (one
  unambiguous `_aggval`, no stale 3/6 left at the same moment) — guards the
  `(moment, stratum)` ordering.
- **Coexistence:** existing `#agg` / non-reactive tests still pass.

## Docs

Update `ts/src/v2/overview.md`: the `_aggval` materialization, the breakpoint /
join-closure model, the generalized breakpoint scheduler, and the relationship
to both the legacy `_do-agg` path and the axis-1 comprehension plan.

## Open questions

1. **`#reactive` vs `#agg` long-term.** Opt-in via `#reactive` is the v1 of
   this. Once phase 1 is proven, decide whether the comprehension form
   (axis-1) should default to reactive, leaving `#agg`/`#reactive` only for the
   bare `rel -> agg` schema path.
2. **Right-bounding a duration reaction.** Consumption is one mode (always a
   `last`-read), so there is *no* mode-1/mode-2 distinction. The residual
   subtlety is unrelated: a `~` episode meant to hold *exactly while* a value is
   current (e.g. "stunned while `hp = 0`") has no single right-endpoint — the
   "next breakpoint" is an antichain in the lattice. Persistent (`+`) reactions
   and momentary (`~`) events like `~die` are unaffected; only
   duration-gated-on-value episodes need a story here.
3. **Join-closure bound.** Is comparable-collapse + opt-in enough in practice,
   or do we need a demand/magic-set prune (only enumerate joins relevant to a
   consumer's threshold)? Measure on a real `.pres` before optimizing.
4. **Phase-2 turn-off** breakpoint enumeration for finite-interval episodes.
5. **Non-monotone self-recursion at one moment.** A `sum`/`count` whose own value
   feeds its own contributors changes a single group's value across same-moment
   rounds, yielding ambiguous same-left `_aggval` (single-moment stratification,
   scope limit). Phase 1 requires monotone self-recursion. Open: detect and
   reject statically (a reactive relation in its own dependency SCC with a
   non-idempotent fold), or define a fixpoint semantics (e.g. read only the
   stratum-final value) if a real `.pres` needs it.

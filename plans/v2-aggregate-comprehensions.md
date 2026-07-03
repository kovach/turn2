# v2 aggregate comprehensions

Add an inline aggregate-comprehension expression so aggregates no longer
require a `#agg` schema declaration, the fold/key/value are explicit at the
use site, and the aggregated source can be an arbitrary conjunctive body
(including nested comprehensions).

## Syntax

```
fold( KEY -> VALUE | BODY )
```

- `fold` ∈ {`sum`, `count`, `last`, `bool`} (the existing aggregator names).
- `KEY` (left of `->`) is the **group-by** term(s) — zero or more. May be
  compound.
- `VALUE` (right of `->`) is the **result binding** — the variable bound in the
  enclosing scope to the fold's output. Always present (exactly one).
  - For **value-folds** (`sum`, `last`) it *also* names the body summand, so it
    must appear in BODY. (`sum(X -> Y | total X Y)`: `Y` is the per-row value
    in the body and the total in the enclosing scope — different scopes, since
    the body lives in a separate materialization rule, so no clash.)
  - For **value-ignoring folds** (`count`, `bool`) it is a **fresh output**
    that must *not* appear in BODY (`count(X -> N | …)`: `N` is the count). The
    folded summand is an internally synthesized `unit` column.
- `BODY` (right of `|`) is a comma-separated conjunction of atoms, possibly
  containing nested `fold( ... )` comprehensions.
- Everything left of `|` (KEY and VALUE) is **bound into the enclosing
  scope** — uniformly. Body-only variables are **projected out** (existential,
  local to the comprehension).

**Grammar placement (decided):** a comprehension is valid *only as a body
conjunct* — never as a sub-term inside another atom's arguments and never in
a "value position". It behaves like an atom that binds its left-of-`|`
variables; subsequent conjuncts in the same body use them. (Nested
comprehensions are fine because they sit at conjunct positions *within* an
enclosing BODY.) This keeps the binding rule uniform — no special-casing — and
keeps the parser simple.

Examples (each comprehension is one conjunct; the bound vars are then used by
later conjuncts, e.g. an emit):

```
+total me 2
sum( X -> Y | total X Y ), + result X Y       # binds X,Y per group; emit them

# nested: for each location L, total value of tokens whose last loc is L
sum( L -> Val | last( T -> L | token T, at T L ), value T Val ), + total-at L Val
```

`#agg` and the `rel K -> W` weighted-match form are **kept working** during a
transition (see "Coexistence"); comprehensions are the new preferred form.

## Core idea: materialize the body, reuse the existing aggregate

`fold(K -> V | BODY)` lowers to:

1. a **materialization rule** that runs BODY in the fixpoint and emits one
   internal row per body solution into a fresh relation `_aggsrc_N`, with
   columns `[param..., key..., value]`;
2. the **existing** `_do-agg` / `_agg-result` producer/consumer pair over
   `_aggsrc_N` (`expand.ts:498` `decomposeAggregate`), with the KEY positions
   marked `_free` (group-by) and VALUE in the folded trailing slot.

After materialization the aggregate is *exactly* today's positional
single-relation aggregate, so `scheduler.aggregateOver` (`scheduler.ts:187`)
is reused essentially unchanged — same `keyPositions` grouping, same fold,
same tier/blocking. The only scheduler change is reading the fold name off the
tuple instead of `schema.get(head)`.

### Why this preserves correctness

Every aggregate — outer and nested — becomes a first-class `_do-agg` row in
the store, so the global tier scheduler (`selectEarliestTier`,
`scheduler.ts:137`) sees and orders **all** of them uniformly. Nested
comprehensions resolve across outer-loop rounds (`fixpoint.ts`: close aggs →
re-enter fixpoint) with no recursive evaluator. This is the decisive reason to
materialize rather than have the scheduler evaluate bodies inline.

### Correlation (full support, no magic-sets)

An aggregate inside a rule may reference variables bound by the enclosing
prefix ("params"). Because we materialize the body **unconditionally**, a
param is simply a body variable that also appears in the enclosing prefix:

- **param columns** = `vars(BODY) ∩ enclosing-prefix-bound` → become leading
  columns of `_aggsrc_N`, and are filtered positionally by their ground values
  in the `_do-agg` wrapped pattern (the trail substitutes them at Emit-intern
  time — the existing `freeify`/`prefixSeen` mechanism, just over `_aggsrc_N`).
  Because the lift happens **during decompose** (see "Sibling-rule
  generation"), the param set is read directly off `state.seen` at the
  comprehension's position — the *same* snapshot `decomposeAggregate` already
  takes. There is no second binding analysis to keep in sync.
  A param must appear in a *bindable* position inside BODY (it does, by the
  intersection condition — and in a plain conjunctive body every occurrence is
  matchable). Corner cases where a param occurs only in a non-bindable position
  (e.g. solely a `@js(...)` arg or another aggregate's value slot) can't be
  re-derived by the materialization rule — flag these as an error rather than
  silently mis-materializing.
- **key column(s)** = `vars(KEY)` → `_free` in the `_do-agg` pattern.
- **value column** (the folded summand) = VALUE for value-folds, or a
  synthesized `unit` for count/bool → folded trailing slot. The **result**
  binds via the `_agg-result` weight slot in the *enclosing* rule (not a column
  of `_aggsrc_N`), so for count/bool the result var `N` never appears in the
  materialization rule.
- **existential** = `vars(BODY)` not in any of the above → matched in the
  materialization rule but **not** columns (projected out).

This over-materializes (all param combinations are materialized, then
filtered) but is correct and needs no demand transformation. Note for later
optimization: a demand/magic-set pass could prune unused param combos.

KEY and the VALUE result var are **binding** occurrences; reusing an
enclosing-bound name there is an error (reject at expand with a clear message).

## Arity: keys (0+), one result, summand (0 or 1)

`KEY` may be **zero or more** terms. Right-of-arrow is always **exactly one**
term — the result binding (see Syntax). The folded *summand* is the body value
(value-folds) or a synthesized `unit` (count/bool) — so summand-count is 0 or
1, but that's internal; the user always writes one result term. This maps onto
the fixed wrapped-pattern layout `[head, params..., keys..., summand]` —
partition is by free-ness, not position (`scheduler.ts:237`): `keyPositions` =
the `_free` positions in `1..arity-2`, the trailing slot is always the folded
summand, bound params are filters.

- **Many keys (joint group-by)** — falls out directly: each key position is a
  distinct `_free`, so `keyPositions` collects them all and the group
  signature joins their tokens. No special-casing.
- **Zero keys (aggregate everything)** — falls out directly: empty
  `keyPositions` → single group; hits the existing zero-row branch
  (`scheduler.ts:256-258`) so empty input still yields the fold's zero.
- **No summand (`count`, `bool`)** — needs a small adaptation: the
  trailing slot is hardwired as the folded summand and is *excluded* from
  `keyPositions`, so emitting no summand column would wrongly demote the last
  key into that slot. Fix: the lift **synthesizes a `unit` summand column** in
  the materialization Emit (`_aggsrc params keys unit`). `count`/`bool` ignore
  the folded value (`aggregators.ts:26,54`), so the unit is harmless; the
  result still binds via the residual aggregate's `_agg-result` weight slot.
- **Validation:** the result var must appear in BODY for `sum`/`last` (it's the
  summand) and must *not* appear in BODY for `count`/`bool` (it's fresh
  output). Reject violations at expand with a clear message.
- **`unit` symbol:** synthesize a reserved constant (proposed `_unit`,
  `_`-prefixed so it can't be a user source head). Check it against `bool`'s
  existing parser weight-validation (`parse.ts:525`, which restricts a bool
  query weight to `0`/`1`/variable) — the synthesized path bypasses that
  validation since it's constructed programmatically, but confirm no
  downstream code assumes a bool value is `0`/`1`.

## `_do-agg` format change

Carry the fold name inline:

```
old:  (_do-agg  wrappedAtom idTpl)        fold via schema.get(head)
new:  (_do-agg  <foldSym> wrappedAtom idTpl)
```

- `collectBlockedDoAggs` (`scheduler.ts:50`) shifts slot indices by one and
  reads `terms[1]` as the fold name.
- `aggregateOver` takes `aggName` as a parameter instead of the `schema` map.
- `_agg-result` keeps its shape (head + filled key positions + weight + id).

For the kept `#agg` path, lower it to the same inline form by looking up
`schema.get(head)` at expand time and embedding the fold name — so the
scheduler has a single code path and `schema` is no longer needed at runtime.

## Lowering walkthrough

### Simple, uncorrelated

```
sum( X -> Y | total X Y )
```
- materialization rule: `total X Y  ⇒  Emit (_aggsrc_0 X Y)`
- aggregate: `Emit (_do-agg sum (_aggsrc_0 _free _free) idTpl)`,
  `Match (_agg-result (_aggsrc_0 X Y) idTpl)`
- group by col 1 (X), sum col 2 (Y) → binds X, Y. Identical to today's
  `total X -> Y`.

### Nested

```
sum( L -> Val | last( T -> L | token T, at T L ), value T Val )
```
The lift is naturally recursive via the worklist (below): decomposing the
outer rule emits the outer materialization rule (whose body still contains the
inner comprehension); decomposing *that* rule in turn emits the inner one. No
explicit bottom-up pass is needed.
- outer materialization rule `r0/agg-id0`: `last(T -> L | …), value T Val
  ⇒ + _aggsrc_out L Val` (T existential — projected out). Still contains the
  inner comprehension; re-fed through decompose.
- inner materialization rule `r0/agg-id0/agg-id0`:
  `token T, at T L ⇒ + _aggsrc_in T L`
- inner aggregate (`last`): group by T, last L → binds T, L
- outer aggregate (`sum`): group by L, sum Val
- tier order: inner intervals nest inside / start no later than outer, so
  `selectEarliestTier` closes inner first, populating `_aggsrc_out` before the
  outer `_do-agg` fires.

**Note:** a materialization rule whose BODY contains a nested comprehension is
*not* a plain Matches+Emit rule — after decompose it carries the inner
`_do-agg` Emit and `splitRule` slices it into continuation slices. This
composes (the worklist re-decomposes it), but only leaf bodies are the simple
single-Emit case.

## Sibling-rule generation — INVESTIGATED, low risk

The body must be its **own** rule (a single rule path is one binding and
cannot enumerate all body solutions to fold over). Decision: **lift during
decompose/expand**, not at parse — this makes the enclosing prefix's
`state.seen` directly available for param classification (no second binding
analysis) and lets us name synthetic rules after their source rule.

- **Mechanism.** `decomposeBody` handles a `Comprehension` RuleAtom node: it
  snapshots `prefixSeen` (as `decomposeAggregate` already does), mints
  `_aggsrc_N`, builds a fresh **pre-expand** `Rule` (`BODY ⇒ + _aggsrc_N <param
  cols, key cols, value>`), pushes it to an `extraRules` sink on `DecState`,
  and replaces the comprehension in place with the residual positional
  aggregate over `_aggsrc_N` (reusing `decomposeAggregate`).
- **Worklist in `expand`.** Replace `program.rules.map(decomposeRule)` with a
  queue: decompose a rule, collect its `extraRules`, push them back on the
  queue, repeat to fixpoint. Each extra rule then flows through the **unchanged**
  `pruneChains → splitRule → generateDeltaVariants` tail. The extra rules are
  pre-expand `Rule`s, so re-decomposing them transparently handles nested
  comprehensions (which emit further extra rules).
- **Naming.** Synthetic rules are named `${source.name}/agg-id${k}` (nested:
  the parent's synthetic name prefixes further). By expand time
  `resolveRuleNames` has already run, so `source.name` exists and is unique;
  the `/`-bearing names can't collide with user `#def` names or `r\d+`
  auto-names. *Verify a `/` in a rule name survives hashcons/serialization* —
  the name is embedded as a Symbol in chain templates
  (`chainTemplateWithHead`, `expand.ts:214`); if `*id` terms ever round-trip
  through compressRefs/parse, pick a parse-safe separator instead.
- **`_aggsrc_N`** is collision-proof: `_`-headed symbols can't be user source
  heads (`parse.ts:802` — they tokenize as Variables), and the engine already
  emits `_`-headed predicates. Needs one program-global counter.
- **Plumbing required:** add `extraRules: Rule[]` to `DecState`; have
  `decomposeRule` return it; convert `expand`'s `.map` to the worklist.
- **De-risking shortcut:** record `schema.set("_aggsrc_N", fold)` as the lift
  runs (the schema map is threaded through `expand` to the scheduler). Then the
  existing `decomposeAggregate` and scheduler work **unchanged** (scheduler
  throws only on a missing schema entry, `scheduler.ts:197`). The inline-fold
  `_do-agg` format change then becomes an **optional later cleanup**, not a
  prerequisite — first cut can ship on a synthetic internal schema map even
  though `#agg` is gone from the source language.
- **No inter-rule ordering needed:** the inner fixpoint reaches quiescence
  before the scheduler closes any `_do-agg`, so `_aggsrc` rows are present
  before the aggregate fires.

## Remaining risks / things to nail down

1. **Temporal scoping of `_aggsrc` rows.** `aggregateOver` requires candidate
   intervals to *contain* `[l, r]` (`scheduler.ts:222`). The materialization
   Emit's interval must be chosen so the outer aggregate at the outer prefix
   anchor `[XL, XR]` sees the materialized rows, and so the materialization /
   nested `_do-agg` sit at an **earlier** tier (`isPrior` = strictly-earlier
   left endpoint, `scheduler.ts:131`). Getting this wrong breaks completeness
   silently — needs dedicated tests.
2. **Column ordering consistency** between the materialization Emit and the
   `_do-agg` wrapped pattern (param cols, then key cols, then value). Since
   both are built by the same lift code from the same snapshot, this is a
   construction-discipline issue, not an open question.
3. **Synthetic rule-name separator** — confirm `/` in a rule name is safe
   through hashcons/serialization of `*id` chain templates; otherwise pick a
   parse-safe separator (see "Sibling-rule generation").

## Coexistence with `#agg`

- Keep `#agg` / `SchemaDecl` parsing and the `rel K -> W` marker path
  (`parse.ts:266,323,809`) working.
- Both forms lower to the inline-fold `_do-agg`; `schema` is consulted only at
  expand time for the legacy path, never by the scheduler.
- Existing `.pres` files and tests continue to pass unchanged.

## Files to change

- `parse.ts` — grammar **only**: parse `fold( KEY -> VALUE | atom, ... )` as a
  body conjunct into a `Comprehension` RuleAtom node (nested parse for BODY).
  Reject reuse of an enclosing-bound name as KEY/VALUE. No lift here. Keep
  `#agg`.
- `types.ts` — new pre-expand `Comprehension` `RuleAtom` variant
  (`{ tag: "Comprehension", fold, key: Term[], value: Term, body:
  RuleAtom[] }`, nestable). Keep `SchemaDecl`.
- `expand.ts` — **owns the lift.** (1) Add `extraRules: Rule[]` to `DecState`
  and return it from `decomposeRule`. (2) Convert `expand`'s `.map` to a
  worklist that re-decomposes extra rules to fixpoint. (3) `decomposeBody`
  handles `Comprehension`: snapshot `prefixSeen`, mint `_aggsrc_N`, build the
  materialization `Rule` (named `${source.name}/agg-id${k}`), push to
  `extraRules`, replace with the residual aggregate over `_aggsrc_N`
  (`decomposeAggregate`), and record `schema.set("_aggsrc_N", fold)`. The
  inline-fold `_do-agg` format change is **optional** (first cut uses the
  synthetic schema entry). Route the legacy `#agg` path the same way.
- `scheduler.ts` — inline fold name (slot shift in `collectBlockedDoAggs`;
  `aggregateOver` takes `aggName`). Positional logic otherwise reused.
- `aggregators.ts` / `getAggregator` — unchanged.
- `timeline.ts:128`, `default-display.ts` — hide `_aggsrc_N` and the new
  `_do-agg` shape as internal.
- Tests: new `v2_aggregate_comprehension.test.ts` covering simple,
  correlated, nested, empty-group, and the temporal-scoping cases; confirm
  existing `#agg` tests still pass.

## Docs

Update `ts/src/v2/overview.md` to document the comprehension syntax, the
`_aggsrc_N` materialization mechanism, the inline-fold `_do-agg` format, and
the relationship to the legacy `#agg` form.

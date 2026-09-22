# Choice components located at their ask moment

## Goal

Choices are resolved in temporal order. A choice component lives at one
moment: the moment its terms were asked at. It contains only terms asked at
that moment and only constraints emitted at that moment, and it is surfaced
when the moment walk is blocked there. A constraint that also mentions a term
asked later belongs to the later moment, and is evaluated there with the
earlier term already bound.

The motivating example:

```
a, ?X, !(opt X), +mark, ?Y, !(pair X Y), ^got X.is Y.is
```

Today this is one component `{X, Y}`. After this change it is `{X}` at the
moment `?X` was asked, and later, once `X` has a value, `{Y}` at `mark`'s
start with the row `pair <x> Y`.

## Why

Rule evaluation has to be monotone. Today a component sits at
`M = lub(left endpoints of every constrain row the closure pulled in)`
(plans/v2-choice-component-evaluation.md, plans/v2-earliest-tier-choices.md).
Which rows the closure pulls in depends on which ask and constrain tuples
exist, so deriving one more tuple at a later moment changes an earlier
conclusion: the component `{X}` at `m` with options `O` is retracted and
replaced by `{X, Y}` at a later `M` with different options. "The earliest
unresolved choice" is a non-monotone function of the ask / constrain tuples.

Locating a component at its ask moment removes that. Once the walk is quiet at
a blocked frontier moment `m`, everything the component depends on is final:
the choose rows at `m`, the constrain rows at `m`, the tuples alive at `m`, and
the `is` values of terms asked earlier. Nothing derived at a later moment can
change it. This costs some expressivity (no joint choice across moments).

## What the code does today (checked, not assumed)

1. **`?` and `!` each mint a fresh moment**, exactly like `+`
   (expand.ts, the `fact | ask | constrain` case: `l = fresh moment`,
   `r = top`, `XL < l < XR`, and the anchor advances to `l`). So in
   `pick, ?C, !opt C` the ask is at `m1 > pick.l` and the constrain row at
   `m2 > m1`. Measured on that program: `pick.l = *8`, ask `*16`, row `*27`.
2. The choice handler blocks the moment a `_choose` row starts at, so the
   frontier stops at `m1`. The component's `M` is the row's moment `m2`,
   which is **above the frontier and unresolved in every program**, not only
   in cross-moment components. The state at `m2` has not settled when the
   query runs; nothing else in the engine reads an unsettled moment.
3. Instrumenting `computeComponents` over the test suite and `ts/data/v2`:
   every surfaced component has a row whose left endpoint differs from its
   ask moment (because of 1). Components whose members were asked at more
   than one moment: 15 in the tests, and `wolf-sheep.t`
   (`?W, ?To, !(valid-move W To)`). Under 1, two ask atoms are always two
   moments, so "asked at the same moment" currently means "one ask atom"
   (`? It To`, as in `choice-test.t`).

Point 1 decides the shape of this change, so it is the first decision below.

## Decision 1: `?` and `!` stop minting moments (recommended)

Emit `_choose` and `_constrain` rows the way `^` emits: at the running anchor
`(XL, XR)`, with no `AssertLt` and the anchor left unchanged.

- `pick, ?C, !opt C`: ask and row are both at `pick.l`. The component's moment
  is the blocked frontier moment itself, which has settled.
- `?W, ?To, !(valid-move W To)` stays one joint component: nothing between the
  atoms advances the anchor. Same for dessert's `push`
  (`?It, !creature It, ^:it P It, ?To, !location To, ^:to P To, !(at It X, adjacent X To)`).
- The goal's example splits as intended: `+mark` advances the anchor, so `?Y`
  and `!(pair X Y)` are at `mark`'s start.
- "Created at the same moment" becomes something the author controls with the
  ordinary anchor rules: `^` and parenthesized matches keep the moment; `+`,
  `~`, `;` and a narrowing match move it.

The alternative keeps minting and defines "same moment" as "same ask atom".
It breaks the `?W, ?To, !(…)` idiom (each would need rewriting to `? W To`),
and a row could never share its terms' moment, so rows would have to be
evaluated at a moment other than their own. Not recommended.

Consequence to accept: an ask now blocks the anchor's own left moment rather
than a private later one. Non-monotone reads by *other* rules at that moment
wait for the choice unless their handler runs before resolution. `#agg` demand
folds and `#reactive` folds already run in `run` rounds at a blocked frontier
moment, so they are unaffected. `#acc` rows are written at `resolve`, so they
would now wait; step 6 fixes that and must land with this change.

A rule-initial `?` (no preceding match) asks at `bot` and blocks everything
until resolved. That is the correct reading of "a choice at the beginning of
time".

## Decision 2: a constraint must sit at its terms' ask moment (recommended: strict)

With decision 1, a row written directly after its `?` is at the ask moment.
A row separated from the ask by an anchor-advancing atom is not:

```
turn, ?C, ~choice C, !eligible C      -- ttt, pins, dominion, spirit-island, tests
```

- **Strict (recommended):** such a row is an error at surfacing time
  (`late-constraint-error`, naming the rule line and the term). The fix is
  mechanical: `?C, !eligible C, ~choice C` (dungeon and colors already write
  it this way). Strictness is what makes the monotonicity argument exact:
  component = rows at `m`.
- **Relaxed (fallback):** a row touching only terms asked at `m` joins `m`'s
  component wherever it was emitted, and is evaluated at `m`. No migration,
  but a constraint gated behind a non-monotone read at a later moment can
  never appear before the choice resolves and is then silently dropped. The
  diagnostic in step 5 would be the only protection.

## Semantics

Let `ask(t)` be the left endpoint of the `_choose` row that owns active term
`t`, and `T(r)` the unresolved active terms a constrain row `r` mentions after
substituting `is` values (as `gatherConstrainRows` does today, against every
blocked choose in the store, not only the seeds).

At a surfacing round with blocked moments `B`:

- **Seed terms:** unresolved terms with `ask(t) ∈ B`. No closure to other
  moments.
- **Ready row at `m ∈ B`:** `T(r)` is non-empty, every `t ∈ T(r)` has
  `ask(t) = m`, and `r.l = m`.
- **Deferred row:** some `t ∈ T(r)` is asked at a moment strictly above a
  moment of `B`. Skipped this round; it becomes ready when its latest term
  surfaces and the earlier ones are bound.
- **Late row (error):** every `t ∈ T(r)` is asked at `m`, but `r.l ≠ m`.
- **Entangled row (error):** `T(r)` has terms asked at two different moments
  that are both in `B` (incomparable asks, reachable only through a term that
  flowed across rules in a tuple). There is no temporal order to resolve them
  in. Reported with the same error kind.
- **Components:** connected components of seed terms over ready rows. Rows
  only connect same-moment terms, so every component has one moment `m`, and
  the query evaluates every sub-atom at `m` (`intervalContains(cand, m, m)`,
  `aggregateOver(…, m, m)`), as it does at `M` today.
- **Empty fringe:** a seed term with no ready row, as today. New way to reach
  it: all of the term's rows are deferred. The message should say so ("its
  only constraints also mention `?Y`, asked later; ask them at the same
  moment, or constrain `X` on its own").

Dead choices, rng resolution, actors, and `is` substitution are unchanged.
The temporal-monotonicity argument for dead choices gets stronger: `m` is a
settled frontier moment, so a zero-option component really cannot gain
options.

Chained choices at one moment (`?A, !(opt A), A.is V, ?B, !(next V B)`) still
work: after `A` commits, the inner loop emits `?B` at the same `m` before the
next walk round, so `m` is blocked again and `{B}` surfaces there.

## Steps

1. **expand.ts.** Route `ask` and `constrain` through the `anchor` case in the
   emit lowering: `emitL = XL`, `emitR = XR`, no `freshMomTemplate`, no
   `AssertLt`, and the anchor-update switch returns `{ XL, XR }` for them.
   Check nothing reads `BlockedChoose.r` or a constrain row's `r` as `top`.
2. **constraint-query.ts.**
   - Record `ask(t)` while gathering the choice context (`askByTok`, from each
     `BlockedChoose.l`; one owner per term is already enforced).
   - Replace the seed closure and `buildComponents`' cross-moment BFS with the
     rules above: classify each row ready / deferred / late / entangled;
     build components per blocked moment from ready rows.
   - Delete `choiceComponentMoment`; `runComponent` takes `m` from its
     component. `ComponentOptions.moment` becomes the ask moment (update the
     comment in types.ts; default-display.ts already only needs "the moment").
   - New result kind `late-constraint-error` (`row`, `activeTerm`, `askMoment`,
     `reason: "late" | "entangled"`), and the extended empty-fringe message.
3. **fixpoint.ts / types.ts.** New `FixpointStatus` `late-constraint-error`,
   returned like `empty-fringe-error`. Surface it in web-v2.ts, v2-cli.ts and
   pres/render.ts wherever `empty-fringe-error` is handled.
4. **Corpus migration** (decision 2 strict): move `!` ahead of the
   anchor-advancing atom in `ttt.t`, `pins.t`, `dominion.t`,
   `spirit-island.t`, and the inline programs in the tests
   (`?C, ~choice C, !opt C` in v2_acc / v2_acc_view and others — find them by
   running the suite; the new error names the line). Update
   `discussions/turn-tutorial.md` where it shows the old order.
5. **Never-applied diagnostic.** Keep the set of `_constrain` row indices that
   were part of some evaluated component (or were reported as an error). At
   the end of a run, a row that mentions a choice term, was never evaluated,
   and whose terms are all resolved was emitted too late to apply (its rule
   was gated behind a non-monotone read above the ask moment). Report as a
   warning in `FixpointResult` (not a failure): the run is otherwise valid.
6. **Acc becomes a stage before resolution** (required by decision 1; also
   the whole of "acc inside `!(...)`"). A frontier moment passes through:
   *created* → *folds quiet* (a walk round at it adds nothing: `#agg` demand
   folds and `#reactive` values have settled) → *acc written* → *resolved*
   (no pending choice at it). Today acc is written by the `resolve` hook,
   after marking; move it ahead of marking, for every frontier moment, not
   only blocked ones:
   - when a round is quiet, write acc rows at each frontier moment that has
     none yet (track the computed moments; acc is written once per moment);
   - the rows are progress, so re-enter the inner loop: readers at `m` fire
     and may emit at `m`, including new `?` / `!` rows there;
   - on the next quiet round, a moment with no pending choice is marked
     resolved and the frontier advances; when every frontier moment has a
     pending choice, surface (rng and dead components resolve without
     yielding, as today).
   This is one mechanism instead of "early for blocked moments, at `resolve`
   for the rest", and it removes a late path: today a reader of acc at `m`
   that then asks at `m` (possible once `?` stops minting moments) would mint
   its choose row at an already-resolved moment. The `resolve` hook on
   `MomentHandler` can go if nothing else uses it.
   Acc at `m` is thereby "the state at `m` once its folds are quiet, before
   the choices at `m` resolve", for every reader; what readers and choice
   continuations emit at `m` afterwards is not folded into `m`'s rows (the
   existing snapshot rule, with the boundary moved earlier). `#agg` /
   `#reactive` folds may still run at `m` after acc is written; acc does not
   see them. Known limit, to document and test: a second choice chained at
   the same moment sees the acc state from before the first; put it at a
   later moment (`;`, `+`) to see the effect.
   Then remove the `!(...)` guard in `buildConstrainRowAtom` (keep the arity
   check, reject `-> weight`): the plain sub-atom path already matches a
   point row at `[m, m]`. Display bookkeeping: record `m` in
   `store.accConsulted` for acc sub-atoms and count them toward
   `readByRules`.
7. **Docs.** overview.md (`expand.ts`, `constraint-query.ts`, `fixpoint.ts`,
   `scheduler.ts`, `acc.ts` sections; the "lub" language goes), the tutorial's
   choice section (where a constraint must sit; how to get a joint choice;
   how to sequence two), a pointer in
   plans/v2-choice-component-evaluation.md and
   plans/v2-earliest-tier-choices.md that this plan supersedes the lub and
   the closure, and plans/v2-acc-relations.md §10.

## Tests

- The goal example: first surfacing is `{X}` with `opt`'s options and
  `moment = ask(X)`; after `is X x`, `{Y}` surfaces with `pair x _`'s options.
- Monotonicity: the component and options for `X` are identical with and
  without the later `?Y … !(pair X Y)` tail in the program.
- Every surfaced component's moment is a blocked frontier moment (or a late
  demanded one): resolved-below, never above the frontier. Assert over the
  whole choice test corpus.
- `?W, ?To, !(valid-move W To)` and `? It To` both give one joint component.
- Late row: `?C, ~choice C, !opt C` reports `late-constraint-error` naming the
  line; the reordered program runs.
- Deferred-only term: `?W, +step, ?To, !(valid-move W To)` reports the
  extended empty-fringe message.
- Entangled incomparable asks through a stored term: error.
- Chained same-moment choices `?A … A.is V, ?B, !(next V B)`.
- Dead choice, rng commit, mixed actors: existing tests pass after migration.
- Rule-initial `?` blocks `bot`.
- Never-applied diagnostic: a constraint gated behind an acc read placed after
  an anchor-advancing atom produces the warning.
- Step 6: acc in a key and in a value position of `!(...)`, a recursive
  relation, keyed-absent gives a dead choice, keyless zero row matches,
  snapshot-before-choice for an ordinary reader at the same moment, and the
  chained-choice limit.
- `spirit-island.t` (currently fails to compile on the `!(...)` guard) loads.

## Risks

- Moment structure changes for every program with a choice (two fewer moments
  per ask/constrain pair). Tests that pin token-level or moment-count details
  will shift; timeline collapse keys and `momentKey`s are structural and
  survive.
- An ask at an episode's own left moment holds back everything that reads
  non-monotone state at that moment until step 6 is in. Do not land steps 1-5
  without it.
- Saved `^ is <term> <value>` rows in user files name choice terms by their
  id templates, and every template embeds the rule's `(*chain …)`, which
  includes the `l`/`r` of each earlier emit in the rule. Today an earlier `?`
  or `!` contributes a minted `(*mom …)` there; after decision 1 it
  contributes the anchor's endpoints instead. So the identity of any choice
  term that follows another `?` / `!` in its rule changes, and saved rows for
  it stop matching (the choice is simply asked again). A rule's first ask is
  unaffected. In `ts/data/v2` only `colors.t` has saved rows; regenerate them
  as part of step 4, and say so in the change notes for files outside the
  repo.

## Not in this change

- Joint choice across moments. If it is wanted later it needs an explicit
  construct, not an emergent lub.
- Source links for acc bars (discussed separately; depends on step 6 only in
  that acc-in-`!()` programs become writable).

## As implemented (2026-09-21)

Both recommended decisions. Differences from the steps above:

- **Step 5 became a structural check, not a warning.** "Never evaluated" is
  the wrong test: a choice resolved by a saved `is` row never surfaces, so
  all of its constraints would be flagged. Instead every `_constrain` row is
  checked for *placement* — it must sit at the ask moment of the latest
  choice term it mentions, with the others asked at or below it — before
  components are built, and again at `done` (`checkConstrainPlacement`) for
  rows whose choices never surfaced. A misplaced row is the
  `late-constraint-error` status (reason `late` or `entangled`) in both
  places.
- **Step 6 uses a new `settle` hook and `store.settled`**; the `resolve` hook
  is gone. acc-view.ts keys "value ended" / open bars and the inspector on
  `settled`, since a moment with a pending choice now has acc rows.
- **Cross-rule constraints survive**, which the plan did not spell out: another
  rule can constrain a choice if it reaches the ask moment, reading the choice
  through a parenthesized match (`turn, (choice C), !good C`). Used to migrate
  `dominion.t` (choose-action adds `!action` to choose-card's ask) and the
  compound-constraints test.
- **Migrated:** `ttt.t`, `pins.t`, `colors.t`, `dominion.t`,
  `spirit-island.t` (which now loads: it reads an acc relation inside
  `!(...)`), the tutorial, and the inline test programs. The first surfaced
  choice of every program in `ts/data/v2` offers the same options as before
  the change (compared against the engine at HEAD).
  `src/tests/fixtures/dungeon-play.t` was regenerated with
  `ts/src/replay-choices.ts`, since its saved rows named choice terms by
  the old identities.
- **Not migrated:** the `.pres` decks. `presentation.pres` shows
  `?Card, ~it Card, !card Card` and "composable choice" as
  `earthquake, choose-card, it C, !sturdy C`; under this change those read
  `?Card, !card Card, ~it Card` and `earthquake, choose-card, (it C), !sturdy C`.

plan author: Claude Fable 5.1 (claude-fable-5-1), 2026-09-21

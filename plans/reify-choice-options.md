# Reifying choice option tuples

Replace the bespoke "lift component → run unifier → collect tuples" pipeline
in `ts/src/constraint-query.ts` with a uniform mechanism: at the moment the
fixpoint pauses on active choices, inject a synthesized pattern rule per
constraint component whose head is `+ _option C V1 ... Vn`, run that rule
through the normal evaluator, and read the resulting `_option` rows out of
the store. The pause condition then becomes "an `_option` row exists for a
choice that has not been resolved by an `is`-row".

Spec source: `notes/overview.md` §"reifying choice option tuples".

## Goals

1. Option enumeration uses the same evaluation primitives (`step`,
   `unifyTree`, hashconsing, store dedup) as ordinary rule firing — no
   parallel pattern-construction-and-walk path in `constraint-query.ts`.
2. Option results are first-class store rows, indexed under the reserved
   predicate `_option`. They become inspectable in the result tree and the
   UI reads them via the normal store API.
3. Mid-fixpoint rule injection is a general facility, not a choice-specific
   hack — future passes (e.g. forward-chained explanations, debug probes)
   can reuse it.

## Assumption: safe rules

Following the overview, the injection facility is only used on rules `P'`
that satisfy

    fix(P + P', ∅) = fix(P + P', fix(P))

i.e. injecting `P'` after running `P` to fixpoint yields the same store as
running `P + P'` from scratch. Concretely, the option-enumeration rules
read from `_choose`/Constrain rows and write only `_option` rows; the
reserved-prefix rule (`parse.ts:206`) already forbids user code from
asserting or matching `_option`, so by construction these injected rules
cannot perturb the base program's reachable facts. This is the only class
of injection we plan to support.

## Stage 0 — Constrain bodies as Tree patterns

The current `Constrain` Tree variant carries a flat `TreeBody` (`id`,
`atom`, `children`). `! q X Y` is parsed as a Constrain whose atom is
`q X Y`; partition (`gatherChoiceContext`,
`unresolvedTermsTouched`) reads `row.atom.terms` directly. This shape
is too narrow for the rest of the plan: we need constraint bodies that
can hold joins, temporal literals, and aggregators — anything a normal
rule body can hold — so the lift can embed the whole body under the
anchor `_choose` and have the temporal-anchoring property fall out for
free.

### Tree variant

`Constrain` becomes body-bearing with a single `body: Tree` field
(no `atom`, no `children`):

```
| (TreeBase & { tag: "Constrain"; body: Tree })
```

The `body` Tree is the constraint's matching pattern; its root is
whatever sub-pattern shape the user wrote (typically a sibling-block
of `<` / `,` / `#` literals).

### Surface syntax

`!` on a line by itself, with the constraint body as the indented
sub-tree:

    + game
      + square a1
      + square a2
      + square a3
      ? Sq
      !
        < square Sq

### Store row representation

A Constrain rule firing inserts a Constrain row that carries the body
(as the Tree). `gatherChoiceContext` walks that body for unresolved
choice term references instead of `row.atom.terms`. Component
adjacency: a Constrain joins the component for every unresolved
choice term its body references anywhere.

### Lift behaviour

For each Constrain in a component, `liftComponentToRule` rewrites the
body's term occurrences (active → `_V_choice_i`, existentials →
`_V_exist_i`, resolved → concrete) and embeds the rewritten body as a
child of the anchor `_choose` Match. Multiple Constrains' bodies
become multiple sibling sub-trees under the anchor.

### Semantic shift

Embedding the body under the anchor `_choose` puts the body in the
*temporal context* of the choice. Constraint bodies should therefore
use temporal literals (`<`, `,`) rather than `-` Match — a `-`
literal inside the body would require descent from the `_choose` row,
which is rarely what the user wants. This is a deliberate change from
today's flat-atom Constrain (which had no temporal context); the
ergonomics are also better, because rules like the TTT eligibility
rule can fold their body directly into the choice's constraint:

    - game
      ? Cell
      !
        < cell Cell
        # count -> z
          < fill Cell _

replaces the current two-rule pattern in `ts/data/ttt.sl` (the
`eligible T Cell` predicate plus the rule that produces it).

### Implications for the lifted rule shape

- Constraint bodies use temporal literals, so the wildcard empty-atom
  root that `runComponent` builds today purely for descent flexibility
  is no longer needed for that reason. For single-`_choose` components
  the lifter can root the rule directly at the anchor `_choose` Match.
- Multi-`_choose` components still need an outer wrapper so the
  multiple `_choose` Matches can sit as siblings (they're separate
  rows; descent doesn't relate them). Wildcard root is the natural
  wrapper; whether to also drop the wrapper for the single-choose
  case depends on whether `unifyTree`'s entry-point check
  (`unify.ts:315`, `pattern.atom.terms.length === 0`) is relaxed.
  Default: keep the wildcard wrapper in both cases (no API change);
  the generalization is a follow-up.

### Files to change for Stage 0

- `ts/src/types.ts` — Constrain shape (drop `TreeBody`, add `body`).
- `ts/src/parse.ts` — `!` body-line syntax; decide whether to keep
  `! q X Y` as one-line sugar.
- `ts/src/refstore.ts` — Constrain row stores the body.
- `ts/src/expand.ts` — Constrain body walks (delta-variant elision
  rules need to handle the new shape).
- `ts/src/constraint-query.ts` — partition walks body, not atom.
- `ts/src/step.ts` / `ts/src/unify.ts` — verify nothing assumes
  Constrain carries a flat atom.
- Tests — update fixtures; rewrite TTT's eligibility rule using the
  body-bearing constraint form.

### Open questions for Stage 0

- **Body storage.** Hashcons the body as a single Term on the row, or
  keep the Tree directly? Hashcons composes with the rest of the
  engine's interning; the Tree form is simpler but puts a non-Term
  object on the row. Pick during implementation.
- **Backward-compat sugar.** Keep `! q X Y` as a one-line shorthand
  for `!\n  < q X Y` (or `,`)? Decide based on how often existing
  programs use the flat form — if it's most of them, sugar pays for
  itself.

## Stage 1 — mid-fixpoint rule injection

`fixpoint.ts:innerFixpoint` currently iterates a fixed `patterns: Tree[]`
list (delta-variant-expanded ahead of the main loop in `fixpoint.ts:49`).
The injection facility extends `innerFixpoint` to accept additional rules
that come in *after* some existing facts have been derived.

### Surface

```
injectRules(rules: Tree[]): void
```

invoked between outer-loop turns in `fixpoint.ts:while (true)`. The added
rules are appended to the active pattern set, paired with metadata that
tells the inner loop how to evaluate them on first contact.

### Semi-naive interaction

The base evaluator drives semi-naive via `generateDeltaVariants` and the
`any/delta/old` constraint check in `unify.ts:passesConstraint`. A rule
injected at iteration `k` has never fired, so its first run must observe
*every* existing row — equivalent to the lift's
`Number.MAX_SAFE_INTEGER` trick in `constraint-query.ts:227`. Two viable
implementations:

- **Catch-up pass.** Run each injected rule once with a special
  "iteration = ∞" marker that makes every constraint variant match (any
  rows older than k, delta rows from any prior step, etc.). Then expand
  the rule into normal delta variants and add it to the live pattern
  list. This preserves semi-naive after the catch-up.
- **One-shot.** Run the rule once at iteration ∞ and never again. Cheaper
  if the rule is idempotent and only consumed at the pause boundary, but
  loses reactivity if base facts later change.

Stage 1 ships the catch-up form. Option rules are dropped after their
catch-up pass (Stage 3 §Lifecycle) so the distinction collapses for the
choice use case, but a future probe-style use will want the live form.

### Files

- `ts/src/fixpoint.ts` — accept injected rules; call catch-up before
  resuming the inner loop.
- `ts/src/expand.ts` — expose a single-rule variant of
  `expandAll`/`generateDeltaVariants` for use by the injector.
- `ts/src/unify.ts` — add the iteration-∞ mode, or document that
  `Number.MAX_SAFE_INTEGER` already serves (the existing
  `passesConstraint` returns true for `any` whenever `gen < iteration`,
  which already passes for every row when `iteration = MAX`).

## Stage 2 — component → option rule lifting

Builds on Stage 0's body-bearing Constrains. The existing
`runComponent` (`constraint-query.ts:146`) becomes
`liftComponentToRule`, with two structural changes:

1. **`liftComponentToRule(comp, ctx) -> Tree`** — produces a positive
   rule rooted at the anchor `_choose` Match. The bodies of the
   component's Constrain rows (rewritten: active terms →
   `_V_choice_i`, existentials → `_V_exist_i`, resolved terms
   substituted) are inserted as children of the anchor; the emit

       + _option <componentId> <V_active_1> ... <V_active_n>

   sits alongside them, also as a child of the anchor. `<componentId>`
   is the synthetic component id (§"Component identity"); the anchor
   is the lex-smallest chooseId in the component (§"Multi-`_choose`
   components").

2. **Drop `runComponent`'s `seen` Set + visit callback.** Dedup
   happens automatically once `_option` rows go through the
   hashconsed store-insert path (`step.ts` already collapses
   duplicates per `refstore.ts:insertChild` semantics).

### Worked example: simple constraint

Source:

    + square a1
    + square a2
    + square a3
    ? Sq
    !
      < square Sq

After `expand`'s `Ask → Assert(_choose)` rewrite (`expand.ts:67`),
the choice rule has produced a `_choose <ck> Sq` row, plus a
Constrain row whose body is `< square Sq`. The component graph has
one component: active terms = `{Sq}`, Constrain bodies =
`{< square Sq}`, existentials = ∅.

The lifted rule:

    - _choose <ck> _V_choice_0
      < square _V_choice_0           (constraint body, child of anchor)
      + _option <cid> _V_choice_0    (emit, child of anchor)

For the entry-point requirement that `unifyTree` expects an empty-atom
wildcard root (`unify.ts:315`), the lifter wraps the above in such a
root unless the entry-point check is relaxed (Stage 0 §"Implications
for the lifted rule shape"). The wrapper is structurally inert in the
single-`_choose` case.

The catch-up pass evaluates this rule against the saturated store and
emits three `_option` rows: `_option <cid> a1`, `_option <cid> a2`,
`_option <cid> a3`, each parented to the anchor `_choose` row in the
store (see §"Temporal anchoring" below for why the anchor matters).

### Worked example: aggregator inside the constraint

Source (a TTT-style cell-eligibility check, folding the
`eligible T Cell` predicate from `ts/data/ttt.sl` into the choice
itself):

    ? Cell
    !
      < cell Cell
      # count -> z
        < fill Cell _

Lifts to:

    - _choose <ck> _V_choice_0
      < cell _V_choice_0
      # count -> z
        < fill _V_choice_0 _
      + _option <cid> _V_choice_0

The `#`-aggregator is a child of the anchor `_choose` Match. When the
rule fires, the agg-instance it emits lands as a child of the anchor
`_choose` row in the store — exactly the temporal anchoring §"Temporal
anchoring" requires for the agg to fold ahead of the next pause.

### Multi-`_choose` components

A component can pool more than one `_choose` row when constraint
bodies share variables across them — e.g. `? X` and `? Y` joined by

    !
      < pair X Y

produces one component with two `_choose` rows
(`_choose <c1> X`, `_choose <c2> Y`) and one Constrain row whose body
references both. The lifted rule needs an outer wrapper because the
two `_choose` Matches sit as siblings (separate rows; no descent
relation):

    [wildcard root]
      - _choose <c2> _V_choice_1        (non-anchor choose, sibling)
      - _choose <c1> _V_choice_0        (anchor choose, sibling, last)
        < pair _V_choice_0 _V_choice_1  (constraint body, child of anchor)
        + _option <cid> _V_choice_0 _V_choice_1

The anchor (lex-smallest chooseId in the component; deterministic and
stable within a single fixpoint run) goes last so every non-anchor
sibling's variables are bound when its body fires. All Constrain bodies
in the component, plus the emit, are children of the anchor `_choose`
Match. Non-anchor `_choose` Matches contribute only their variable
bindings; they are not parents of any emit.

The asymmetry — emits are contained in the anchor only, not the other
component members — is intentional and sufficient: §"Temporal
anchoring" below shows why having the anchor be `prior` to any
emitted agg-instance is enough to drive the scheduler, even when the
non-anchor chooses are not.

### Temporal anchoring

The lifted rule's emits — `_option` rows and any `agg-instance` rows
created by aggregator nodes inside the constraint body — land as
*children* of the anchor `_choose` row's match-image in the store.
The standard `parent:child(anchor_choose, emit)` edge handles this;
`before:after` edges follow the usual `step.ts` rules.

The point of this anchoring is the agg-fold scheduler. `selectEarliestTier`
uses `prior = before ∪ contains⁻¹` (`plans/temporal-relationships.md`
§Aggregate interaction), so a node *contained in* the anchor `_choose`
row is prior to it. If a constraint body includes an aggregator
(`#`-prefixed), firing the lifted rule emits an `agg-instance` as a
child of the anchor `_choose` — that instance is therefore prior to
the anchor `_choose`. On the next outer-loop turn,
`selectEarliestTier` picks the agg-instance as part of the earliest
tier, folds it, and the resulting `agg-result` row is in the store
before the catch-up rule re-fires against it. The `_option` row
finally appears once every agg the constraint depends on has been
folded.

If the rule's emits were top-level (parented to the program root),
nothing would order them prior to the anchor `_choose` row;
`selectEarliestTier` would re-pick the choose, the catch-up would
re-emit the same unfolded agg-instance, and the loop would never
close. Anchoring under a matched `_choose` row is what makes the
agg-then-option sequencing fall out of the existing scheduler.

For multi-`_choose` components the anchor is asymmetric: emitted
agg-instances are prior to the anchor choose, but they're temporally
incomparable to the non-anchor chooses in the same component (no
`contains` or `before` edge connects them). This is fine.
`selectEarliestTier` picks the earliest paused agg-instance plus
everything incomparable to it — so the agg and the non-anchor chooses
all land in the earliest tier together. Because aggs in the earliest
tier fold first regardless of co-tier choices (`fixpoint.ts:74-84`),
the agg folds before any choice in the component pauses for input. By
the next outer turn, all agg dependencies are resolved, the catch-up
fires once per joint binding across every component-member `_choose`,
and `_option` rows appear before the next pause attempt.

### Well-formedness of generated rules

User-written programs where a choice is temporally before an
aggregate its constraint references are user error and out of scope.
What this stage owns is making sure *generated* rules don't introduce
that pathology. The structural invariant the lifter must maintain:

- The anchor `_choose` Match exists in every lifted rule, and every
  Constrain body and the `+ _option` emit is a child of that anchor.
- In particular, every aggregator (`#`-node) the lifter pulls in from
  any Constrain body lands as a descendant of the anchor `_choose`
  Match — never as a sibling and never above it.

The first follows from how the lift plants Constrain bodies (always
children of the anchor); the second is preserved automatically because
the body Tree is embedded as a unit and the lift never reaches into
its interior to relocate aggregators. A regression-guard test that
lifts a component whose constraint body contains a `#` and asserts
the emitted Tree's structure (anchor `_choose` Match present;
aggregator in its sub-tree) is worth keeping in the suite.

### Component identity

`_option` rows must group by component so the UI can render one option
list per component (today's `ComponentOptions` shape). Use a synthetic
`Id` term: hashcons an `Id` whose body is the sorted list of the
component's active-term tokens. Stable by construction; doesn't depend
on `_choose` row insertion order. Composes with the existing Id-Term
plumbing (`plans/separate-id-terms.md`).

Within a single fixpoint run the partition is fixed (no base facts are
derived during the choice-pause boundary), so component identities don't
shift mid-run; the only place identity has to remain stable is across
catch-up + outer-loop turns within one `fixpoint()` invocation, which the
synthetic Id satisfies trivially.

### Existentials and resolved terms

These keep their current treatment:
- Existentials are universally-bound variables in the rule body and never
  appear in the `_option` head — different existential bindings that
  yield the same active tuple collapse via store dedup, matching today's
  `seen` Set.
- Resolved choice terms are substituted in at lift time.

## Stage 3 — pause and resume

### Pause check

The direct `computeComponents` call (`fixpoint.ts:89`) is replaced with
calls into the partition + lift API exported from
`ts/src/constraint-query.ts`:

1. Call the partition entry point (the rewritten `computeComponents`
   that now returns the partition + rewrite map without running the
   query) to get the components for the current pause.
2. For each component containing at least one *active* term: call
   `liftComponentToRule` and inject the result via Stage 1's facility.
   Components whose lifted rule would have no Constrain body sub-tree
   (zero bodies reference the active term) raise `empty-fringe-error`
   *at lift time* and short-circuit the whole pause — see
   §"Empty-fringe error".
3. Run the catch-up. Injected rules write `_option` rows. The catch-up
   may also emit `agg-instance` children of the anchor `_choose`; if
   so, the next outer-loop turn picks them as the earliest tier and
   folds them before this pause check re-runs (§"Temporal anchoring").
4. Classify each unresolved `UnresolvedChoice` (a `_choose` row no
   `is`-row has pinned) by scanning `_option C V*` rows where `C` is
   the choice's component identity:
   - **At least one `_option` row** → *live* choice with that option
     list. Reported in the pause.
   - **Zero `_option` rows** → *dead* choice. The component's
     constraint bodies are well-formed (otherwise step 2 would have
     short-circuited) but produce no joint binding against the current
     store. There is no decision to make here; the choice is dropped
     from scheduling for the rest of this `fixpoint()` call (see
     §"Dead-choice marking" below) and the outer loop continues.
5. Decide what to do:
   - **≥1 live choice** → pause with `kind: "active-choices"`,
     reporting only the live choices in `components`.
   - **All earliest-tier choices dead** → no pause. The dead marker
     keeps them out of the next `collectSchedulables`, so the next
     outer-loop turn either picks a later-tier schedulable (folding
     aggs or pausing on later choices) or sees an empty schedulable
     list and reports `kind: "done"`.

The pause condition is therefore "at least one *live* choice in the
current earliest tier". An all-dead earliest tier is indistinguishable
from those choices having been resolved — the run keeps going.

### Dead-choice marking

A dead classification must be remembered for the rest of the
`fixpoint()` call, otherwise the next outer-loop turn re-collects the
same `_choose` row, re-lifts the same rule (whose catch-up will
re-emit zero options against the same saturated base facts), and the
loop spins.

Dead-ness is monotone within a run. The catch-up has already exposed
every reachable joint binding against a saturated base — base facts
do not change mid-run, and the option rule is read-only over `_choose`
and Constrain bodies (the safe-rule assumption, §"Assumption: safe
rules"), so a choice that classified dead at iteration `k` cannot
gain options at any later iteration of the same `fixpoint()` call.

Mechanism: emit a reserved-prefix row

    + _dead-choice <chooseId>

at classification time, parented to the active `_choose` row's
match-image (so it inherits the choice's temporal anchoring; doesn't
matter much here, but keeps it consistent with other reified state).
Extend `collectUnresolvedChoices` (`scheduler.ts:21`) to also build a
set of dead chooseIds from the `_dead-choice` index and filter
`_choose` rows whose id is in that set — same shape as the existing
`is`-row resolution check immediately above it. The row is invisible
to user code via the reserved-prefix rule (`parse.ts:206`) and
naturally rebuilds on the next `fixpoint()` invocation against fresh
base facts (`web.ts:560 run()` builds a fresh `RefStore`), so a
choice that was dead in run N can become live in run N+1 without any
extra plumbing.

### Empty-fringe error

The current `computeComponents` short-circuits when an active term
sits in a component with zero Constrain rows
(`constraint-query.ts:267-283`). Under reified options the analogue
is "the active term's component has zero Constrain bodies referencing
the term" — detect at lift time (the lifted rule's body would have no
sub-tree besides the `+ _option` emit) and raise `empty-fringe-error`
directly. Critically, this is *not* the same as "the catch-up
produced zero `_option` rows": a non-empty body that prunes everything
is the §"Pause check" empty-options case (well-formed, no error),
not an empty-fringe-error.

### Lifecycle

After the user resolves a choice (UI emits an `is` row), the next
fixpoint run starts from scratch (`web.ts:560 run()` re-enters
`fixpoint`, which builds a fresh `RefStore`). So injected rules don't
need to persist across runs; they're rebuilt inside each fixpoint
invocation.

A consequence worth calling out: synthetic option-rule generation only
fires for components with **at least one unmade choice** (active term
with no `is`-row). Once every active term in a component has been
pinned, that component drops out of `UnresolvedChoice` enumeration, no
rule is lifted for it, and its constraint body is not re-evaluated on
subsequent fixpoints. This is the desired behaviour — replaying a
constraint query whose answer is already pinned is wasted work — and
falls out for free from the rule being non-persisted: the synthetic
rule lives only as long as the pause that produced it.

### web.ts / UI

`web.ts` currently reads `status.components` (`web.ts:599`) and passes
them through to display modules via `DisplayCallContext`. Stage 3 keeps
`ComponentOptions` in `FixpointStatus`: after the catch-up, scan
`_option` rows out of the store and rebuild the `ComponentOptions[]`
array. Minimal UI churn — the reification is internal.

The only display module today is `ts/data/ttt.js`, so a follow-up that
drops `ComponentOptions` entirely (in favour of an `_option`-row query
inside the display module) only has to update one consumer. Worth doing
once the rest of the plan lands.

## Stage 4 — retire the lift-and-run pipeline

`constraint-query.ts` keeps its current home and continues to own the
component logic. After Stage 3:

- `buildComponents`, `gatherChoiceContext`, and `unresolvedTermsTouched`
  stay where they are and are imported by `fixpoint.ts` to decide which
  rules to inject.
- `runComponent` and the dedup `seen` Set are removed; their job is
  taken over by Stage 1's catch-up + store dedup.
- `computeComponents` is rewritten to return the partition + rewrite
  map (active/existential/resolved terms) without running the lifted
  query. `fixpoint.ts` calls it once to get the components, then
  invokes `liftComponentToRule` per component to produce the rules
  it injects via Stage 1's facility — matching the two-call sequence
  in Stage 3 §"Pause check" steps 1-2.

`liftComponentToRule` lives in `constraint-query.ts` next to the
partition logic — same module, smaller surface.

## Files to change

Not exhaustive. Stage 0 has its own list under §"Files to change for
Stage 0"; the entries below cover Stages 1–4.

1. `ts/src/fixpoint.ts` — rule injection hook; per-choice pause
   classification.
2. `ts/src/expand.ts` — single-rule expansion entry point.
3. `ts/src/unify.ts` — confirm iteration-∞ semantics; small comment.
   Optionally relax the empty-atom-root entry-point check
   (Stage 0 §"Implications for the lifted rule shape").
4. `ts/src/constraint-query.ts` — keep partition logic in place; add
   `liftComponentToRule`; remove `runComponent` and its dedup `seen`
   Set. Exports are imported by `fixpoint.ts`. Partition walks each
   Constrain's `body` Tree (Stage 0).
5. `ts/src/parse.ts` — `_option` joins the reserved-prefix predicate
   list (already covered by the generic `_` rule, but worth a
   comment); the body-line `!` syntax is added under Stage 0.
6. `ts/src/web.ts` — Stage 3 first variant: no change. Stage 3
   follow-up: read `_option` rows directly.
7. Tests — `constraint-query.test.ts` retargets at
   `liftComponentToRule` plus end-to-end through `fixpoint`. Add an
   injection-facility test that asserts catch-up sees pre-injection
   facts; add the well-formedness regression-guard test from Stage 2;
   add the empty-options pause classification test from Stage 3;
   add an existential-bearing component test that asserts the
   `_V_exist_*` rewrite plus store dedup collapses multiple
   existential bindings into a single `_option` row per active tuple
   (covers §"Existentials and resolved terms" — the mechanism is
   otherwise unexercised by the worked examples in Stage 2).

## Open questions

- **Aggregator-bearing constraints — test coverage.** §"Temporal
  anchoring" above explains how the lifted rule's `_choose`-rooted
  match makes any agg-instance the rule emits prior to the choose
  row, so `selectEarliestTier` folds it ahead of the next pause
  attempt. The mechanism is mechanical, but it interacts with several
  pieces (`step.ts`'s `parent:child` emission, `prior`'s
  `contains⁻¹` clause, `closeAggregates`) that haven't been exercised
  together this way before. Land a test that lifts a component whose
  constraint includes a `#`-aggregator, runs through `fixpoint`, and
  asserts that (a) the agg-instance is folded before the second pause
  attempt and (b) `_option` rows reflect the post-fold values. A
  stacked-aggregator variant (inner `#` referenced by outer `#` inside
  the constraint) is worth a second test for transitive fold
  ordering.

## Corrections

Earlier drafts of this plan tried to handle aggregates inside
constraints by extending the *outer fixpoint scheduler* (dependency
lifts, choice-priority demotion, etc.). That framing was wrong and was
corrected by the following message:

> this doesn't sound like the issue I was anticipating. the current
> plan has a synthetic rule that has no temporal relationship to the
> choice it handles. if that rule contains an `agg-instance`, it needs
> to be a child of the `ask` node, so that we know it's the earliest
> thing and gets selected for unfolding by the fixpoint. re: your
> first sentence, it shouldn't be possible for a choice to be
> temporally before an aggregate that its constraint references; we
> can write a program like that, but imagine it as user error for now.
> we need to make sure our generated rules are not erroneous

The fix is structural — make the lifted rule match the active
`_choose` row at its root so every emit is contained in (and thus
`prior` to) that row — not algorithmic. Sections of the plan affected:

- **Stage 2 §`liftComponentToRule`.** Rule shape changed: the root is
  a Match against the active `_choose` row; constraint matches and
  `+ _option` are siblings under that root.
- **Stage 2 §"Worked example".** Both example rules redrawn with the
  `_choose` match at the root and the constraint body nested under
  it; multi-`_choose` component case noted.
- **Stage 2 §"Temporal anchoring"** (replaces the earlier
  §"Temporal placement of `_option` rows"). Explains why the
  containment-based anchoring drives the agg-then-option scheduling
  via `prior = before ∪ contains⁻¹`.
- **Stage 2 §"Well-formedness of generated rules".** New subsection
  scoping out user-program errors and pinning down the structural
  invariant the lifter must maintain.
- **Open questions §"Aggregator-bearing constraints — test
  coverage".** Replaces the earlier dependency-lift / scheduler-tweak
  discussion with a test-coverage item; the design itself no longer
  has open algorithmic questions in this area.

A follow-up correction noted that the first revision still tried to
make the `_choose` Match the literal rule root, which conflicts with
both `unifyTree`'s empty-atom-root requirement (`unify.ts:315`) and
the descent rule that nested Matches must be `strictlyContained` in
their parent's image. The fix: place the `_choose` Match(es) and the
constraint Match(es) as flat siblings under a wildcard empty-atom
root, with the `+ _option` emit nested inside one designated *anchor*
`_choose` Match (placed last so all sibling bindings are in scope
when the body fires). This was the second revision of Stages 2's
worked examples and §"Temporal anchoring".

A third correction folded in two further changes:

- **§5 above (pause condition for empty-option choices).** The
  earlier "exists `_option` row" pause condition would deadlock the
  loop when a well-formed constraint produces no joint bindings.
  Replaced with per-choice classification in §"Pause check".
- **§4 above (Constrain bodies as Tree patterns — the new
  Stage 0).** Today's flat-atom Constrain can't carry the temporal
  literals or aggregators the rest of the plan assumes. Added a new
  Stage 0 that generalizes Constrain to a body-bearing Tree variant,
  with the surface syntax change `! q X Y` → `!\n < q X Y`. The
  lift then embeds whole bodies under the anchor `_choose`, which
  also lets the rule shape simplify (no wildcard wrapper required for
  descent flexibility in the single-`_choose` case). Stage 2's
  worked examples and §"Well-formedness" were rewritten in lockstep.

A fourth correction reshaped the dead-choice case:

> the `pending-with-empty-options` should not behave as a point where
> the fixpoint exits as a FixpointStatus. in some sense, there is
> nothing to do about that choice. instead the fixpoint loop should
> resume with the next schedulable

So the third correction's three-way classification collapses to two:
*live* (≥1 `_option` row → pause) and *dead* (zero `_option` rows but
non-empty body → drop from scheduling and continue). Empty-fringe-error
moves entirely into lift time, before the catch-up. Stage 3 §"Pause
check" was rewritten to step-5 split (pause vs. continue), and a new
§"Dead-choice marking" subsection records the bookkeeping needed to
keep dropped choices out of subsequent `collectSchedulables` calls
within the same fixpoint run.

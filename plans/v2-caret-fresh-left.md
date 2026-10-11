# Fresh-left `^`, and `#acc` as the only aggregation

Status: **implemented in this fork** (2026-10-09), except the deferred
items in §6.1–6.2. `ts/` here is a copy of the working tree, including the
uncommitted lattice-mode change; the fork has its own git history (`git log`
in `caret/`). Test and corpus migration status is in §8. Where the
implementation deviates from the plan text below, §8.1 says so.

The change has two halves:
1. `^` mints a fresh left endpoint (§2).
2. Every other aggregation mechanism is removed in favour of `#acc` plus a
   `not` read (§3, §5.4): `#agg`, `#reactive`, bracket aggregation
   `[ Q | … ]`, and `#macro`, whose bodies are brackets.

The first half makes the state at a moment final once that moment settles;
the second relies on that.

## 1. Motivation

A `^p` at anchor `[XL, XR]` lands *on* `XL`. When the firing consulted
something that became available only at `XL`, the new tuple is alive at a
moment whose non-monotone state was already committed. That something is acc
rows at `XL`, or the `is` row of a choice asked at `XL`. One moment then has
two states. The snapshot is what acc rows and choice options saw; the final
store also holds the `^` reactions. In the probe from the formalization
discussion (`caret-same-moment-choices.t`), a second same-moment choice is
declared dead while its constraint holds in the final store, and `marked z`
coexists with `mark` at the same moment.

`+` and `~` don't have this problem: they mint a moment strictly inside the
anchor. The change makes `^` do the same on its left end.

That split is also why `#agg`, `#reactive` and brackets need their own
same-moment machinery:
- `computeAggStrata`;
- demand-closed `_do-agg`/`_do-aggc` rows with containment reads;
- the `*agg-empty` sentinel.

Once a moment's state is final, `#acc` covers what they did, plus negation
through `not`. Four aggregation mechanisms with different timing semantics
collapse into one, and it is the only one the formal model (turn-lean) has.

## 2. The `^` change

`^p` at running anchor `[XL, XR]`:

- mints a fresh `l` with `XL < l < XR` (the `+` template `*mom … l`);
- emits `p` on `[l, XR]` (`+` would use `[l, top]`);
- continues on `[l, XR]` (as `+` does).

In short, **`^` is `+` that ends with its anchor.**

A **rule-initial `^`** is unchanged: the anchor is still statically
`(bot, top)` because no atom has narrowed it yet. It stays at `(bot, top)`.
Such a fact has no premises, so it cannot depend on anything late. The
harness's appended `^ is …` rows rely on this. The test is static (anchor term
is the literal `bot`). A `^` after a match that happened to bind `XL = bot` at
run time gets a fresh moment.

`?` and `!` are unchanged: they sit at `XL`, which is what locates a choice
component at one moment.

### 2.1 Why the anchor moves

The test suite and corpus give identical results for "keep the anchor" and
"move it to `[l, XR]`". The difference shows within one rule
(`caret-same-rule.t`):

```
pick, ^opt x, ^opt y, ?C, !opt C, ~choice C
```

| variant | result |
|---|---|
| current `^` | active-choices (opts at `[pick.l, pick.r]`) |
| fresh, keep anchor | `done`: the ask stays at `pick.l`, opts start after it, choice dead |
| fresh, move anchor | active-choices: the opts start on a chain, the ask sits at `opt y`'s `l`, both alive there |

With "move", a rule's own `^` views are visible to its own later `?`/`!`.
Consecutive `^`s form a chain, not siblings, so joins among them need no
lattice mode.

### 2.2 What it buys

- **One state per moment.** A `^` reaction to acc-at-`m` or to a choice at
  `m` now starts strictly after `m`. So the snapshot at `m` equals the final
  store at `m`, for everything except the `?`/`!` rows themselves. That makes
  `not` sound (§3). In Lean terms, `Causal` becomes strict for tuple
  emissions, and `acc_snapshot` is stated against the final store.
- **The same-moment choice probe is consistent.** The second component's
  options and the final store agree.

It does **not** fix the retroactive `is` read (`setup, is C M, +foo` with `C`
asked later; `caret-is-retro.t`). That is about `is` rows being timeless; §6.3
proposes anchoring them after their choice.

## 3. `not`: negation over `#acc` relations

Today absence is observed through `#agg` defaults (`downs Q -> 0`,
`fills C -> 0`, `!said C -> 0`), through bracket `none`
(`[ won W | none W ]`), and through zero counts (`cell:count C z`). A keyed
`#acc` relation has *no row* for an absent key, by design: the key domain is
not enumerable. So `#acc` needs a negated read before the others can go.
After this change, `not` is the language's only negation.

`not` is a **primitive on `#acc` relations only**:

```
#acc fallen : pin
down Q / fallen Q

pin Q, turn, not fallen Q, ^standing Q        -- ordinary rule: at the anchor's start
turn, ?C, !(eligible C, not fallen-pin C)     -- inside !(…): at the component's moment
pin Q, not fallen Q / standing Q              -- acc body: lower strata only
```

- **Semantics.** `not r t̄` succeeds iff no row of `r` matching `t̄` exists at
  the read's moment:
  - in an ordinary rule, the anchor's start;
  - inside `!(…)`, the component's moment;
  - in an acc body, `m`.

  Every variable of `t̄` must already be bound (range restriction; a static
  error otherwise). `_` is allowed and means "any value" (`not winner _`). It
  binds nothing, leaves the anchor unchanged, and, like every acc read, blocks
  until the moment has settled.
- **Acc relations only.** `not` on an ordinary relation is a static error:
  "declare a boolean acc relation, e.g. `#acc fallen : pin` with
  `down Q / fallen Q`". Every negated relation is then visible in the source
  and on the timeline. Sugar that generates the boolean relation is deferred
  until the boilerplate shows up as a cost (§6.1).
- **Stratification.** In an acc body, `not` may only read acc relations of
  *strictly lower* strata. Negation within an SCC is a static error. The acc
  dependency graph gains negative edges.
- **Soundness** rests on §2.2: without the fresh-left `^`, a `^` reacting at
  `m` could make a `not` read at `m` false in the final store after it
  succeeded.
- **Syntax.** `not` becomes a reserved word, like `lt`/`gt`/`le`/`ge`: a
  relation named `not` is rejected. A new marker character was rejected
  because every ASCII candidate is either taken (`-~+^!?`) or reads badly.

**Why primitive, not sugar.** A positive acc read cannot see an absent key.
The `@sum`-of-zeros pattern can express negation, by contributing 0 per
domain element and 1 per event and then reading the 0 row. But a compiler
would need the key domain, which means turning the reading rule's prefix into
an acc rule. That is not possible in general.

Prototype status: **not implemented yet.**

## 4. Consequences, measured

Suite: 39 v2 test files; corpus: `ts/data/v2/*.t`. "Lattice" = the concurrent
incomparable-overlap mode, forced on for every run.

| configuration | tests passing |
|---|---|
| current `^` | 39 / 39 (both lattice modes) |
| fresh `^` (either variant), no other changes | 29 / 39 (both lattice modes) |
| fresh `^` (move) + exception mechanism (§5.2, prototype version) | 32 / 39 (both lattice modes) |
| current `^` + exception mechanism (§5.2, prototype version) | 39 / 39 |

The seven still failing under fresh `^`:
- `v2_ttt`, `v2_acc`: choice idiom (§5.1);
- `v2_eval`, `v2_reactive_aggregate`, `v2_stratification`: same-moment
  `#agg`/`#reactive` (§5.4);
- `v2_acc_view`, `v2_timeline_layout`: display fixtures (§5.5).

Lattice mode changes none of these results. It only helps joins among sibling
`^` facts in matches. Every breakage is a read at a single moment (option
queries, acc, `#reactive`). A test file stops at its first failing assertion,
so a failing file may hide further failures.

## 5. Work items

### 5.1 Choice idiom: ask where the views are alive

**Breaks:** a view derived with `^` in one rule and read by `!` at the
episode's start in another rule. The view now starts after the ask moment, so
the choice has zero options and is marked dead. Tests: `v2_ttt`, `v2_acc`.
Corpus: pins, ttt, dominion, hex, minidom, wolf-sheep, spirit-island (the last
one only without lattice mode).

**Idiom.** Views derived with `^` under an episode hold from their own start
to the episode's end. The episode's end is the one moment where all of them
are alive: siblings minted inside `[a, b]` join at `b` (turn-lean
`Subdiv.sibling_lub`). So the choice is asked *at the end of the deliberation
episode*, and the action follows it:

```
game, other P Op
  ( turn, (actor P), not fallen (s z) );     -- ; : continue at turn.r
  ?C
  !eligible C                                -- eligible alive at turn.r
  ( ~move C
    ^mover P );
  ~turn
  ^actor Op

move C, is C M, hits M Q, +down Q
```

`examples/pins-new.t` is this rewrite. It still uses `downs -> 0`, because
`not` doesn't exist yet. With seeded rng choices it plays the same game under
both the fresh and the current `^`: three moves, four pins down, `won b`. The
original under fresh `^` stops at its first choice. So migrated games can land
before the switch.

Two other forms work:
- views derived in the same rule as the ask (§2.1);
- views as `#acc` relations, which are read at the anchor's start and so are
  visible at `turn.l`. Negation is via `not` (§3).

Tasks:
- migrate the corpus games listed above, and `v2_ttt`/`v2_acc`;
- update the tutorial's "Structuring a game" and "Choices" sections;
- *maybe* add a diagnostic: when a component is dead and some `!` atom
  matches a tuple whose interval starts after the ask moment inside the same
  episode, say "view starts after the ask; ask at the episode's end". Dead
  choices are otherwise silent.

### 5.2 Exceptions: internal exact emits, acc flags, causal context

**Breaks:** `applyExceptions` generates three `^` emits, and each one needs to
land exactly on the anchor:

1. the context broadcast `^_p_ctx U`;
2. the watcher's flag, read with `#agg` containment by the exn/default rules;
3. the default rule's re-emission `^p W`, which copies the primed tuple back
   under its real name. It must keep the original endpoints, so that a
   `+p`/`~p` passing through an exception keeps its start moment.

The flags are also `#agg bool` relations, which §5.4 removes.

**Mechanism:**

- **Internal exact emit** (prototyped as `Atom.exact`): the current `^`
  semantics, i.e. emit on exactly the running anchor with no fresh moment.
  Only generated rules can use it; it has no surface syntax. These predicates
  are internal, and the re-emission relabels a tuple whose own placement
  already followed the new rules.
- **Flags as an internal boolean acc relation**, read positively and with
  `not`:

  ```
  watch:   _p_prime t°, <ctx alive at prime.l>, exact _p_flag t°
  acc:     _p_flag t° / _p_exn t°
  exn:     _p_prime t°, _p_exn t°, (_p_ctx U), e
  default: _p_prime W, not _p_exn W, exact p W
  ```

  The reads happen at `prime.l`, so the flag must exist when `prime.l`
  settles.
- **Causal context: "the context is alive at the tuple's start"**
  (`ctx.l ≤ prime.l ≤ ctx.r`). This is a precise meaning for "while the
  context holds", and it is causal. The generated rule needs a
  point-containment check: explicit `Le` atoms, or an internal point read.

Prototype status. The prototype has the exact emits, and a watcher that
*peeks* the context: interception when the context overlaps the tuple, with
the flag still `#agg`. With that version:
- every exception test passes under fresh `^` in both lattice modes;
- the new watcher passes 39/39 with today's `^`;
- the containment fragility documented in `v2_exceptions` test 9 is gone;
- only the shape assertions for the generated rules (`r_watch*`, `r_exn*`)
  change.

Overlap is broader than alive-at-start: it would also intercept on a context
that starts after the tuple, which the snapshot can miss. The acc-flag and
alive-at-start version above is the target and is **untested**. Verify it
against "flag scheduling (no premature default)" and test 9.

**Implementation note.** A peek works in pairwise mode even when the peeked
tuple's start is incomparable to the anchor's. That's because `pruneChains`
deletes the peek's dead `Max`/`Min`, leaving only the two `Le` overlap
checks. Make that an explicit overlap-check IR atom instead of relying on
liveness pruning.

### 5.3 Recursive views: boolean `#acc`

**Breaks:** a recursive `^` view over cyclic data no longer terminates. Each
re-derivation mints a fresh moment. `turn, reach A B, edge B C, ^reach A C`
over `a→b→c→a` goes from `done`, 12 tuples, to `gas` (590+ tuples, 9 distinct;
`caret-closure-caret.t`).

**Replacement** (prototype-checked, `caret-closure-acc.t`: terminates, all 9
pairs):

```
#acc reach : node node
edge A B / reach A B
edge A B, reach B C / reach A C
turn, reach A C, ^can-reach A C
```

Tasks:
- tutorial: recursive views are `#acc`, and `^` recursion is for chains only;
- a static warning for a relation that reaches itself through `^`-emitting
  rules (an SCC of `^` heads), suggesting `#acc`. Otherwise the failure is a
  gas status far from its cause.

### 5.4 Remove `#agg`, `#reactive`, brackets and `#macro`

**Breaks under fresh `^`:**
- `v2_reactive_aggregate` §8 and `v2_stratification`: a reactive closure
  computed within one moment from `^` contributions;
- `v2_eval` (dahan-count): `#agg` contributions emitted by `^` in one sibling
  episode, read with containment from another.

Instead of preserving that machinery, delete it. Bracket aggregation
`[ Q | Out = op V ]` goes too: it is a third aggregation mechanism with
containment reads at the producer's moment and a demand-closed result row.
`#macro` goes with it, because a macro is a named bracket body. In `#acc`, the
named relation *is* the synonym.

**Migration patterns:**

| `#agg` / `#reactive` idiom | `#acc` form |
|---|---|
| `#agg downs -> bool`; `+downs Q -> 1`; `downs Q -> 0` | `#acc fallen : pin`; `down Q / fallen Q`; `not fallen Q` |
| `downs Q -> 1` (positive read) | `fallen Q` (point read), or `down Q` as a plain match |
| `#agg at * -> last`; `+at It -> To`; `at It -> L` | `#acc at : e (@last loc)`; event `+put It To`; `put It To / at It To`; read `at It L` |
| read-modify-write: `days -> N, plus N 1 N', +days -> N'` | `days N, plus N 1 N', +set-days N'` with `#acc days : (@last nat)`, `set-days N / days N`, and a seed `+set-days 0` (an empty `@last` has no row, as before) |
| `#agg fights -> sum`; `+fights -> 1` | `#acc fights : @sum`; `+fought`; `fought / fights 1` |
| `#agg locations * -> count`; `+locations X -> ()` | `#acc locations : e @count`; `at X _ / locations X ()` |
| `#agg card:cost card -> sum` (a constant table) | an ordinary relation `+card:cost C 2` |
| `#reactive r -> op` | `#acc r : … @op` with `/` rules (same point-read semantics) |
| `!at X -> hand` / `!(at It -> X, adjacent X To)` | `!(at X hand)` / `!(at It X, adjacent X To)` |
| `!said C -> 0` | `#acc was-said : color`, `said C / was-said C`, `!(not was-said C)` |
| contributions written by ordinary rules (`+ hp-loss -> 3`) | an event relation plus a `/` rule (acc relations are never asserted) |
| `[ wound P I \| (s (s (s (s _)))) = count I ]` | `#acc wounds : player @count`; `wound P _ / wounds P ()`; read `wounds P (s (s (s (s _))))` |
| `[ won W \| none W ]` | `#acc winner : player`; `won W / winner W`; `not winner _` |
| `[ spent C S \| none S ]` (correlated on `C`) | `#acc spent-card : card`; `spent C _ / spent-card C`; `not spent-card C`. Variables a bracket shared with the rule become key columns. |
| `[ … \| some V ]` | a boolean acc relation, read positively |
| `[ Q \| last V ]`, `sum`, `count` | `@last`, `@sum`, `@count` over the same body |
| nested `[ … [ … ] … ]` | one acc relation per level, stratified |
| `#macro it:at It L := [at It L \| last L]` | the acc relation itself: `#acc it:at : e (@last loc)` |
| `#macro cell:count C N := [it:at A C \| N = count A]`, read as `cell:count C z` | the zero-count read is negation: `#acc occupied : cell`, `it:at _ C / occupied C`, `not occupied C` |
| `#macro no-wolf C := [it:at I C, wolf I \| z = count I]` | `#acc wolf-at : cell`, `it:at I C, wolf I / wolf-at C`, `not wolf-at C` |

Semantic differences to check while migrating:
- **Read position.** `#agg` and bracket reads fold contributors that *contain
  the anchor*, while an acc read samples *at the anchor's start*. For `+`
  contributors these coincide (both are `l ≤ XL`). For `~`/`^` contributors the
  acc read also sees those that end inside the anchor.
- **Correlation.** A bracket query can mention the rule's earlier bindings,
  but an acc rule cannot. Those variables become key columns, and the reading
  rule supplies them.
- **Zero counts.** A bracket `count` with a bound key yields `z` for an empty
  group. A keyed `@count` has no row, so a `… z` read becomes `not`.

**Tests** (18 files; the number of `PASS` blocks in each is in parentheses):

| file | disposition |
|---|---|
| `v2_reactive_aggregate` (15) | delete. First check that `v2_acc` covers point sampling at the anchor's start, reads blocked until settled, recursion within one moment, keyless zero rows, and keyed absent groups; port any gap. |
| `v2_stratification` (7) | delete (`computeAggStrata`). Port the `=`-chain stratum cases as acc strata-ordering tests if missing. |
| `v2_bracket_agg` (34) | delete. Check that `v2_acc` covers what survives: `@count`/`@sum`/`@last` folds, grouping, keyed-absent vs keyless-zero rows, `none`/`some` (as `not` and positive reads), and correlation through key columns. Port any gap. |
| `v2_macros` (14) | delete. Replace with migration-error tests for `#macro`. |
| `v2_constrain_agg` (7) | becomes `v2_constrain_acc`: sum, last, grouped sums binding `N`/`W` through acc in `!(…)`. Drop the `*c-agg` encoding assertions. |
| `v2_eval` (20) | port the points/score sum and grouping tests. The dahan-count regression's bug class (premature empty-zero fallback in demand aggs) no longer exists: replace it with an acc count over sibling episodes under the new `^`. |
| `v2_choice` (14) | three `#agg at * -> last` programs → `@last` + `put`. |
| `v2_compound_constraints` (8) | test 8, plain + aggregate sub-atoms → plain + acc sub-atoms. |
| `v2_exceptions` (25) | user-level `#agg saw -> bool` → acc + `not`; generated-rule shape assertions follow §5.2. |
| `v2_span_provenance` (3), `v2_source_link`, `v2_timeline_layout` (9), `v2_tuple_bindings` (1) | the shared `#agg at * -> last` / `+at me -> L` / `at me -> L` fixture → `@last` + `put`; span expectations for the `-> L` slice change. |
| `v2_autocomplete` (14) | `#agg` name source → `#acc`. |
| `v2_parse` (22) | `#agg`/weighted-atom parse tests become migration-error tests. |
| `v2_builtins` (5), `v2_js_rel` (8) | drop the `#agg`/`#reactive`/`#macro` reserved-name cases. Keep a weighted read on a js relation as a generic `->` error. |
| `v2_acc` (19) | drop the `#agg`-interplay errors and the "`#reactive` read inside an acc body" test. Add `not` tests: range restriction, `_`, inside `!(…)`, stratified negation in bodies, `not` on an ordinary relation rejected. |

**Corpus:**

| file | uses | migration |
|---|---|---|
| pins | `downs -> bool` | `#acc fallen : pin`, `not fallen Q`; plus the choice idiom (§5.1) |
| ttt | `fills`, `did-win` bool | `+fill Cell`, `#acc filled : cell`, `not filled C`; `#acc winner : player`, `won P _ / winner P`, `not winner _` |
| colors | `said * -> bool` inside `!` | `#acc was-said : color`, `!(not was-said C)` |
| dominion, minidom, choice-test, dessert, demo | `at -> last`; minidom `card:cost` sum; choice-test `locations` count | `@last` + `put`; `card:cost` as a plain relation; `@count` |
| wolf-sheep | `at -> last`; macros `it:at`, `cell:count` (read as zero), `no-wolf` | `#acc it:at` (`@last`); `occupied`/`wolf-at` boolean acc + `not` |
| hex | brackets: wound count, `none` winner, `none` spent (correlated) | `@count`, and `winner`/`spent-card` boolean acc + `not` |
| dungeon | `days`, `hp`, `treasure`, `weapon-damage`, `monster:hp`, `spoils` last; `fights` sum | read-modify-write via `set-…` events, keyless `@last`, seeds |
| hp-demo, test | `#reactive` sum/last/count | acc with event relations; hp-demo's "wrote after reading" now shows the snapshot boundary |
| dungeon (conflicted copy) | — | delete |

**Code removal:**

| file | change |
|---|---|
| parse.ts | remove `#agg`/`#reactive`, weighted atoms `… -> w` in bodies, emits and `!(…)`, bool-weight validation, the `aggcomp` token and `[ … ]` mini-parser, and `#macro` with its `macroDef` token. Each gives a **migration error** naming the replacement. Add `not` (reserved; range restriction; acc-only check). |
| expand.ts | remove `decomposeAggregate`, `decomposeReactiveRead`, `decomposeAggComp`, `aggCompOutCols`, `expandMacros` and the macro graph helpers, the `aggregate` marker, the `_do-agg`/`_agg-result`/`_aggval`/`_do-aggc`/`_agg-resultc`/`*cq*`/`*fv`/`*agg-empty` symbols, `*c-agg` in `buildConstrainRowAtom`, and `DecState.reactive`. Add the negated point read. In `applyExceptions`: acc flags, exact emits, the alive-at-start watcher. |
| comp-aggregate.ts | delete (539 lines). |
| scheduler.ts | remove `reactiveHandler`, `foldReactiveAt`, `computeAggStrata`, `closeDoAgg`, `demandAggHandler` (all of it: brackets were its last user), `collectBlockedDoAggs`, and `aggregateOver` (its users are the removed `#agg` display and `*c-agg`). What remains is `choiceHandler`, plus the dead-choice and rng helpers. |
| fixpoint.ts | handler list is `choiceHandler` + `accHandler`; drop the `applyExceptions`/`expandMacros` double-call for macros. |
| aggregators.ts | fold into acc-ops.ts (its only remaining user, for the `count` fold), or delete it if acc-ops inlines it. |
| constraint-query.ts | `*c-agg` sub-atoms → negated acc sub-atoms. |
| acc.ts | remove `#reactive` reads in acc bodies; add negative stratification edges and the negated `AccMatch`. |
| eval.ts | negated acc match: no candidate ⇒ continue once. |
| types.ts | remove `SchemaDecl`, `Program.schema`, `Marker "aggregate"`, `SubConstrain.kind "agg"`, the `AggComp` rule atom, `MacroDef`, and `Program.macros`; add a negation flag on acc reads. |
| print-ir, pretty-ir, autocomplete, source-link, default-display, timeline, expand-liveness, js-rel, store.ts | remove `_aggval`/`_do-aggc` display and handling, `#agg`/`#macro` name sources, `AggComp` cases, and weighted-span handling. |
| docs | tutorial "Aggregates and negation" rewritten around `#acc` + `not`, with the macro/bracket material removed; overview.md entries for every deleted file and function; the open plans for brackets/macros marked superseded. |

### 5.5 Display and cost

**Cosmetic test breaks:** `v2_acc_view` (4 bars instead of 1, because there
are more moments per episode) and `v2_timeline_layout` (its fixture assumes
`a` and `b` share an interval). Both need new fixtures, not code changes.

**Cost.** Every non-initial `^` mints a moment, and acc rows are recomputed
and stored at every moment. acc-demo grows from 356 to 581 tuples, and the
closure example's acc rows from 49 to 130. Removing `#agg`/`#reactive` moves
more state into acc, so measure after migration. The options:
- compute acc rows only at moments some reader consults (demand-driven settle);
- store only rows that differ from every immediate predecessor (the display
  already merges runs).

### 5.6 Point anchors

`^` now mints a moment, so a `^` at a point anchor (`a, (+p); ^q`) asserts a
cycle exactly as `+` does today. Fold it into the strict point-anchor fix
(turn-lean PLAN §5.1): `AssertLt a b` fails when `b ≤ a` already holds.

### 5.7 Formal model (turn-lean)

- `emitFacts (.here a)` becomes `{tuple (mkTuple … l c.A.r), edge c.A.l l,
  edge l c.A.r}`. `emitNext` moves the anchor to `[l, c.A.r]`. A rule-initial
  `^` keeps `[bot, top]`. `Item.mintsMoment` includes `here`.
- Add `Item.notAcc a` (negated point read), with a stratified-negation check
  in `ValidStrata`.
- Strengthen `Causal` to strict for tuple emissions. Restate `acc_snapshot`
  against the final store, and add `snapshot_eq_final`, the theorem `not`
  relies on.
- Exceptions stay outside the kernel. Their translation (phase 7) uses the
  internal exact emit and acc flags.

## 6. Open questions

### 6.1 `not` sugar for ordinary relations (deferred)

With `not` on acc relations only, every negated fact needs a declared boolean
relation and one rule. For example, pins writes `#acc fallen : pin` and
`down Q / fallen Q`, then `not fallen Q`. The sugar would accept `not down Q`
directly and generate `#acc _has_down : *` with `down Q / _has_down Q`.

- **Semantics.** The same as writing the relation by hand: "no `down Q`
  alive at the read's moment".
- **Visibility.** Generated relations would be hidden on the timeline, like
  other `_`-prefixed internals. The explicit form shows the negated relation
  as an acc bar, which is a debugging aid the sugar gives up.
- **Cost.** A generated relation holds every distinct key of `r` alive at
  every settled moment, whether or not anything reads it there. A demand
  variant could compute only the keys negated reads ask for. That interacts
  with the acc-cost mitigation in §5.5, so decide them together.
- **Deciding.** After the corpus migration, count the boilerplate. The
  migration as planned needs seven such relations: pins `fallen`; ttt
  `filled`, `winner`; colors `was-said`; wolf-sheep `occupied`, `wolf-at`;
  hex `winner`/`spent-card`. Several of those (`winner`, `occupied`) read
  well as named concepts, which argues for keeping them explicit.

### 6.2 Zero-column acc relations

A flag like ttt's "someone has won" is naturally a relation with no columns:
`#acc did-win :` with `won _ _ / did-win`, read as `not did-win`. Today the
declaration parses, but every *use* of `did-win` gets padded with a wildcard
by arity saturation: a Symbol head gets lexical arity `:`-count + 1 = 1. So
the head has 1 column against 0 declared, and is rejected.

- **Option a: saturate acc atoms to the declared arity.** Acc declarations are
  order-free, so this needs the declarations collected before saturating
  (saturation would move after declaration collection, or become a second
  pass). The `#type` work in progress (plans/v2-attribute-namespaces.md)
  changes saturation anyway, so this could ride along.
- **Option b: don't support it.** Key the flag (`#acc winner : player`,
  `not winner _`). It costs nothing and reads fine, but leaves a surprising
  error for anyone who writes the zero-column form.

The planned migration uses option b, so this is not blocking. Option a is a
small parser change, worth doing if `#type` touches saturation anyway.

### 6.3 Anchoring `is` rows at their choice

The last causality gap (§2.2): `is` rows sit at `(bot, top)`, so a rule
anchored before a choice can read its value and place the consequence in the
past (`caret-is-retro.t`).

**Proposal: the engine places each `is` row strictly after its ask moment.**
An `is T V` row is installed at `[m, top]`, where `m` is a fresh moment with
`ask.l < m < ask.r`, and `[ask.l, ask.r]` is the interval of `T`'s `_choose`
row. Every rule that reads it then narrows to start at or after `m`:
- `?C, …, is C M` in the asking rule overlaps and continues after `m`;
- a rule anchored on an episode that ended before the ask (`setup, is C M`)
  fails its overlap check and never fires.

**Mechanism (engine, not GUI).** The GUI and test harnesses keep writing what
they write today: `= V… (…)` bindings plus a rule-initial `^ is T V`. The
compiler treats `is` as reserved. A rule-initial `^ is T V` becomes a
*choice input*: a `Program.isRows` entry rather than a rule. The fixpoint
installs each input as soon as `T`'s `_choose` row exists, minting `m` with a
deterministic id `(*is T)` and the two order edges. `resolveRngChoice` uses
the same installer instead of `addTuple(…, bot, top)`. Every other emit of
`is` is a compile error.

Why the engine rather than the GUI writing an anchoring rule
(`_choose _ (V1 …) _, +is V1 v`):
- saved files and tests stay unchanged, including the `^ is` lines already in
  them;
- the persisted format does not depend on the internal `_choose` row encoding;
- rng commits, which never pass through source, get the same placement.

**Consumers.** `resolvedChoiceTokens`, `gatherChoiceContext` and the timeline
sidebar all find `is` rows by head and ignore the interval, so they don't
change. With `m` strictly after the ask moment, the snapshot at the ask
moment no longer contains the choice's consequences (consistent with §2.2).
`Causal` in turn-lean loses its `is` special case: `is` becomes an ordinary
tuple dependency.

**Edge case.** An ask at a point anchor (`ask.l = ask.r`) leaves no room for
`m`. Treat it like any point-anchor emit (§5.6): it is reported rather than
asserting a cycle.

## 7. Order

Steps 1–5 are valid under today's `^`. The flip in step 6 is then a small,
flagged diff.

1. **Exception exact emits + new watcher** (§5.2, prototype version). It
   passes 39/39 today and removes the containment fragility.
2. **An explicit overlap-check IR atom** for peeks (§5.2 note).
3. **`not` on acc relations** (§3): parse, expand, eval, constraint-query, and
   acc stratification, with `v2_acc` tests.
4. **Exception flags to internal acc + `not`; the alive-at-start watcher**
   (§5.2 target).
5. **Port tests and corpus** (§5.4) and the recursive views (§5.3). Migrate
   the games to the end-of-episode choice idiom (§5.1). Delete `#agg`,
   `#reactive`, brackets and `#macro`, and turn their syntax into migration
   errors.
6. **Flip `^`** behind a flag first, as with lattice mode. Fix the display
   fixtures (§5.5), measure the moment and acc-row cost, then make it the
   default.
7. **Tutorial and turn-lean** (§5.7).

## 8. Implementation notes

Commits in `caret/` (oldest first): the `^` change made unconditional and
`not` added; the exception rework; the removal of `#agg`/`#reactive`/`->`/
brackets/`#macro`; `is` anchoring (two commits); the tutorial; then the test
and corpus migration.

### 8.1 Deviations from the plan text

1. **Exception flags are plain tuples answered by a handler, not `#acc`
   rows (§5.2).** With acc flags, chained exceptions on one `p` failed. The
   first exception's default re-emits the tuple *exactly at* its start
   moment, which has already settled, so the second exception's flag row at
   that moment was frozen before the second watcher ran. The default rule now
   emits an `_exn-wait` row, which the exception-check handler
   (scheduler.ts) answers with `_exn-clear`/`_exn-held` after inner-loop
   quiescence, including for already-settled moments (`demanded`). The exn
   rule matches the flag tuple positively. This keeps the internal flags off
   the snapshot discipline, which is the exemption the user granted for
   internal predicates.
2. **The watcher keeps "context overlaps the tuple"** rather than "context
   alive at the tuple's start" (§5.2). Under fresh-left `^`, a context read
   from a sibling `^` fact starts at a moment incomparable to the tuple's.
   The alive-at-start condition would never fire there, and would break test
   9 (misfits).
3. **`is` rows start at the ask moment, `[ask.l, top]`, not at a fresh moment
   after it (§6.3).** A fresh moment strictly inside the ask's anchor is a
   sibling of the ask's other consequences: in `turn, ?C, !cell C,
   +cell-choice C` / `cell-choice C, is C V, +resolved V`, the
   `cell-choice` and `is` moments were incomparable and the join failed.
   Starting at the ask moment still blocks retroactive reads, because an
   episode that ended before the ask fails the overlap check. Any rule
   reading `is` still narrows to start at or after the ask moment.

### 8.2 Engine summary

- **`^`:** expand.ts `decomposeEmit`. Fresh left end, the anchor moves to
  `[l, XR]`, a rule-initial `^` and compiler-internal `exact` emits keep the
  anchor.
- **`not`:**
  - parse: `splitNot`, reserved word;
  - expand: `decomposeAccRead` lowers it to a positive `_acc-settled` point
    read followed by a negated `Match`, and constraint blocks get
    `*c-not` sub-atoms;
  - eval: negated `Match`/`AccMatch`;
  - acc.ts: `_acc-settled` rows, written only when the program uses `not`,
    and stratified negation;
  - constraint-query: negated subs run last.
- **Exceptions:** exact emits, a peeked context, flag tuples, and
  `decomposeExnCheck` + `exceptionCheckHandler`.
- **`is`:** a rule-initial `^ is T V` lowers to `_is-input T V`;
  `isInputHandler`/`installIs` place `is` on `[ask.l, top]`, and rng commits
  use the same `installIs`. Any other emit of `is` is a compile error.
- **Removed:** `#agg`, `#reactive`, `-> weight`, brackets and `#macro` (each
  is now a migration parse error); `comp-aggregate.ts`; the reactive and
  demand-aggregate handlers; `computeAggStrata`; `aggregateOver`; the
  `schema`/`reactive`/`macros` program fields. Net −2.7k lines in the engine.

### 8.3 Migration status

- **Tests: 35/35 pass.** Four obsolete files were deleted
  (`v2_reactive_aggregate`, `v2_stratification`, `v2_bracket_agg`,
  `v2_macros`); their surviving behaviours were ported to `v2_acc`.
  `v2_constrain_agg` became `v2_constrain_acc`. Both TypeScript
  configurations type-check.
- **Corpus:** every `data/v2/*.t` program gives the same status as in the
  original working tree, and the same first-choice options. Games were
  replayed move for move against the original engine and are identical apart
  from fresh ids. The one intended difference is test.t's `@count`; see 8.5.
- **Fixed during migration:**
  - acc rows matched in an acc body are now part of a contribution's
    identity (`AccMatch.id`), so `@count`/`@sum` over acc rows no longer
    undercounts;
  - installed `is` rows keep the harness row's source span;
  - `>not` and `!(…) -> w` report errors.

### 8.4 Not done

- **`not` sugar and zero-column acc relations** (§6.1, §6.2), as decided.
- **An explicit overlap-check IR atom** for peeks (§5.2 note). The exception
  mechanism still relies on `pruneChains` deleting a peek's dead
  `Max`/`Min`.
- **The acc-row cost mitigations** (§5.5) are unmeasured.
- **The dead-choice diagnostic** (§5.1) is not written.
- **The static warning for `^` recursion** (§5.3) is not written.
- **`notes/turn-program-1.t`** still uses `#agg`; v2_parse asserts the
  migration error there.

### 8.5 What the corpus migration taught

1. **`@count` counts contributions, not distinct facts.** That is the
   existing acc design (a bag), but bracket `count` and `#reactive count`
   deduplicated derivations. A fact re-derived every turn is counted each
   time: hex had to count distinct keys through a boolean acc relation first.
   test.t's `occ a` is now `(s (s z))`, the true occupancy; it was `(s z)`.
2. **Episode attributes are invisible in sibling sub-episodes.** In
   `~t.^:a x`, `t, ~s`, `s, t.:a X, …`, the attribute `:a` starts at a fresh
   moment that is incomparable to `s`, so the read never fires. This is the
   largest ergonomic cost of fresh-left `^`. Every game needed one of these
   workarounds:
   - launch sub-episodes after the attribute (`t.:a _, ~s`);
   - make moment-read views `#acc`;
   - emit attributes as a chain;
   - derive static facts inside a bounded episode.

   Lattice mode does not help, because the attribute's start is never below
   `s`. Candidate follow-up: an episode's own attributes, emitted in the
   episode's launching rule, could land exactly on the new episode (they read
   nothing new, so they cannot violate causality).
3. **Peeks are not a universal escape.** A peek's overlap check still needs
   comparable endpoints. hex's `(foe Op)` became an acc read.
4. **`is` is reserved.** Programs that used `^is` as an ordinary attribute
   (dominion, spirit-island, dessert) were renamed.
5. **Exception contexts and peeks.** A context that starts after a peeked
   `^:target` doesn't overlap damage minted under it; hex's venom uses
   `strike.:target T`.

---
Plan sketched and implemented by Claude Opus 5.5 (`claude-opus-5-5`), 2026-10-09.

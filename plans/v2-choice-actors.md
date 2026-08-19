# Choice-actor syntax (`?[actor] X`)

Implements the `# choice-actor syntax` section of notes/overview.md: an ask
atom may name the *actor* responsible for resolving its choice. For now the
actor set is finite — `you` (the human, today's behavior, the default) and
`rng` (uniform random, resolved automatically by the scheduler). Actors are
totally ordered with `you > rng`; a choice component is resolved by its
highest-priority actor first.

## Surface syntax

- `?[rng] C` — ask atom whose choice variables belong to actor `rng`.
- `?[you] C` — explicit form of the default.
- `?C` — unchanged sugar, equivalent to `?[you] C`.
- The `[actor]` group must **immediately** follow the `?` marker (no space:
  `? [rng] C` is *not* the actor form — a bare `[` after whitespace already
  means bracket aggregation, and we keep it that way).
- Unknown actor names are a parse error (`unknown actor 'foo' (expected you|rng)`).

## Semantics

Unchanged up to the point where the outer loop's earliest blocked tier is all
choices and `computeComponents` has produced components. Then:

- **Static shape of ask atoms (decided)**: `?[actor] V1 … Vn` accepts *only
  one or more distinct variables* — no symbols, no compounds, no `_`, no
  duplicates, no `-> weight`. Enforced at parse time in `parseAtomText`.
- **Static rejection of asks on bound variables**: every Variable occurring
  in an ask atom must be *unbound* at that point in the rule body — asking a
  variable that an earlier match, emit, `=`, or previous ask already bound is
  a compile error (`rule 'r': variable 'X' is already bound at '?'` with the
  ask atom's span). Enforced at expand time (binding is dataflow). An ask
  atom introduces choices; it never re-asks or inspects existing values.
  This subsumes the per-term actor-conflict case (`?[you] C … ?[rng] C` —
  the second ask is rejected as a bound-variable ask, regardless of actors)
  and also outlaws the previously-legal-but-meaningless same-actor double
  ask `?C … ?C`.
- Each active term therefore has exactly **one** owning ask atom and inherits
  its actor.
- A component's controlling actor is the max over its unresolved active terms.
- Components whose controlling actor is `you` surface as `active-choices`,
  exactly as today.
- If **any** component's controlling actor is `rng`, the run does *not* halt:
  the scheduler resolves the **whole entangled component jointly** — it picks
  one of the component's option tuples **uniformly at random** (options are
  already deduped joint assignments) and commits every active term of the
  component at once, asserting one `is <term> <value>` tuple per column, then
  re-enters the inner loop. The distribution is uniform over joint
  assignments, *not* per-variable marginals (decided). A mixed component
  (`you` highest) is never auto-resolved as-is: the user's one-at-a-time
  commits (below) resolve its `you` terms first; once only rng terms remain,
  the recomputed component is all-rng and rolls jointly over the
  now-narrowed option tuples (highest actor first).
- Guard: an rng component with **zero** option tuples cannot be auto-resolved.
  If a round commits nothing (all rng components empty), fall through and
  surface `active-choices` rather than looping forever.

Choice UI rework (decided, in scope): the current generic choice UI (the
web-v2 info-panel option list) is incomplete — it commits a *whole option
tuple* per click, which would let the user bind rng terms. Change it to
**one-at-a-time per user variable**, the same model the icon-driven default
display already implements (`commitSlot` builds a length-1
`{activeTerms: [term], optionTuple: [value]}` intent; `handleClick` already
accepts partial bindings). Per component, list each `you`-labeled active
term with its *distinct candidate values* (distinct entries of that column
across the option tuples); clicking a value commits just that one binding
and re-runs, narrowing the rest. rng-labeled terms are displayed (labeled
`rng`) but never clickable. The default display additionally must skip
rng-labeled slots when matching a clicked icon to a component slot.

Persistence (decided): rng choices must not re-roll when the program is
re-run (the editor re-runs on every edit). The engine rolls and commits
in-store during the run — that's what lets the fixpoint continue past the
choice — and reports every commit in `FixpointResult.rngCommits`; the harness
then persists each commit by appending an `is` row to the source, **same as a
user choice** (the `= V… (…)` + `^ is <term> <value>` shape `handleClick` in
web-v2.ts already produces via `compressRefs`). On the next run the appended
rows resolve those active terms before the scheduler ever sees them (the id
templates are structural — rule, lexPos, chain — so they re-intern to the
same tokens, exactly as user-choice persistence relies on today), so no
re-roll occurs and the process converges after one append. This is also why
the in-store commit must be byte-for-byte semantically equivalent to its
re-parsed `^ is` line: endpoints `(bot, top)` and a trailing id slot, so a
rule matching `is C M` behaves identically in the rolling run and in every
re-run. Tests get determinism via an injectable `random` function.

## Changes by file

### 1. `ts/src/v2/types.ts`

- `export type Actor = "you" | "rng"` plus
  `export const ACTOR_PRIORITY: Record<Actor, number> = { rng: 0, you: 1 }`
  and a `maxActor(a, b)` helper (or an ordered list — keep it trivial).
- `RuleAtom` `Atom` variant: new optional field `actor?: Actor`, meaningful
  only when `marker === "ask"`.
- `BlockedChoose`: new field `actor: Actor` (the row's own actor).
- `ComponentOptions`: new field `actors: Actor[]`, parallel to `activeTerms`
  (per-term actor, already maxed across owning rows).

### 2. `ts/src/v2/parse.ts`

- Tokenizer, atom-content scanner (~line 334): the scan currently breaks at a
  top-level `[`. Add the one exception: when the `[` sits immediately after a
  leading `?` at the token's start (`raw[start] === "?" && pos === start + 1`),
  consume through the next `]` on the same line as part of the atom text
  (error `unterminated '[' after '?'` if the line ends first). Everything
  else — including `[` later in an ask atom — keeps today's behavior.
- `parseAtomText` (~line 1418): when `marker === "ask"` and the body text
  starts with `[`, split off the `[...]` prefix, trim the inside, validate it
  against the actor set (non-empty, known name — else `ParseError`), parse the
  remainder as the atom body, and set `actor` on the produced `Atom` RuleAtom.
  A `[` on a non-ask marker is unreachable here (the tokenizer only glues it
  after `?`).
- Ask-shape validation in `parseAtomText` (`marker === "ask"`, after the
  actor prefix is stripped): at least one term; every term a Variable — no
  Symbols, no compounds, no bare `_` (Wildcard); no duplicate names; no
  `-> weight`. Each violation is a `ParseError`.
- Audit every place that reconstructs an `Atom` RuleAtom from an existing one
  (dot-desugaring in `desugarBody`, macro-body copying in expand's
  `expandMacros`, exception rewriting in `applyExceptions`) and make sure
  `actor` is carried along. Grep for `tag: "Atom"` object literals in
  parse.ts/expand.ts; anywhere the original atom's `marker`/`weight` are
  propagated, propagate `actor` too. (Most rebuilds spread or copy fields
  explicitly — the explicit ones are the hazard.)

### 3. `ts/src/v2/expand.ts`

- Ask case of the marker lowering (~line 1773): the choose row becomes
  `(_choose chooseId (userAtom) <actor>)` — append
  `{ tag: "Symbol", name: a.actor ?? "you" }` after the wrapped atom, before
  the universal trailing id slot is added (so the stored layout is
  `_choose chooseId (atom) actor emitId`).
- Same ask case, **before** `emitBindingsAndRewrite` runs on the atom's
  terms: walk the ask atom's Variables (nested included, same walk shape as
  `collectVarsTerm`) and throw if any name is already in `state.seen` —
  binding happens per-rule in SSA order, and `state.seen` is exactly the
  bound-so-far set, so this is the whole check. `_` and Wildcards are exempt
  (they're anonymous fresh ids by construction). Error text names the rule,
  the variable, and the ask atom's span. Note this runs post-`expandMacros` /
  post-`applyExceptions`, so asks surviving those rewrites are checked too.

### 4. `ts/src/v2/scheduler.ts`

- `collectBlockedChooses` (~line 88): read `terms[3]` as the actor Symbol;
  default to `"you"` when absent or not a known actor name (robustness for
  hand-built stores in tests). Set `BlockedChoose.actor`.

### 5. `ts/src/v2/constraint-query.ts`

- `gatherChoiceContext`: alongside `termByTok`, build
  `actorByTok: Map<number, Actor>` from each blocked row's unresolved active
  terms. The static bound-variable check makes one owning row per term an
  invariant for parsed programs; if two rows do disagree (hand-built store),
  take `maxActor` defensively.
- `runComponent`: emit `actors` parallel to `activeTerms` from `actorByTok`
  (default `"you"` — unreachable, but keeps the type total).
- Thread `actorByTok` through `computeComponents` → `runComponent`.

### 6. `ts/src/v2/fixpoint.ts`

- `runFixpoint` options gain `random?: () => number` (default `Math.random`);
  thread into `runLoop`.
- `FixpointResult` gains `rngCommits: { activeTerm: Term; value: Term }[]`
  (accumulated across the whole run, in commit order; empty when no rng
  choice was rolled). Populated on every return path that made commits,
  including `gas`.
- `runLoop`, after `computeComponents` returns `ok`:
  - `const controlling = (c) => c.actors.reduce(maxActor, "rng")` (components
    always have ≥1 active term).
  - `rngComps = cc.components.filter((c) => controlling(c) === "rng")`.
  - If `rngComps` is non-empty: for each, call `resolveRngChoice` (below); if
    at least one commit happened, `store.iteration++; swapHeads(store);
    continue;` (the new `is` rows are the next delta). If none committed
    (all had zero options), fall through to the `active-choices` return.
  - Otherwise return `active-choices` unchanged.
- `resolveRngChoice(store, comp, random)` (new, small — fixpoint.ts or
  scheduler.ts; scheduler.ts is the better home per the notes section
  "interfaces with the scheduler"):
  - If `comp.options.length === 0`, return `null` (no commit — the guard
    above falls through to `active-choices`).
  - Pick `row = comp.options[floor(random() * comp.options.length)]` —
    **uniform over the component's joint option tuples** (they're already
    deduped by `runComponent`), resolving the whole entangled component in
    one roll.
  - For each `i`, assert the tuple
    `is <comp.activeTerms[i]> <row[i]> <commitId_i>` at endpoints
    `(bot, top)` via `addTuple` — matching the `^ is X V` rows the UI
    appends (they too span the whole timeline, which is what lets nested
    `is C M` blocks match under any anchor). `commitId_i` is the universal
    trailing id slot user rules' arity-saturated matches require
    (`is C M` match ⇒ stored width 4): intern `(*id *rng <activeTerm_i>)` —
    unique per active term, stable across the run. (All terms are rng here:
    a mixed component has controlling actor `you` and never reaches this.)
  - Return the `{ activeTerm, value }` pairs for `rngCommits`.

### 7. UI — `ts/src/web-v2.ts` and `ts/src/v2/default-display.ts`

**One-at-a-time option list (web-v2, ~line 494).** Replace the per-option-
tuple rows in the info panel with per-variable rows: for each component,
for each active term `i`, render the term's name and — when
`comp.actors[i] === "you"` — its distinct candidate values (dedupe column
`i` of `comp.options` by `tokenOf`), each as a clickable `.opt` whose
`ClickIntent` is the length-1
`{ activeTerms: [comp.activeTerms[i]], optionTuple: [value] }` —
the same shape `commitSlot` in default-display.ts already produces and
`handleClick` already accepts. Terms with `actors[i] === "rng"` render
inert with an `rng` tag (they resolve automatically once the `you` terms
are committed). No whole-tuple commit path remains.

**Icon display (default-display.ts).** `candidateSlots` / `commitSlot` must
consider only `you`-labeled slots: skip indices where
`comp.actors[i] === "rng"` when matching a clicked icon's term against
component columns (and when computing `matchable` chip/icon highlighting),
so an icon click can never bind an rng term. Component selection headers
can show the rng terms as inert chips.

**Persist rng commits (web-v2).** After a successful `run()`, if
`result.rngCommits` is non-empty, append one `is` rule per commit to the
source, **reusing the exact `handleClick` shape**:
`compressRefs([...activeTerms, ...values], store)` → `= V… (…)` binding lines
plus `^ is <term> <value>` rows, inserted at the end of the textarea via
`execCommand("insertText")` (factor the append tail of `handleClick` into a
shared helper taking `(activeTerms, values)`). The insert fires the existing
input listener, which re-runs; on that re-run the appended rows resolve the
terms before the scheduler sees them, so no new roll happens and the append
loop terminates. Caret save/restore as in `handleClick`. Gate the append on
the source being unchanged since the run started (compare against the text
captured at the top of `run()`), so a roll from a transient mid-typing
program is discarded rather than persisted. The append is a normal
`insertText`, so user undo removes a persisted roll and the next run rolls
fresh — accepted behavior. Presentation-mode code blocks (`pres/render.ts`)
and other fixpoint hosts do not persist rolls (out of scope): a `?[rng]`
program re-rolls per render there.

### 8. Tests — `ts/src/tests/v2_choice_actor.test.ts` (new)

Use a seeded PRNG (e.g. mulberry32) passed via the new `random` option.

- Parse: `?[rng] C` sets `actor: "rng"`; `?C` and `?[you] C` give `you`
  (field absent or `"you"` — assert via the parsed IR); `?[bogus] C` and
  `?[] C` are parse errors; `?[rng]C` (no space before `C`) parses.
- Bound-variable asks rejected at expand time: `-foo X` then `?X`; `+bar X`
  then `?X`; `= X (a b)` then `?X`; double ask `?C … ?C`; conflicting-actor
  double ask `?[you] C … ?[rng] C` — each throws the bound-variable error.
  `?_` and a fresh-variable ask after unrelated bindings still expand. Also
  scan the existing suites/data programs for any (previously legal) double
  ask that now needs rewriting.
- rng-only choice auto-resolves: an eligible-set program
  (`?[rng]C / ~choice C / !eligible C` with three `eligible` facts) reaches
  `done` with exactly one `is` row whose value is one of the three, and
  `rngCommits` reports it; two different seeds that select different values
  prove the injection works.
- Default unchanged: same program with `?C` halts `active-choices`.
- Mixed component (a `?C` and a `?[rng]D` entangled via one `!(...)` block)
  halts `active-choices` — the rng term is *not* auto-resolved while `you`
  is the highest actor; after appending the user's `is` row for `C` alone
  (a length-1 partial binding, drive it like `v2_ttt.test.ts` does) and
  re-running, `D` auto-resolves jointly over the options narrowed by `C`.
- `commitSlot` / candidate matching in default-display never offers an
  rng-labeled slot (unit-test the slot-selection helper if it's extracted;
  otherwise verify via the component's `actors` filtering logic).
- Multi-variable rng component (two `?[rng]` vars constrained jointly, e.g.
  distinct picks) resolves fully to `done` in a **single joint roll**: the
  committed pair equals one of the component's option tuples (so the joint
  constraint holds), and `rngCommits` has both terms. With a stubbed
  `random` returning a fixed sequence, assert the tuple picked is
  `options[floor(r * options.length)]` — uniform over joint assignments,
  not per-column.
- Zero-option rng component surfaces `active-choices` instead of looping.
- Persistence round-trip (headless, mirroring the web-v2 append): run with a
  seeded rng, render each commit via `compressRefs` into `= …` + `^ is …`
  source lines, append to the program text, re-run with a rng that would
  *throw if called* — the second run must reach the same status with the
  same `is` bindings and an empty `rngCommits` (proves the appended rows
  pre-resolve the terms and nothing re-rolls).
- Regression: run the existing choice suites (`v2_choice.test.ts`,
  `v2_ttt.test.ts`, `v2_compound_constraints.test.ts`, `v2_constrain_agg.test.ts`)
  — the `_choose` row gained a column, so any test poking row arity directly
  needs its expectation updated.

### 9. Docs

- `ts/src/v2/overview.md`: update the entries for types.ts (`Actor`,
  `BlockedChoose.actor`, `ComponentOptions.actors`), parse.ts (ask-actor
  syntax + tokenizer exception), expand.ts (`_choose` row layout + the
  bound-variable ask rejection), scheduler.ts
  (`collectBlockedChooses` actor column, `resolveRngChoice`), constraint-query.ts
  (`actorByTok`), fixpoint.ts (`random` option, rng auto-resolution branch,
  `rngCommits`), and default-display.ts (rng-labeled slots excluded from
  click matching). No new source files are added, so no new section is
  needed.
- `discussions/turn-tutorial.md`, "Choices" section: a short paragraph on
  `?[rng]` (auto-resolved uniformly at random; `?C` = `?[you]C`; the harness
  persists each roll as an appended `is` row, same as a user choice, so an
  outcome is rolled once and never re-rolled on re-runs/edits). Also note
  that `?X` requires `X` to be fresh — asking an already-bound variable is
  a compile error.

## Order of work

1. types.ts (Actor + field additions) — everything else compiles against it.
2. parse.ts tokenizer + `parseAtomText` + actor-propagation audit; parse tests.
3. expand.ts `_choose` layout + scheduler.ts `collectBlockedChooses`.
4. constraint-query.ts actor threading.
5. fixpoint.ts / scheduler.ts `resolveRngChoice` + loop branch + `random`
   option + `rngCommits`.
6. UI: web-v2 one-at-a-time option list + rng-commit persistence (shared
   append helper with `handleClick`); default-display rng-slot exclusion.
7. Tests, then docs.

## Out of scope (noted for follow-up)

- Any actor beyond `you`/`rng` (the note fixes a finite set for now; the
  total order and `Actor` type are the extension point).

## Amendment: program-seeded rng (`rng-seed`)

Requested after the initial implementation: a predicate letting the user
program seed the rng, once at startup.

- Relation: `rng-seed` with one numeric argument (`+ rng-seed 42`). Plain
  name (no `:`), so arity saturation keeps it 1-ary. It is an ordinary user
  relation the engine reads — nothing reserved at parse time.
- Semantics: the fixpoint loop latches its random stream at the **first**
  rng roll. Precedence: an explicitly passed `options.random` (harness
  control — tests) > a program seed (`programSeededRandom(store)`, a
  mulberry32 stream over the seed) > `Math.random`. "Once at startup" means:
  assert the seed before any rng choice (a top-level or setup fact — by the
  first quiescence it exists in the store); `rng-seed` tuples appearing
  after the latch have no effect.
- Errors (thrown at latch time, so an unused seed is inert): `rng-seed`
  asserted with multiple distinct values; a non-numeric argument. The same
  value asserted twice dedups harmlessly.
- Implementation: `mulberry32` + `programSeededRandom` in scheduler.ts;
  `runLoop` (fixpoint.ts) holds `random: (() => number) | null` and latches
  in the rng branch. Web-v2 unchanged — it passes no `options.random`, so
  program seeds apply there automatically (and persisted `is` rows keep
  already-rolled outcomes fixed regardless).
- Tests (v2_choice_actor.test.ts cases 10–12): same seed reproduces a
  3-roll pick sequence, different seed diverges; explicit `options.random`
  overrides the seed; conflict/shape errors; duplicate and unused seeds are
  inert.

---
Plan written by Claude Fable 5 (claude-fable-5), 2026-08-19.
Amended (rng-seed) same day, same model.

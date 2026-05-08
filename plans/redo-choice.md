# Redo choice + scheduling on v2

Bring back the v1 choice mechanism (`?` Ask, `!` Constrain, `is`
resolution rows, scheduler with earliest-tier dispatch) on top of the
v2 evaluator. Spec is the "Choices" section at the end of
`notes/turn-program-1.t` plus the `# redo choice` notes in
`notes/overview.md`.

## Surface syntax

From the spec (turn-program-1.t lines 184–194):

```
turn
  ? C
  + cell-choice C

cell-choice C
  ! cell C
```

- `?` introduces a *choice*. The atom's variables are the active
  choice terms (in `? C`, the single variable `C`).
- `!` is *Constrain*. `! cell C` means "C may take any value c such
  that `cell c` holds". This replaces the current v2 meaning of `!`
  (output sink) — see "Audit" below.
- A choice is resolved by `is <choice-id> <value>`.
- Execution blocks on the earliest unresolved choice or aggregate.

## Audit: existing `!` = output uses

`!` is Constrain — drop output-sink semantics entirely. Before any
new code lands:

- `ts/src/v2/eval.ts` — remove the `output` case in `evalAtom`.
- `ts/src/v2/types.ts` — `Marker` enum: drop `"output"`, add
  `"ask" | "constrain"`.
- `ts/src/v2/parse.ts` — same marker-table change.
- `ts/src/v2/store.ts` — `outputs[]`, `addOutput`, `outputSet` go
  away.
- `ts/src/tests/v2_eval.test.ts` — the aggregation test currently
  asserts `! result N` shows up in `store.outputs`; convert to
  `+ result N` against `store.tuples`.

A separate "outputs panel" mechanism, if we want one, is the editor
plan's problem.

## Lowering: `?` and `!` in the evaluator

`?` and `!` desugar to ordinary `+` assertions of compound atoms.
Stored tuples never contain `Variable` terms — `bindUnbound` always
fresh-id's unbound vars (`eval.ts:351`).

- **Ask `? T1 T2 …`** — emit `+ choose <chooseId> (<wrapped>)` where
  `<wrapped>` is the original Ask atom with `bindUnbound` applied to
  its active terms. So an active variable becomes a fresh
  `(*id <ruleName> <position> <varName> ...boundVarValues)` term and
  is bound in `subst` for the rest of the rule. The `chooseId` is
  itself constructed by the same machinery:
  `(*choose <ruleName> <position> ...boundVarValues)`.

  Stored row terms (3 entries):
  ```
  [ Symbol "choose", chooseId, Atom { wrapped active terms } ]
  ```
  Interval semantics match `+`.

- **Constrain `! atom`** — emit `+ constrain (<atom>)`. Stored row
  terms (2 entries):
  ```
  [ Symbol "constrain", Atom { atom.terms with bindUnbound } ]
  ```
  Same interval semantics as `+`.

`choose`, `constrain`, `is`, `do-agg`, `agg-result` are *reserved
head syms* — the parser rejects user rules emitting them as the
outermost head of a `+`/`~`/`^`/`?`/`!` atom. (User rules can still
mention them nested inside a wrapper, e.g. as the `<atom>` argument
of a constrain.) The fresh-id mint keeps using `*`-prefixed
synthetic syms (`*id`, `*mom`, `*choose`); `*`-prefixed user heads
are also rejected.

## Resolution

Any `is T v` row whose `T` shares a hashcons token with an active
choice term resolves that term — globally; the link is established
by the choice id (`T` is the fresh-id minted for the active
variable), not by anchor or rule. Per-term: a `choose` with multiple
active terms (i.e., a wrapped atom of arity > 1) can be partly
resolved.

`is` is a regular fact relation; the harness writes
`+ is <freshId> <value>` to resolve. The harness obtains the active
fresh-id by reading the `choose` row's wrapped atom.

## Scheduler

The inner fixpoint loop knows nothing about choices or aggregates —
it just runs every rule to quiescence. The outer loop collects the
*blocked set* from store contents alone:

- A `choose <chooseId> (<wrapped>)` row is blocked if any active
  term inside `<wrapped>` lacks a matching `is <activeTerm> _` row.
- A `do-agg <aggId> _` row is blocked if no `agg-result <aggId> _`
  row exists. (See `plans/aggregate-blocking.md` for the producer/
  consumer rule split that introduces `do-agg`.)

Outer loop:

```
inner: run all rules to quiescence
loop:
  blocked = blocked-choose-rows ∪ blocked-do-agg-rows
  if empty: status = "done"; break
  earliest = selectEarliestTier(blocked)
  aggsInTier = earliest filtered to do-agg rows
  if aggsInTier non-empty:
    for each: compute aggregate; emit agg-result row
    inner: run all rules to quiescence
    continue
  else:                                   # earliest is all choices
    components = computeComponents(constrain rows, choose rows)
    status = "active-choices"; break
```

Aggregates close before choices in the same tier — a constraint
fringe may depend on an aggregate's result.

### Earliest tier

v1 used `prior = before ∪ contains⁻¹` over node ids. v2 analog over
intervals: A is `prior` to B iff

- `A.r ≤ B.l` in the moment-order, or
- B's interval properly contains A's.

Take the prefix of the prior-sorted list whose first element is prior
to nothing else; include everything prior-incomparable to it.

## Constraint fringe

`constrain` rows are stored as ordinary tuples. `computeComponents`
from `ts/src/constraint-query.ts` ports nearly verbatim: bipartite
BFS over `(active term ↔ constrain row whose wrapped atom mentions
that term)`, each component lifted into a joint option list via a
relational match against the wrapped atom's head sym.

Empty-fringe error carried over from v1: an active term with no
`constrain` row in its component is a programmer error.

## Restart vs incremental

The v1 web client appended `+ is …` rows to source and re-ran from
scratch. Convenient because v1 had no rollback; v2 has none either,
so restart-from-scratch is fine as the *harness* default.

But the engine interface should not bake in the restart assumption.
The scheduler pauses with a resumable `FixpointStatus`; whether the
harness rebuilds the store or resumes from the same one is a harness
decision. Don't restart unless logically required.

## Files added / touched

- `ts/src/v2/types.ts` — `Marker` change; add `FixpointStatus`.
- `ts/src/v2/parse.ts` — markers + reject reserved head syms
  (`choose`, `constrain`, `is`, `do-agg`, `agg-result`) and
  `*`-prefixed in user atoms.
- `ts/src/v2/eval.ts` — drop output case; add ask/constrain cases
  that desugar to `+` of a compound atom (no separate evaluator
  state).
- `ts/src/v2/store.ts` — drop outputs.
- `ts/src/v2/scheduler.ts` — new. Scans store for blocked
  `choose`/`do-agg` rows, runs `selectEarliestTier`.
- `ts/src/v2/constraint-query.ts` — port from `src/`.
- `ts/src/v2/fixpoint.ts` — outer loop above.
- `ts/src/tests/v2_choice.test.ts` — new tests (see Migration).
- `ts/src/tests/v2_eval.test.ts` — convert the `!` output test.

## Migration order

1. Audit + remove `!` = output (per "Audit" §). Existing tests pass
   after conversion.
2. Refactor `v2/fixpoint.ts` to introduce `FixpointStatus` and the
   outer loop, with no choice/constrain yet — existing aggregator
   path threads through it. No-op on tests.
3. `?` parsing + `choose` row emission. Test: `? C, + cell-choice C`
   produces one `choose` row with the expected `chooseId` and
   wrapped-atom shape.
4. `!` constrain emission + `constrain` rows.
5. Scheduler surfaces `active-choices` with components. Tests:
   - `?` + matching `!` → one component listing options.
   - `+ is <chooseId> v` resolves; execution proceeds.
   - Two `?`s with `);` between them → only the first surfaces.
   - Empty-fringe error when `?` has no `!`.
6. Editor: switch `data/v2/ttt.t` back to `?` + `!`, drop the
   placeholder `choose R C` relation. Click → append
   `+ is <chooseId> <value>` rows.

## Open items

- `?` arity — `? C1 C2` = one choice with two active terms (v1
  default), or two independent choices? Plan: same as v1 (one row,
  multiple active terms).
- Aggregate-blocking semantics for step 2's outer-loop refactor are
  non-trivial; tracked separately in `plans/aggregate-blocking.md`.

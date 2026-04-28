# Constraint tuples — pt1

Implement `notes/overview.md §implement constraint tuples pt1`.

This plan covers four steps that build on each other:

0. Refactor `Ask` so its atom carries only variables, and rewrite Ask
   nodes into Assert of `_choose` during expansion (parallel to how
   Aggregate becomes Assert of `_agg-instance`).
1. Active-choice scheduling — detect unresolved `_choose` rows, schedule
   them alongside paused `_agg-instance` rows under the existing `prior`
   ordering, and yield active choices out of the fixpoint as a tagged
   status.
2. Constrain → query rewriting — when the fixpoint pauses on a choice,
   collect the Constrain rows in the choice's fringe, lift them into a
   match-only pattern with the choice term turned into a variable, and
   run that pattern as a one-off query against the current store.
3. web.ts — read the engine's active choices and render the option list
   produced by step 2 as the new click target.

The split mirrors the overview. Step 0 is purely structural; step 1
changes the public fixpoint contract; step 2 is read-only over the
store; step 3 wires it all into the UI. **Constrain rows remain
invisible to Match** (the existing `unify.ts:132` guard stays).

## Reserved names

Engine-emitted predicates that should never collide with user input get
a leading `_`. `parse.ts:parseTerms` will reject any token whose first
character is `_` (other than the bare wildcard `_`), so users cannot
type these in source. Renames in this plan:

- `agg-instance` → `_agg-instance`
- `agg-binding`  → `_agg-binding`
- `agg-result`   → `_agg-result`
- (new) `_choose`

`is` stays unprefixed: it's a *user-facing* relation that rules write
directly (`- is A X`) and the click flow asserts (`+ is <C> <V>`).

The parser change is a one-line rejection in `parseTerms` plus a test;
the renames are mechanical (string replace + symbol-index keys). Do
the rename and the rejection in step 0 so the rest of the plan can
assume the convention.

## Definitions

- **Choice row**: a row in the store whose atom starts with
  `sym("_choose")`. Produced exclusively by step 0's Ask-expansion.
  The row's id is the choice's anchor; its atom tail is the chosen
  variables, in source order.
- **Choice term**: one of the variable arguments inside a choice row's
  atom tail (i.e. `terms[1..]`). Each variable position is resolved
  *independently* — a `_choose <id> A B` row whose store contains
  `is A vA` but no `is B _` has `A` resolved and `B` unresolved at
  the same time.
- **Resolved choice term**: choice term `C` is resolved iff the store
  contains a row whose first three atom terms are `[sym(is), C, _]`
  (token-equality on `C`).
- **Active / unresolved choice row**: a `_choose` row with at least
  one unresolved choice term. The scheduler tracks the per-term
  resolved/unresolved status, not just the row.
- **Pending aggregate**: an `_agg-instance` row with no matching
  `_agg-result` row (existing notion in `aggregate-fold.ts`, post-
  rename).
- **Earliest tier**: under the `prior` relation
  (`refstore.ts:before ∪ contains⁻¹`), the prefix of a sorted candidate
  list whose elements are not strictly-`prior`-followed by anything
  else. `aggregate-fold.ts:selectEarliestTier` does this for paused
  agg-instances; we generalise it.
- **Fringe of a value v** (overview §fringe, line 205+): rows whose
  atom contains `v`, *recursively* through compound terms — a row
  with atom `(card (cell C))` is in the fringe of `C`. Comparison is
  at the hashcons-token level so a Ref and its canonical form match.
  The current overview definition is informal and the existing fringe
  is not well-tested; treat the recursive form as canonical going
  forward.

## Step 0 — Refactor `Ask`

### 0a. Type and parser changes

`types.ts` (Tree union, line 50ff):

```ts
// Was: TreeBase & TreeBody & { tag: "Ask" }
// New: like Equal — opt out of TreeBody. Carries an id and an atom
// whose terms must all be Variables (validated by the parser).
| (TreeBase & { tag: "Ask"; id: Term; atom: Atom })
```

Parser (`parse.ts`):

- When a line starts with `?`, parse the rest as before but reject if
  any non-Variable term appears. Source `? C` is the only valid form;
  there is no user-chosen head symbol. The error message points at
  the offending column.
- Ask nodes have no children syntactically (forbid indented children
  under a `?` line). Today the type allows children; the parser may
  silently accept them. Tighten the parse to reject.
- Reject any token whose first character is `_` (excluding the bare
  wildcard `_`), so user code can't shadow `_choose` / `_agg-*`.

`tree.ts`, `refstore.ts`, `expand.ts`, `unify.ts` — updates to the
narrowing logic that currently treats Ask like Assert/Constrain
(BodyTree extraction, `nodeRowFromTree`, `passesConstraint`, etc.).
Most of these will narrow naturally once Ask leaves the BodyTree
union; flag any spot that does `tree.children` without a guard.

### 0b. ID-expansion of Ask variables

`expand.ts:rewriteUnboundAssertVars` already gives Assert/Ask matched
treatment for unbound variables (line 374). After step 0a, Ask is no
longer a BodyTree, so this branch needs adapting:

- An Ask node still scans its atom terms (no children to recurse into).
- For each variable first-mentioned at the Ask, allocate a fresh
  `(id <name> <lineId> ...previousVars)` atom and bind it via
  `trailPush`, exactly as today. The expansion's "id atom" replaces
  the variable everywhere downstream.
- Ask does **not** push to `previousVars` (it's positive, like Assert).

This is what the overview means by "the atom of terms will be expanded
into `id` atom terms" — the variables in the Ask's atom get the
standard positive-node id-rewrite.

### 0c. Ask → Assert(`_choose`) rewrite

In `expand.ts`, after id-expansion, rewrite each Ask into an Assert
whose atom is `[sym("_choose"), ...ask.atom.terms]`. Two options for
where to do this:

- (a) Inside `expand` / `expandAll`, mirroring the Aggregate handling
  (`buildAggRule1` / `buildAggRule2`).
- (b) A separate post-pass that walks each rule and replaces every Ask
  with the Assert form.

**Recommendation: (b).** It avoids interleaving Ask-rewrite logic with
the (already complex) prefix/aggregate machinery in `expand`. The
post-pass runs after `rewriteUnboundAssertVars` and before
`generateDeltaVariants`. Ordering matters: id-expansion must happen
*before* the rewrite, so the resulting Assert carries already-expanded
variables; otherwise `rewriteUnboundAssertVars` would see them as
"first mentioned at an Assert" rather than at an Ask, and emit
slightly different ids.

### 0d. Runtime-side cleanup

After step 0c, no Ask node ever reaches `step` or the store. We can:

- Drop `"Ask"` from `NodeRow` (`refstore.ts`), shrinking it to
  `Assert | Constrain`.
- Drop the `"Ask"` case in `nodeRowFromTree` (`refstore.ts:42`).
- Drop the `"Ask"` arm in `unifyTree`'s reference-tag guard
  (`unify.ts:339`).

These shrinkages are safe iff the parser rewrite is total. Add a
defensive throw in `step` if it ever sees an Ask-tagged Tree at
matching time.

### 0e. Reserved-name renames

Mechanical rename across the codebase (use `replace_all` per file):

| Old symbol | New symbol | Files |
|---|---|---|
| `agg-instance` | `_agg-instance` | `expand.ts`, `aggregate-fold.ts`, `tests/*.test.ts`, any `.sl` snippets in tests |
| `agg-binding`  | `_agg-binding`  | same |
| `agg-result`   | `_agg-result`   | same |

Symbol index keys in `RefStore.index` follow the new spelling. No
runtime-shape change.

### 0f. ttt.sl migration

Existing `?` usages need rewriting:

- `? ask` → invalid under the new rules (no variables). Either drop
  the line (the surrounding rule is its only user) or introduce a
  fresh variable: `? A` and consume `A` downstream. The
  `extractBoard.askId` walk in `ttt.js` uses `node.id` of the Ask,
  which after step 1 will become the choice-row id from the engine,
  so the in-source name (`ask`) is no longer load-bearing.
- `? target T`, `? source S` → `? T` and `? S`. Subsequent
  constraints (`! land T`, `! range S T R`) keep working because they
  reference the variable, not the head symbol.
- The `- [A] ask + ask-id A` rule that surfaces the askId for ttt.js
  goes away once the display module reads choices from the fixpoint
  status (step 3).

The rule `- is A X` continues to work — it now matches the click-
asserted `is <choice-term> <option>`.

### 0g. Tests

- `parse.test.ts`: `? foo X` (head symbol) errors at the symbol's
  column.
- `parse.test.ts`: a `?` line with indented children errors.
- `parse.test.ts`: a token starting with `_` (e.g. `+ _foo`) errors.
- `expand.test.ts`: an Ask `? C` in a rule expands to an Assert
  `+ _choose <id> C` (same node id as the original Ask) with C's id
  rewritten if C is fresh at that position.
- `fixpoint.test.ts`: a minimal program with one Ask produces a
  single `_choose ...` row in the result tree.
- Update existing `agg-*` test fixtures to the `_agg-*` spelling.

## Step 1 — Active-choice scheduling

### 1a. Detect unresolved choice terms

New helper alongside `aggregate-fold.ts:collectAggNodes`:

```ts
interface UnresolvedChoice {
  row: NodeRow;            // Assert row with first term sym("_choose")
  chooseId: Term;          // === row.id
  unresolvedTerms: Term[]; // subset of row.atom.terms[1..] not resolved
}

function collectUnresolvedChoices(ref: RefStore, hc: HashconsState): UnresolvedChoice[]
```

Implementation:

- Use the symbol index: `ref.index.get("_choose") ?? []` enumerates
  every choice row in O(choices).
- Build a `Set<NodeId>` of resolved choice-term tokens once: scan
  `ref.index.get("is") ?? []` and collect `idKey(row.atom.terms[1], hc)`
  for each well-formed `is` row.
- For each `_choose` row, partition `terms[1..]` by membership in that
  set and emit an `UnresolvedChoice` with `unresolvedTerms = the
  unresolved subset` whenever it is non-empty.

The per-term partition matters: a `_choose <id> A B` row with `is A vA`
present but no `is B _` is still active — `B` shows up as the only
entry in `unresolvedTerms`. Tier scheduling treats the *row* as the
schedulable unit (the row's nodeId determines `prior` ordering), but
the option-enumeration in step 2 uses `unresolvedTerms` to know which
positions to query for.

### 1b. Mixed-tier selection

Generalise `aggregate-fold.ts:selectEarliestTier` to a heterogeneous
list:

```ts
type Schedulable =
  | { kind: "agg"; row: NodeRow; nodeId: NodeId; instance: AggInstance }
  | { kind: "choice"; row: NodeRow; nodeId: NodeId; choice: UnresolvedChoice };
```

Selection: sort by `prior`; the earliest tier is the prefix whose
first element is `prior` to nothing else (existing logic), generalised
to read `nodeId` instead of `idKey(a.row.id, hc)`.

Outer-loop decision (`fixpoint.ts`):

- If any `agg`-kind item is in the earliest tier: close those
  aggregates via `closeAggregates` (refactored — see 1c) and continue
  the outer loop. Choice-kind items in the same tier stay pending.
- Else (all earliest are choices): break out, return them as
  `status.choices`.

### 1c. Refactor `closeAggregates`

`closeAggregates` currently does its own paused/earliest computation
(`collectAggNodes` → filter by `hasResult` → `selectEarliestTier`).
Move that logic up into a new `scheduler.ts` (or co-locate in
`fixpoint.ts`) so it can drive both flavours. `closeAggregates`
becomes a pure folder over an injected list of agg-instances.

### 1d. Fixpoint return shape

```ts
type FixpointStatus =
  | { kind: "done" }
  | { kind: "gas"; steps: number }
  | { kind: "active-choices";
      choices: UnresolvedChoice[];
      components: ComponentOptions[] }
  | { kind: "empty-fringe-error"; choice: UnresolvedChoice; choiceTerm: Term };

return { result, steps, hc, expandedPatterns, status };
```

Notes:

- `status.choices` carries `UnresolvedChoice` (row + unresolved
  terms), not bare ids — step 2 needs both the row's id and the
  unresolved term(s) to compute fringe and build the query.
- `kind: "gas"` carries step count, matching the overview ("if it
  runs out of gas, returns number of steps run").
- Existing top-level `steps` field stays for backwards-compat.
- Tie-break for incomparable active choices: deterministic by
  hashcons-token order. Display modules may render in any order; UX
  for ambiguity resolution is a follow-up.

### 1e. Tests

`fixpoint.test.ts`:

- One Ask, no resolution → `status.kind === "active-choices"`,
  `choices.length === 1`, the row's atom starts with `sym("_choose")`.
- Two unrelated Asks both unresolved → both surface; ordering follows
  hashcons-token.
- Ask + matching `is` row supplied as input → `status.kind === "done"`
  (no active choices).
- Multi-arg `? A B` with `is A vA` only → one `UnresolvedChoice` with
  `unresolvedTerms = [B]`.
- Aggregate prior to choice → after the agg fold, the agg's row
  carries `_agg-result` and the choice still surfaces.
- Choice prior to aggregate → status is `active-choices`; the
  aggregate stays paused.
- Gas exhausted with no active choice → `status.kind === "gas"`.

## Step 2 — Constrain → fringe query

### 2a. Constrain stays invisible to Match

The overview confirms the existing behaviour: Match nodes do not match
Constrain rows. **No change to `unify.ts:132`.**

(Constrain rows remain insertable, are scanned for fringe membership,
and are made matchable only inside the synthesised one-off query
below — by retagging them Match for the duration of that query, not
by changing the global guard.)

### 2b. Fringe helper (recursive)

```ts
// Rows whose atom transitively contains `value`. Recurses through Atom
// subterms and Ref bodies. Returns NodeRows.
export function fringeOf(store: RefStore, value: Term, hc: HashconsState): NodeRow[]
```

- Compute `target = idKey(value, hc)` once.
- For each row, walk its atom terms; a row is in the fringe if any
  term reaches `target` via:
  - direct `idKey` match, or
  - recursion into the term's Atom subterms (if `tag === "Atom"`), or
  - recursion into the Ref body (`hc.refToAtom.get(id).terms`) — guard
    against cycles with a per-call seen-set on Ref ids.
- Top-level *and* compound matches both count: `(card (cell C))` is in
  the fringe of `C`.

The overview's fringe definition is informal; pin this recursive form
down here and treat it as canonical. Place in a new `fringe.ts`.

### 2c. Constraint closure across choice variables

The unit of enumeration is a **component** of the constraint graph,
not an individual `_choose` row. A component is a connected set of
unresolved choice terms (all `_choose` rows in the active tier
contribute their active terms; non-active-tier `_choose` rows
contribute their unresolved terms) along with the Constrain rows
that link them. Each Constrain row belongs to at most one component;
each unresolved choice term belongs to exactly one component (or to
none, if it touches no Constrain row — handled as the empty-fringe
error below).

Classification of choice terms inside a component:

- **active** — the term belongs to a `_choose` row that is in the
  active tier (its row appeared in `status.choices`). Lifted to a
  fresh result variable. Bindings flow back to the caller.
- **existential** — the term is unresolved but its `_choose` row is
  *not* in the active tier. Lifted to a fresh variable; bindings
  are read but discarded.
- **resolved** — there is an `is T v` row in the store. Substituted
  by `v` (token-equality replacement at any depth) wherever it
  appears in the component's Constrain rows. Resolved terms aren't
  vertices of the component graph; they only appear as values
  inside Constrain rows.
- **non-choice** — any term that isn't a choice term. Stays as-is.

Worked examples:

- `? A B` plus `! foo A B` (single active row, both unresolved):
  one component `{A, B}`; both classified active. Lifted query
  `- foo V_A V_B`. Output: list of `(V_A, V_B)` pairs.
- `? A`, `? B`, `! foo A B` with A in the earliest tier and B in a
  later tier: one component `{A, B}`; A active, B existential.
  Lifted `- foo V_A V_B'`. Output: distinct V_A values.
- After the user picks `is A a`: A becomes resolved; B becomes
  active. Component for B is `{B}` (A is no longer a graph vertex);
  the constraint row `foo A B` is still in the component because B
  is in it, and A is substituted by `a`. Lifted `- foo a V_B`.
- Two active rows R1=`?A`, R2=`?B` in the *same* tier sharing
  `! foo A B`: one component `{A, B}`; both active. Lifted
  `- foo V_A V_B`. **One** option list of `(V_A, V_B)` pairs;
  picking a tuple resolves both rows simultaneously.
- `? A`, `? C` in the same tier with `! card A` and `! red C`
  (uncoupled): two components `{A}` and `{C}`. Two independent
  enumerations.

### 2c.1. Building components

Per fixpoint pause:

1. `resolvedMap: Map<NodeId, Term>` — from `is`-rows.
2. `activeTerms: Set<NodeId>` — union of `c.unresolvedTerms` over
   every `c ∈ status.choices` (the active tier).
3. `unresolvedSet: Set<NodeId>` — every unresolved choice term
   across every `_choose` row, active-tier or not.
4. Component build (one BFS over the whole graph, partitioning
   `unresolvedSet`):
   - For each unvisited term `t ∈ unresolvedSet`, start a fresh
     component with `frontier = {t}`, `members = {t}`,
     `rows = ∅`.
   - Loop: `newRows = ⋃_{u ∈ frontier} fringeOf(store, u, hc)
       .filter(r => r.tag === "Constrain") \ rows`;
     `rows ∪= newRows`;
     `mentioned = ⋃_{r ∈ newRows} { unresolved choice terms reached
       under the recursive fringe walk on r.atom }`;
     `frontier = mentioned \ members`;
     `members ∪= mentioned`;
     repeat until `frontier` is empty.
   - Mark every member visited.
5. Keep only components that contain at least one active term —
   non-active components carry only existentials and don't need a
   query at this pause.
6. **Empty-closure guard**: an active term that ends up in a
   component with `rows = ∅` is the empty-fringe error case. Abort
   and return
   `{ kind: "empty-fringe-error"; choice: <its _choose row>; choiceTerm: <the term> }`.
   This short-circuits regardless of whether other components have
   non-empty closures — any unconstrained active term is a
   programmer error.

Properties:

- Each Constrain row visited belongs to exactly one component (it's
  added the first time any of its terms is in some component's
  frontier; subsequent passes skip it via the `\ rows` filter).
- Each unresolved choice term belongs to at most one component.
- The whole partition costs O(unresolvedSet.size + total Constrain
  fringe size) per pause.

### 2c.2. Lifting a component to a match query

For each kept component, allocate fresh Variables:

- one per active term (`V$choice$<idx>`), in a stable order — sort
  active terms by `idKey` so the option-tuple ordering is
  deterministic;
- one per existential term (`V$exist$<n>`).

For each row in the component's `rows`, build a Match Tree node whose
atom is `row.atom` rewritten by:

- token-equal-to an active term → its result var;
- token-equal-to an existential term → its existential var;
- token-equal-to a resolved term → the resolved value
  (`resolvedMap.get(idKey)`);
- compound term (Atom / Ref body) → recurse, applying the same
  rules at each position. Match the recursive fringe walk for
  consistency.

The match node's id is a fresh Wildcard. Wrap the rewritten rows as
siblings under a synthetic root Tree (`tag: "Match"`, constraint
`"any"`, id = Wildcard, atom = empty terms).

### 2c.3. Running the query

Run a one-off query through the existing public entry point
`unifyTree` against the current store with a callback that records,
per successful substitution, the tuple of result-var bindings aligned
with the component's sorted active terms. Existential bindings are
read but discarded.

Deduplicate the resulting tuples on a hashcons-token tuple key.

### 2c.4. Output shape

```ts
interface ComponentOptions {
  // Sorted by idKey for determinism.
  activeTerms: Term[];
  // Each tuple has length === activeTerms.length.
  options: Term[][];
}

type OptionsByComponent = ComponentOptions[];
```

Returned to the caller as part of `status` when `kind === "active-choices"`:

```ts
| { kind: "active-choices";
    choices: UnresolvedChoice[];
    components: OptionsByComponent };
```

Notes:

- A component is the indivisible unit a click can resolve. Picking
  a tuple writes one `+ is <activeTerms[i]> <option[i]>` line per
  active position, atomically resolving all the active rows that
  contributed terms to that component.
- Components do *not* know which `_choose` row contributed each
  active term. The display layer can recover that by reverse-lookup
  on `choices[*].unresolvedTerms` if needed (e.g. to label which
  source line corresponds to which option position).

### 2c.5. Tests

- `? A B` plus `! foo A B`, store `+ foo a x`, `+ foo b y`,
  `+ foo a y` → one component, options `[[a,x], [b,y], [a,y]]`.
- `? A`, `? B`, `! foo A B` (different tiers): while A active →
  one component with active=[A], existential=[B]; options are
  distinct A-values. After `is A a` → component becomes active=[B]
  with A substituted by `a`.
- `? A`, `? B` *same tier*, `! foo A B`: one component with both
  active. One joint option list. Single click resolves both.
- `? A`, `? C` same tier, `! card A`, `! red C` (uncoupled): two
  components, two independent enumerations.
- Self-referential `! foo A A` → component `{A}`; lifted `- foo V V`
  with the same fresh var twice; query enumerates A-values where the
  store has `foo a a` etc.
- Empty closure for any active term (no Constrain row in its
  component) → `empty-fringe-error` short-circuits the pause, even
  if other components are non-empty.

### 2c.6. Termination / safety

- The component build is monotone over a finite set; terminates.
- The lifted query reuses `unifyTree`; the synthetic root is a
  Match-tagged Tree with no positives, so no rows get inserted.
- `Constrain` rows in the store remain invisible to the lifted query
  via the existing `unify.ts:132` guard: the rows are *consumed* as
  pattern source, but the *targets* the query matches against are
  still only Assert rows.

### 2d. Tests

Joint-enumeration cases live in 2c.5. Additional cases:

- `? C` plus `! card C` and Asserts `+ card a`, `+ card b` → one
  component, options `[[a], [b]]`.
- Constrain row with a compound term (`! card (cell C)`) → confirms
  the recursive fringe finds it; lifted query is `- card (cell V)`.
- Constrain row referencing a value that isn't a choice term
  (`! land s1`, choice is `T`) → row not in any component containing
  `T`.
- Multi-arg `? A B` with two *uncoupled* constraints `! card A` and
  `! prop B` → **two** components, one per term, despite both terms
  living on the same `_choose` row. Confirms component partition is
  driven by the constraint graph, not by `_choose`-row co-membership.

## Step 2.5 — Elide prior Constrain literals in delta variants

### Problem

`expand.ts:pruneAndConvert` (and `buildAggRule1.prune`) retag every prior
positive sibling to `Match` when generating the delta variant for a target
positive. For prior `Assert` / `Ask`-as-`_choose`, the retag works because
their inserted rows are Match-eligible. For prior `Constrain`, the retag
yields a Match against the constraint atom — but the `unify.ts:132` guard
hides every `Constrain` row from Match. The variant never fires, so a
target Constrain that follows another Constrain in the same body is never
inserted.

Symptom (already observed during step 2 testing): the rule

```
- trigger
  ? A C
  ! card A
  ! red C
```

inserts `! card A` but never `! red C`. The step-2 "uncoupled multi-arg"
test had to be split into two rules to dodge this.

### Fix

Drop non-target `Constrain` literals from the prior-sibling prefix instead
of retagging. A Constrain has no Match-observable side effect; its row is
asserted by *its own* variant, so the later-target variant's prefix doesn't
need to wait on it. Eliding is sound — the later variant fires as soon as
the surviving prefix matches, and the prior Constrain's variant inserts the
prior row independently.

### Changes

- `expand.ts:pruneAndConvert`: at every child-loop site, before recursing
  into a child, skip it iff `child.tag === "Constrain"` and
  `child !== targetNode`. Implementation choice (pick one):
  1. Inline the check at every `for (const child of node.children)` loop
     in this function (currently two: top-level and recursive). Cheapest
     diff, easy to review.
  2. Repurpose `pruneAndConvert`'s sentinel: keep `null` for "stop, target
     found" and add a separate "skip but continue" return value (e.g.
     return `undefined`). Driving loops then `continue` on `undefined` and
     `break` on `null`.
- `expand.ts:buildAggRule1.prune`: same change. Constrain literals inside
  an aggregate fold are out of scope (aggregate children aren't traversed
  by `pruneAndConvert`); ignore.
- `expand.ts:buildAggRule2`: audit. If it ever retags a `Constrain` to
  `Match` along its way, apply the same elision; otherwise leave alone.

### Tests

- Restore (or add) the previously failing single-rule form of the
  "uncoupled multi-arg" case: `? A C / ! card A / ! red C` produces both
  Constrain rows and yields two components.
- `tests/expand.test.ts`: variant for a target with prior `! foo X`
  siblings has those siblings *absent* from the variant (not retagged to
  Match). Confirms the elision at the IR level.

### Notes

- Elision affects only the matching prefix of a variant. Each Constrain is
  still asserted by its own variant — the row count in the store is
  unchanged.
- A target Constrain stays as the leaf Constrain in its variant
  (unchanged).
- The fix is local to `expand.ts`; no runtime, scheduler, or
  constraint-query code changes.

## Step 3 — web.ts integration

### 3a. Consume `status`

`web.ts:run()` reads `result.status`. Branch on `status.kind`:

- `"done"` → existing behaviour.
- `"gas"` → existing behaviour (sets `lastValid = false`; the check
  can stay or be replaced by `status.kind !== "gas"`).
- `"active-choices"` → expose `choices` and `components` to the
  display.
- `"empty-fringe-error"` → surface in the error bar with a message
  identifying the offending choice term; don't render a display.

### 3b. Display module API

Pass per-call alongside the existing `(root, hc)` arguments:

```ts
interface DisplayCallContext {
  activeChoices: UnresolvedChoice[];
  components: ComponentOptions[];
}
```

Each `ComponentOptions` carries `activeTerms` (length N) and `options`
(list of N-tuples). For the ttt.js single-arg case there is one
component, `activeTerms.length === 1`, and each tuple has one element.

The ttt.js display reads `components[0]`, picks an option tuple, and
emits one `is` row per active term:

```
+ is <activeTerms[0]> <option[0]>
+ is <activeTerms[1]> <option[1]>
…
```

For ttt.js the loop is single-iteration; for a multi-active-term
component (e.g. `? A B / ! foo A B` or two same-tier asks linked by a
constraint) one click writes the whole block atomically.

Default rendering (no display module): one `<ul>` per component;
each `<li>` is one option *tuple* shown as `(t0, t1, …)`. Clicking
the `<li>` emits the multi-`is` block above.

### 3c. Click semantics

`handleDisplayClick` (and the default-display click handler) becomes
"for component C and option tuple `(v0, v1, …)`, append one
`+ is C.activeTerms[i] v_i` line per active position". The current
two-step "click Ask, click Assert" fallback in `resultEl` keeps
working for ad-hoc clicking but is no longer required for the common
path.

`extractBoard`'s walk for `node.tag === "Ask"` is removed. ttt.js no
longer scans the tree for an askId.

### 3d. Tests / manual smoke

No new automated coverage at the web layer. Manual smoke: load
`ttt.sl` after migration, click a cell, verify a move is played;
verify multi-choice rules (`target-power`) surface their option list
once data exists for them.

## File-by-file change list

| File | Change |
| --- | --- |
| `ts/src/types.ts` | Ask drops TreeBody; gains a narrower shape. |
| `ts/src/parse.ts` | Validate Ask atoms are Variable-only; reject Ask children; reject leading-`_` tokens. |
| `ts/src/expand.ts` | Adjust id-expansion for the new Ask shape (0b); add post-pass that rewrites Ask → Assert(`_choose`) (0c). |
| `ts/src/tree.ts` | BodyTree narrowing fixups around Ask. |
| `ts/src/refstore.ts` | Remove `Ask` from `NodeRow` and `nodeRowFromTree`. |
| `ts/src/unify.ts` | Drop `Ask` arm in the reference-tag guard (0d); leave the Constrain guard alone. |
| `ts/src/step.ts` | Defensive throw if step ever sees an Ask-tagged pattern. |
| `ts/src/aggregate-fold.ts` | Rename `agg-*` symbols to `_agg-*`; `closeAggregates` becomes a pure folder; tier selection moves out. |
| `ts/src/scheduler.ts` (new) | Mixed-tier selection over agg + choice schedulables; drives the outer fixpoint loop. |
| `ts/src/fringe.ts` (new) | Recursive `fringeOf`. |
| `ts/src/constraint-query.ts` (new) | Partition unresolved choice terms into constraint-graph components; lift each component to a match query; run via `unifyTree` with a recording callback; return joint option tuples. Short-circuit on any empty-closure component. |
| `ts/src/fixpoint.ts` | Outer loop calls into scheduler; return value gains `status`. |
| `ts/src/web.ts` | Read `status`; pass active choices + options to display; remove Ask-discovery walk; surface empty-fringe error. |
| `ts/data/ttt.sl` | Migrate `? <head> <vars>` to `? <vars>`. |
| `ts/data/ttt.js` | Drop the Ask-walk; consume `activeChoices[0]`; restructure clicks around `is <choiceTerm> <value>`. |
| `ts/src/tests/parse.test.ts`, `tests/expand.test.ts`, `tests/fixpoint.test.ts`, new `tests/constraint.test.ts` | Cases listed in 0g, 1e, 2d. |

## Migration order (incremental commits)

1. Step 0 in isolation: parser change, type change, expand rewrite,
   `_agg-*` rename, ttt.sl + ttt.js migration. Tests pass; behaviour
   is unchanged from the user's perspective except `? foo X` and
   `_foo` are now parse errors.
2. Step 1: scheduler refactor, fixpoint status. No web changes yet.
3. Step 2: fringe + lifted query helpers, with unit tests but no UI.
4. Step 3: web.ts hookup. Manual smoke pass.

## Notes

- **`_` lexical rule.** Today `_foo` parses as a Symbol (the wildcard
  rule only matches the bare token `_`). The parse rejection in 0a
  is what makes leading-`_` names safe for engine use; document on
  the parser change site.
- **Tie-break across multi-term choices.** Deterministic by
  hashcons-token order in pt1; UI selection is a pt2 follow-up.

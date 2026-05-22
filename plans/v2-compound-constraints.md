# Compound constraints

Today `!` carries a single wrapped atom: `_constrain (atom)`. We want to
write a conjunctive constraint:

```
foo, ?A, ?B, !(prop A X, other-prop X B)
```

— and have the choice component for `A`/`B` enumerate joint bindings
that satisfy *both* sub-atoms with a shared existential `X`.

This plan adds (a) syntax for the multi-atom form, (b) an IR
representation that survives expand without breaking choice-component
building, and (c) the new "var-term → fresh existential variable"
handling inside `constraint-query.ts`.

## What's new vs. ordinary constrain

Three variable shapes appear inside a compound constraint:

1. **Bound by an `ask` earlier in the rule.** Today's *active term*
   case. The variable resolves to an `*id` template at expand time
   (`emitBindingsAndRewrite` already does this); at choice-component
   time the term is in `activeSet` (or substituted via an `is` row per
   `[[v2-is-substitution]]`).
2. **Bound by an ordinary user Variable in scope.** Already handled by
   the existing flow: the Variable is in `state.seen` so
   `emitBindingsAndRewrite` leaves it alone (no Equal), and `Match` /
   the trail substitute the value before the wrapped atom is interned
   into the emitted row. Nothing new here.
3. **Free (the new case).** A Variable mentioned only inside the
   constraint, with no prior binding. Today these get *trail-bound*
   into a fresh-id template like any other Emit-side variable, which is
   wrong: each constraint atom would then carry a ground id template
   that the choice component would treat as a literal, never letting
   the same value flow through multiple sub-atoms.

The fix: at expand time, free variables inside a constraint get
replaced by **var terms** — fresh `*var`-headed templates that are
*opaque ids* like `*id` / `*choose` so they survive interning, but at
choice-component time are treated as **fresh existentials** (in the
same sense as today's active terms, except they don't surface in the
emitted options).

### Why per-firing-fresh, not lexical?

The example in the overview spells it out:

```
event, ?X, ~it X
it A, !(p1 A Y, p2 Y)
it B, !(p3 B Y, p4 Y)
```

The two rules both name a variable `Y` inside their respective
constraints. The fired component's query is the conjunction across
*both* rules' constrain rows (because `A` and `B` both resolve to the
same active term from `?X`), so we must not capture each other's `Y`.
Each `!` block must mint its own per-firing existential id so the two
`Y`s map to different hashcons tokens.

A natural choice: reuse the existing fresh-id template machinery, but
with head `*var` instead of `*id`, and one fresh template per
constraint variable per `!` block (not per atom — within one `!(...)`
the same variable refers to the same hole, so it should produce the
same template).

## Syntax & parser

The single-atom forms `!bar` and `!bar -> Z` are **shorthand** for
`!(bar)` and `!(bar -> Z)` respectively — same IR, same downstream
treatment. The general form is `!(sub-atom, sub-atom, ...)` where
each sub-atom is either a plain match-shape atom or an aggregate
(`atom -> weight`). Sub-atoms are separated by top-level commas; the
syntax inside the parens is the same atom syntax that body-level
conjunctions already use.

Implementation: the tokenizer recognizes `!` followed (after optional
whitespace) by `(` as a compound-constrain opener. It reads until the
matching `)`, splits the inside on top-level commas, and for each
piece parses it with the existing `parseAtomText` (which already
handles trailing `-> weight`). The result is attached to a single
pre-expand `RuleAtom` of marker `constrain` whose `subAtoms` field
holds the list. The single-atom form `!foo` (no `(`) flows through the
existing path and is canonicalized by the expander into a one-element
`subAtoms`. The aggregate single-atom form `!foo -> Z` parses today
as `constrain-aggregate`; it becomes a one-element compound whose
sub-atom is aggregate (the `constrain-aggregate` marker on the
RuleAtom is no longer load-bearing — see Net diff).

### IR shape for the wrapped term

There is now a single row head `_constrain` (no more `_constrain-agg`
at row level). Its terms[1] wrapped term is always a `*conj`-headed
`Id` of length N+1:

```
(*conj sub1 sub2 ... subN)
```

Each `sub_i` is an `Id`-tagged tagged pair distinguishing plain vs
aggregate:

- plain:     `(*c-plain (head t1 t2 ...))`
- aggregate: `(*c-agg   (head t1 t2 ... weight))`

The inner `(head t1 ...)` is a regular `Atom` so its terms can be
walked by `activeTokensIn`-style helpers. The outer wrapper tag
distinguishes the two cases without forcing us to recover it from
"does the row head end in `-agg`."

Using `Id` tagging (head Symbol starts with `*`) keeps wrapper terms
opaque against accidental sub-walks. `*conj` / `*c-plain` / `*c-agg`
/ `*var` are added alongside the existing `*id` / `*choose` / `*mom`
/ `*chain` reserved compiler heads.

The single-atom shorthand `!bar` lowers to
`(*conj (*c-plain (bar ...)))` (N = 1). `!bar -> Z` lowers to
`(*conj (*c-agg (bar ... Z)))`. There is no separate single-atom IR
path downstream — `_constrain-agg` rows stop being produced.

## Expand changes

`decomposeEmit` handles the `constrain` marker today. The compound
case branches before `emitBindingsAndRewrite` and runs its own pass.

### Algorithm (per `!(...)` block)

Inputs at the time we encounter the constrain Emit:
- `prefixSeen: Set<string>` — Variable names bound by atoms earlier in
  the rule (snapshot before this Emit's contributions, like
  `decomposeAggregate` already takes).
- `subAtoms: Atom[]` — N inner sub-atoms, parsed.

Step 1. Collect every Variable name appearing in `subAtoms` and not in
`prefixSeen`. These are the **free vars** for this block.

Step 2. For each free var name `Y`, mint a single fresh template
`varTpl(Y) = (*var rule lexPos (*chain ...prefix) :Y)` — same structure
as `freshIdTemplate` but with head `*var`. The chain snapshot is the
prefix's chain (so the template is per-firing-unique and per-block-
unique within a rule).

Step 3. Walk each sub-atom and rewrite:
- An occurrence of free var `Y` → `varTpl(Y)`.
- A Wildcard → an anonymous `varTpl("_")` minted afresh per occurrence
  (no two wildcards share an existential — matches today's
  `emitBindingsAndRewrite` Wildcard treatment).
- An in-scope Variable → leave as Variable (the trail substitutes it
  at Emit-intern time, same as today).
- An `ask`-bound Variable → covered by the previous bullet because
  `?Y` puts `Y` in `seen` with a `*choose`-rooted `*id` template; the
  trail substitutes it normally.
- Symbols / compounds → recurse.

No `Equal` is emitted for free vars: they have no name we need to
bind in the trail (their identity is only meaningful *inside* this
constraint), and binding `Y` in the rule's trail would leak the
existential into downstream atoms. The Wildcards-style "substitute
inline, no Equal" path is exactly what we want.

Step 4. Wrap the rewritten sub-atoms. Always produce the
`*conj`-headed form:
```
wrapped = Id { terms: [*conj, wrapSub(sub_1), ..., wrapSub(sub_N)] }
```
where `wrapSub(sub_i)` is
`Id { terms: [*c-plain, Atom(sub_i.atom)] }` for a plain sub-atom or
`Id { terms: [*c-agg, Atom([...sub_i.atom.terms, sub_i.weight])] }`
for an aggregate. The trailing weight slot in `*c-agg`'s inner atom
matches the layout `_do-agg` already uses, so the existing aggregate
machinery can be reused unchanged when querying.

Step 5. Emit one `_constrain` row (always the same head — no more
`_constrain-agg` row head) plus the paired Match.

## Choice component evaluation

`constraint-query.ts` reads each `_constrain` row's wrapped term via
`unwrapAtom`, then walks it for active tokens via `activeTokensIn`,
then queries via `runComponent`. Three touchpoints:

### Unwrap

Drop the `_constrain-agg` branch from `gatherConstrainRows`'s outer
loop — only `_constrain` rows exist now. Unwrap the row's terms[1]
into the `*conj` outer Id, then split into a list of
`(kind: "plain" | "agg", atom: Atom)` sub-atoms by inspecting each
`*c-plain` / `*c-agg` wrapper. Change `ConstrainRow.wrapped: Atom`
plus `kind` to:

```ts
interface ConstrainSub { kind: "plain" | "agg"; atom: Atom; }
interface ConstrainRow {
  rowIndex: number;
  subs: ConstrainSub[];   // length ≥ 1
  touched: Set<number>;   // unioned across subs
  exist: Set<number>;     // existential tokens, unioned across subs
  l: Term;
}
```

### Var-term semantics

Introduce a second token set alongside `activeSet`:
`existSet: Set<number>` — the tokens of fresh `*var` templates
encountered across all constrain rows in this fixpoint round.

Discover the set at `gatherConstrainRows` time: walk each sub-atom
(recursively, same shape as `activeTokensIn`) and add every term
whose head is `*var` (use `isFreshVarTemplate` analogous to the
existing `isFreshIdTemplate`). Store in the row alongside `touched`.

Pass `existSet` to `runComponent` / `matchTerm` / `runAggRow`:

- `matchTerm`: union `activeSet ∪ existSet` for the "variable slot"
  check. An existential binds in `sub` the same way an active term
  does (same hashcons token → same value across uses), but `emit`
  ignores it (existentials don't appear in `activeKeys`).
- `runAggRow`: the `aggPattern` freeify pass rewrites any token in
  `activeSet ∪ existSet` to `_free` (existentials get aggregated
  over, exactly like active slots).
- `gatherChoiceContext.boundValues` is unaffected: existentials don't
  get `is` rows, so they never appear as substitution keys.

### Component graph

`buildComponents` builds the bipartite graph between *active* tokens
and constrain rows. Existentials don't participate (they're local to
a row, so they shouldn't pull non-adjacent rows into a component).
Rows with no active tokens but with existentials are still skipped
(today's `touched.size === 0` → `continue` filter). This means a
constraint mentioning *only* existentials does nothing — which is
fine: it's `!(foo Y, bar Y)` with no `?` in scope, equivalent to a
guard that we currently don't bother surfacing as a choice.

The empty-fringe check (`comp.rows.length === 0` with active members)
keeps working unchanged: it's about active terms with no incident
constrain rows, not about existentials.

### Multi-sub-atom backtracking

`runComponent.go(rowIdx, sub)` iterates `comp.rows`. With compound
rows, each row holds `subs: ConstrainSub[]`. Replace the inner `for
(cidx of candidatesByHead(...))` with a recursion over the row's
subs: the row succeeds when there's a join across all subs that
respects the shared substitution `sub`. Each sub dispatches on its
own `kind`:

- `kind: "plain"`: today's per-tuple structural-unify loop, but
  scoped to one sub-atom (not the whole row's old single atom).
- `kind: "agg"`: today's `runAggRow` logic, but invoked on this
  sub-atom alone. The existential set extends the `_free` rewrite,
  same as for active tokens. `aggregateOver` returns groups; for
  each group we unify back against the sub-atom's keys + weight,
  threading the row-wide `sub`, then recurse to the next sub.

Sketch:

```ts
function goRow(row, sub, ai, after) {
  if (ai === row.subs.length) return after(sub);
  const s = row.subs[ai];
  if (s.kind === "plain") goPlainSub(s.atom, sub, (sub2) => goRow(row, sub2, ai + 1, after));
  else                    goAggSub  (s.atom, sub, (sub2) => goRow(row, sub2, ai + 1, after));
}

function goPlainSub(subAtom, sub, after) {
  const head = subAtom.terms[0];
  if (head?.tag !== "Symbol") return;
  for (const cidx of candidatesByHead(store, head.name)) {
    const cand = store.tuples[cidx];
    if (cand.atom.terms.length !== subAtom.terms.length + 1) continue;
    if (!intervalContains(store, cand.l, cand.r, M, M)) continue;
    const trial = new Map(sub);
    let ok = true;
    for (let i = 0; i < subAtom.terms.length; i++) {
      if (!matchTerm(subAtom.terms[i], cand.atom.terms[i], trial, store, slotSet)) {
        ok = false; break;
      }
    }
    if (ok) goRow(row, trial, ai + 1, after);
  }
}
```

…where `slotSet = activeSet ∪ existSet` and the outer driver becomes
`go(rowIdx + 1, sub)` after the row's `goRow` runs through all its
subs. `goAggSub` is the existing `runAggRow` body specialized to one
sub-atom and parameterized by `slotSet` instead of `activeSet`.

## Net diff

- `ts/src/v2/parse.ts`:
  - Tokenizer: recognize `!` followed by `(` (optional whitespace) as a
    compound-constrain opener. Read inner top-level until matching
    `)`, split on top-level commas, parse each piece via the existing
    `parseAtomText` (which handles trailing `-> weight`), and produce
    a synthetic token carrying the resulting sub-RuleAtoms.
  - Parser: turn that token into a single pre-expand `RuleAtom` with
    `marker: "constrain"` and a new `subAtoms: SubConstrain[]` field
    where `SubConstrain = { kind: "plain" | "agg"; atom: Atom; weight?: Term }`.
  - Existing single-atom paths (`!foo`, `!foo -> Z`) are canonicalized
    here too: the parser builds a one-element `subAtoms` list (kind
    chosen by presence of `weight`) so downstream code never sees the
    legacy single-atom shape.
- `ts/src/v2/types.ts`: add `subAtoms` to the pre-expand `Atom`-tag
  variant. The `constrain-aggregate` marker can be removed (its
  information is now in the sub-atom's `kind`).
- `ts/src/v2/expand.ts`:
  - Add `freshVarTemplate(state, lexPos, varName)` mirroring
    `freshIdTemplate` with head `*var`.
  - Collapse `decomposeEmit`'s `constrain` and `constrain-aggregate`
    branches into one: walk `subAtoms`, run the per-block existential
    rewrite, wrap each sub in `*c-plain` / `*c-agg`, and emit a
    single `_constrain` row whose wrapped term is the `*conj`-headed
    Id of those wrappers. The `_constrain-agg` row head is removed.
  - `SYM_CONJ` / `SYM_C_PLAIN` / `SYM_C_AGG` / `SYM_VAR` constants
    alongside existing reserved heads.
- `ts/src/v2/constraint-query.ts`:
  - `ChoiceContext` gains `existSet: Set<number>`.
  - `isFreshVarTemplate` helper alongside `isFreshIdTemplate`.
  - `gatherConstrainRows`: only iterates `_constrain` (drop the
    `_constrain-agg` branch). Unwraps `*conj` outer + per-sub
    `*c-plain` / `*c-agg` into `ConstrainSub[]`.
  - `activeTokensIn` walks every sub's inner atom; a parallel
    `existTokensIn` populates `existSet`.
  - `matchTerm` / agg-sub freeify accept a `slotSet = activeSet ∪
    existSet`; `emit` continues to project only `activeKeys`.
  - `runComponent.go` swaps the per-row body for the multi-sub
    recursion sketched above; the legacy row-level `kind: "plain" |
    "agg"` dispatch moves to per-sub dispatch.
- Tests:
  - `ts/data/v2/choice-test.t` or a new fixture: a rule with
    `?A ?B !(prop A X, other-prop X B)` where the existential `X`
    enables/blocks options that single-atom constraints can't express.
  - The overview's two-rule shared-active-term example: confirm the
    two `Y`s don't capture each other (i.e., we get the cross product
    `p1 X Y1, p2 Y1, p3 X Y2, p4 Y2`).
  - A regression: existing single-atom `!atom` continues to behave
    identically (same options, same surfaced components).

## Scoping rules (resolved ambiguities)

- **Same-name var in two subs of one `!(...)`**: shared single
  existential. That's *the* point — `!(p A X, q X B)` joins the two
  queries on `X`.
- **Same-name var in two different `!(...)` blocks within one rule**:
  *independent* existentials. Block-scoped, not rule-scoped. Each
  block's var template uses that block's `lexPos`, so the hashcons
  tokens differ even if the user wrote the same name. Matches the
  cross-rule example from the overview (where two rules' `Y`s also
  must not capture).
- **Var first introduced inside `!(...)` and then mentioned later in
  the rule body**: parse / expand error. The existential is opaque
  outside the block; no `Equal` is emitted for it, so a subsequent
  atom that names `Y` would see an unbound Variable. Detect at
  expand time: if a Variable named in some atom after the block
  isn't in `prefixSeen` (i.e., was only ever bound inside a `!(...)`
  block's existential rewrite), reject the rule. Implementation: when
  the expander finishes processing a constraint block, the free-var
  names it consumed get added to a separate "constraint-only" set
  (not `state.seen`); later atoms that hit `noteVar` against a name
  in that set are reported as an error.
- **Legal sub-atom shapes inside `!(...)`**: plain match-shape only
  (`head t1 t2 ...`) and aggregate (`head t1 ... -> w`). Reject
  anything else at parse — markers (`?`, `~`, `+`, `^`, `!`),
  equalities (`= a b`), and nested sub-blocks `(...)`. These would
  have ill-defined semantics inside a conjunctive constraint.
- **Empty `!()`**: parse error.
- **Whitespace before the `(`**: `! (foo, bar)` is the compound form
  too. The discriminator is "is the next non-whitespace token a `(`?"
  There's no back-compat conflict because `!atom` with a parenthesised
  body never parsed cleanly under the old single-atom path (commas
  inside an atom body broke `tokenizeTermText`).

## Open questions

- **Outer `-> w` on a `!(...)` block.** Disallowed: weight applies to
  a single relation, and the conjunctive semantics across multiple
  sub-atoms aren't defined. Reject `!(a, b) -> w` at parse. Aggregates
  go on *individual* sub-atoms (`!(a, b -> Y)`); the single-atom
  shorthand `!bar -> Z` is just `!(bar -> Z)`.
- **Existential reuse across the rule.** If `Y` appears inside `!(...)`
  *and* in the rule body outside it, treat it as "ordinary in-scope
  Variable" (case 2), not as an existential. The prefix-seen snapshot
  drives this — same rule `decomposeAggregate` already uses.
- **Var templates across delta variants.** `freshVarTemplate` uses the
  same `chainTemplateWithHead` shape as `freshIdTemplate`, so two
  variants of the same rule firing on the same matched-tuple set will
  produce identical var templates (just like identical `*id`
  templates). That's the desired identity-on-the-hashcons-trail; no
  special case needed.
- **`*var` head reservation.** `parseAtomText` already rejects user
  source whose head Symbol starts with `*`. `*var` falls under that
  rule automatically.
- **Interaction with `[[v2-is-substitution]]`.** Existentials are not
  candidates for `is`-substitution: `isFreshIdTemplate` checks for
  `*id` / `*choose`. We deliberately do not add `*var` there — an
  existential isn't a stable name the user can refer to from outside
  the constraint, so there's no `is X V` row to ever exist for one.
- **Display side.** Compound constraints don't change
  `activeTerms`/`options` shape, so `default-display.ts` needs no
  change.

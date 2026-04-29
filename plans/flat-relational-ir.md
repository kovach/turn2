# New flat relational IR (TurnExpr)

Replace the nested `Tree` shape that drives evaluation with a flat
constraint list — `TurnExpr` (TE for short). The current tree carries
two intertwined burdens: it is both the source-shape of a rule (how the
user wrote nesting + indentation) and the *evaluator's* working
representation (what `unifyTree` walks to drive matching). The flat IR
pulls those apart: source parsing keeps producing the nested `Tree`, but
before evaluation each rule is lowered into a TE — a list of
constraints in which temporal/structural relationships that are
currently implicit in `parent.children` indices become explicit
*episode relationships* between named ids.

Spec: `notes/overview.md` §"new flat relational IR".

## Goals

1. **Flat list, not a tree.** A rule's body is a `Constraint[]` rather
   than a recursive `Tree`. Sibling order and parent-child edges in the
   source are dissolved into explicit binary relations between node
   ids, in the same vocabulary as `plans/temporal-relationships.md`.
2. **One negative leaf.** Match / Before / Overlap collapse into a
   single constraint kind ("match this atom under these episode
   constraints"); the matching mode they currently encode is recovered
   from the episode relationships attached to the node id.
3. **Leaf-only positives.** `Assert` and `Constrain` are leaf
   constraints carrying an id + atom. `Ask` is rewritten upstream
   to `Assert(_choose)` and `Aggregate` to `Assert(agg-instance)`,
   so neither has a TE constructor. Edge insertion is its own
   constructor (`AssertIntervalRel`) — see goal 4.
4. **Interval relationships are first-class constructors —
   negative and positive.** `IntervalRel{kind, a, b}` is the
   negative form (matches an existing relationship row);
   `AssertIntervalRel{kind, a, b}` is the positive form (inserts
   one). Both range over the same fixed `IntervalRelKind` enum
   (`before` / `contains` / `prior` / `overlap`) — not user-
   extensible vocabulary, and not encoded as `Atom`s whose head
   happens to be a relation symbol.

## What "TurnExpr" looks like

```ts
// One node in the flat IR. Carries the same id+atom shape as today's
// BodyTree, plus a discriminator. No `children` field — relationships
// to other constraints in the same TE are expressed only through
// episode-relationship constraints over ids.
type Constraint =
  | { tag: "Match";             mode: AtomMode;              id: Term; atom: Atom }
  | { tag: "Assert";                                         id: Term; atom: Atom }
  | { tag: "Constrain";                                      id: Term; atom: Atom }
  | { tag: "IntervalRel";       kind: IntervalRelKind;       a: Term;  b: Term    }
  | { tag: "AssertIntervalRel"; kind: AssertIntervalRelKind; a: Term;  b: Term    }
  | { tag: "Equal";             lhs: Term; rhs: Term };

type AtomMode             = "delta" | "old" | "any";
type IntervalRelKind      = "before:after" | "contains" | "prior" | "overlap";
type AssertIntervalRelKind = "before:after" | "contains";
// `before:after(a, b)` reads "a is before, b is after" — a precedes
// b. The colon in the kind string mirrors the relation name in
// `refstore.ts` (`beforeAfter`/`afterBefore` maps), so there's no
// silent arg-order ambiguity at the call site. AssertIntervalRel is
// restricted to the two raw edges that actually land in the refstore
// (`before:after`, `parent:child`). `prior` and `overlap` are
// derived relations with no raw row to assert; they only appear on
// the negative `IntervalRel` side. `prior` has no TE producer today
// — it's reserved as a negative-pattern kind.

type TurnExpr = {
  // Order: tree-traversal order (depth-first, source order), with
  // every Assert / AssertIntervalRel appended at the end so all
  // assertions fire only after the matching prefix has succeeded.
  // The evaluator runs left-to-right; correctness is mostly
  // order-independent, but Equal must precede the constraints whose
  // variables it binds (traversal order takes care of this without
  // a planner).
  constraints: Constraint[];
};
```

The `Match` constraint (negative-only) replaces today's Match /
Before / Overlap. There
is no separate "kind of negative literal" — instead, sibling
`IntervalRel` constraints in the same TE constrain how the matched id
relates to other ids:

- A node that today is a `Match` child of parent `P` becomes
  `Match{id: X, atom: …}` together with
  `IntervalRel{kind: "contains", a: P, b: X}` (P transitively contains X
  — strict-descent today).
- A node that today is `Before` after sibling `S` becomes
  `Match{id: X}` with `IntervalRel{kind: "before:after", a: S, b: X}`
  ("S is before, X is after"; or with the parent as `a` when the
  anchor is a parent — the same disambiguation
  `plans/before-sibling.md` already performs).
- A node that today is `Overlap` under parent `P` becomes
  `Match{id: X}` with `IntervalRel{kind: "overlap", a: P, b: X}`.

So Match/Before/Overlap dispatch — currently a `tag` switch in
`matchSubtree` — turns into "which `IntervalRel` constraints reference
this id in the same TE?". One negative leaf kind, with the matching
mode falling out of the surrounding `IntervalRel` constraints.

`IntervalRel` is a *separate constructor*, not an `Atom` whose first term
is a relation symbol. The four relations (`before`, `contains`,
`prior`, `overlap`) are a fixed enum, not user-extensible vocabulary
— treating them as ordinary atoms would conflate them with user
predicates that happen to share a name and would force the unifier to
re-discover their meaning at every call site. The constructor + enum
keeps the dispatch direct and makes "what episode relations are
attached to this id" a structural query over the TE rather than a
substring match on atom heads.

`mode` (`delta` / `old` / `any`) carries the existing
`MatchConstraint` semantics needed by semi-naive evaluation, and is
unrelated to the structural mode (which now lives in the episode
constraints).

## Lowering: nested Tree → TurnExpr

A new pass `lower(tree: Tree): TurnExpr` runs once per rule, after
`expand` (so it never sees `Ask` or unbound auto-`X` ids — those are
resolved by `idExpand` already). The lowering walk:

1. Walk the tree depth-first. For each `BodyTree` node, emit a
   constraint of the appropriate tag using the node's already-assigned
   id (`idExpand` has stamped every node with a stable `Id` term).
2. **Strip the synthetic root.** Today the pattern root is a `Match`
   with empty atom and `id = Wildcard`, present only because the
   surface syntax produces a single tree per rule. The lowering
   discards it: emit no constraint for the root, and treat its
   direct children as having *no pattern parent*. They therefore
   produce no `(Assert)IntervalRel{contains, …}` constraint
   referencing the root. Root-level positives become genuinely
   parentless rows in the refstore, which is the semantic shift Q4
   was tracking — already accepted there.
3. While walking, accumulate interval-relationship constraints —
   `IntervalRel` for negative nodes, `AssertIntervalRel` for
   positive nodes:
   - For every nested child `C` of a *non-root* parent `P`:
     - if `C` is a negative node (Match / Before / Overlap), emit
       `IntervalRel{kind: "contains", a: P.id, b: C.id}`;
     - if `C` is a positive node (Assert / Constrain), emit
       `AssertIntervalRel{kind: "contains", a: P.id, b: C.id}`
       — what `step.ts:insertChild` writes today via
       `parent:child(parent, new)`.
   - For every pair of pattern siblings `(A, B)` whose source order
     matters today (`isTemporallyBefore(A.path, B.path)` — i.e. the
     "previous bindable sibling" relationship in `tree.ts`):
     - if `B` is negative, emit
       `IntervalRel{kind: "before:after", a: A.id, b: B.id}`
       (A is the earlier sibling, B the later);
     - if `B` is positive, emit
       `AssertIntervalRel{kind: "before:after", a: A.id, b: B.id}`
       — what `step.ts` writes today via `addBeforeAfter` in the
       "positive as sibling of match" case.
   - Overlap nodes use `IntervalRel{kind: "overlap", …}` instead of
     `contains`.
   - Aggregate nodes are *not* emitted as a separate constraint:
     `expand.ts` rewrites them upstream into `Assert(agg-instance)`
     plus the binding rules, so by the time `lower` runs every
     Aggregate has already become an Assert. The TE has no
     `Aggregate` constructor.

   Read literally: `+ foo` lowers to one `Assert` plus *zero or
   more* `AssertIntervalRel`s — one for `parent:child` if the
   pattern parent is non-root, one for `before:after` if the node
   has a prior bindable sibling. A `+ foo` directly under the
   pattern root with no prior sibling lowers to just `Assert`.
4. `Equal` nodes lower 1:1 — they have no id and no interval
   relationship, just a flat `lhs = rhs`. They appear in the
   constraint list at their tree-traversal position so any later
   constraint that reads a variable Equal binds will see the
   binding.

Expansion rules in `expand.ts` do not change shape — they still
operate on the nested `Tree`. Only the *output* of `expand` is fed
through `lower` before reaching `step`.

## Evaluator changes

The evaluator stops doing a recursive walk over `Tree.children` and
instead drives a constraint-solving loop over a flat list. Concretely:

- `collectPositiveNodes` (currently in `tree.ts`) becomes a filter
  over the constraint list — every `Assert` / `Constrain` /
  `AssertIntervalRel` constraint is positive; the
  `prevBindableSibling` field disappears because the `before:after`
  edge it controlled is now an explicit `AssertIntervalRel`
  constraint that the lowering already emitted.
- `unifyTree` becomes `unifyConstraints(te, ref, …)`. The recursive
  descent / strict-descent / "previous sibling anchor" logic in
  `unify.ts` is replaced by per-kind dispatch on `IntervalRel.kind`,
  backed by the refstore relations described in
  `plans/temporal-relationships.md`. An
  `IntervalRel{kind: "before:after", a: A, b: X}` constraint is
  satisfied by querying the refstore's `beforeAfter`-closure helper
  (the transitive closure of the raw `before:after` edges lifted
  through `contains`); the four kinds map directly onto the four
  derived helpers.
- `step.ts` no longer wraps row insertion + relationship-edge
  emission in a single `insertChild` call. The two are separate
  primitives in the new IR — atom rows come from `Assert` /
  `Constrain` constraints, edges come from `AssertIntervalRel`.
  `insertChild` is eliminated; in its place, `refstore.ts` exposes
  a row-only insert (no parent argument) and `addParentChild` /
  `addBeforeAfter` for the edges. The "non-root row must have a
  parent" invariant in `checkIntegrity` is dropped, and `parentOf`
  becomes either an optional cache or is removed entirely (callers
  that want a node's parents should read `parentsOf`, which is
  already many-to-many).
- **Drop the synthetic `$root` row.** `emptyRefStore` no longer
  seeds a `$root` `NodeRow`; `store.rootId` and `getRoot` go away.
  The store starts genuinely empty. Top-level inserts are
  parentless rows with no `parent:child` edge, exactly as the
  lowering already produces. The synthetic root was carrying two
  loads:
  1. *Insertion target for top-level positives* — no longer
     needed: PR 1's lowering emits no `IntervalRel{contains}` for
     root-children, and PR 2's split-out edge primitives don't
     require a parent on insert.
  2. *Walk-anchor for `refStoreToTree`* — moved into
     `refStoreToTree` itself: it synthesises an in-memory root
     `ResultTree` at materialisation time whose `children` are
     every row with no incoming `parent:child` edge (i.e. the
     parentless / roots-of-forest set), in insertion order. The
     synthetic node never lives in `store.nodes` and has no id
     that any rule can reference. `refStoreToTree`'s output type
     gains a `tag: "$synthetic-root"` (or similar) so consumers
     don't confuse it with a real row.
  3. *Symbol-index seed and integrity-check anchor* — neither
     was load-bearing; both fall away with the row.
  `checkIntegrity` loses the "root present and matches store.rootId"
  clause; nothing else changes there. Integration callers that
  previously relied on `getRoot` (tests, web display) read the
  forest via `refStoreToTree` or iterate `allCandidates` directly.

The result is that *all* of the structural reasoning the evaluator
does today — descent checks, sibling ordering, overlap — is reduced
to ordinary atom unification against the refstore. There is no more
"walk a pattern tree"; there is only "satisfy a list of constraints".

**Mutation-during-iteration.** Today `step.ts` threads `iteration`
through `unifyTree` so newly inserted rows (stamped with
`gen === iteration`) are hidden from the live pass via
`passesConstraint`. The TE driver inherits the same invariant: when
satisfying a `Match{mode}` constraint, candidates with `gen ===
iteration` are filtered out under `mode: "old"` and required under
`mode: "delta"`, exactly as today. `AssertIntervalRel` edge inserts
do not need a `gen` because edges are not matched against; only rows
are.

## Ask, Constrain, Aggregate

All three resolve to ordinary leaf constraints by the time `lower`
sees them:

- `Ask` is rewritten by `rewriteAskToChoose` in `expand.ts` to
  `Assert(_choose)`. The TE has no `Ask` constructor.
- `Aggregate` is rewritten upstream (see `aggregate-fold.ts` and
  `plans/aggregates.md`) to `Assert(agg-instance)` plus the binding
  rules. The TE has no `Aggregate` constructor — the fold pass
  continues to operate on refstore rows, never on TE.
- `Constrain` lowers 1:1 to a `Constrain` constraint with the same
  id+atom; semantically positive during fixpoint, but tagged
  separately so the fringe / option logic in
  `plans/constraint-tuples.md` can find it.

## What stays the same

- Hashconsing (`ts/src/hashcons.ts`) is unchanged — TE constraints
  carry the same `Term` and `Atom` types.
- `RefStore`'s row data and structural indexes (`nodes`,
  `parentChild`, `parentsOf`, `beforeAfter`, `afterBefore`,
  `index`, `descendantsCache`) keep their shapes — interval
  relationships already live there per
  `plans/temporal-relationships.md`. The *insertion API*, the
  synthetic `$root` row, and a couple of integrity invariants
  change (see §Evaluator changes and the `refstore.ts` rename
  below).
- Source parsing and the user-visible language are unchanged.
- `expand.ts` keeps producing nested `Tree` rules; lowering is a
  separate pass that runs *after* expand, before `step`.

## Refstore rename: `before` → `beforeAfter`

To make the arg-order convention manifest at every call site, rename
the derived helpers and edge primitives in `refstore.ts`:

- `before(store, a, b)` → `beforeAfter(store, a, b)` — reads "a is
  before, b is after," matching the kind string `"before:after"` and
  the existing `beforeAfter: Map<NodeId, Set<NodeId>>` field.
- `addBeforeAfter` keeps its name (already correct).
- `prior` keeps its name; its arg order ("a is prior to b") is
  already unambiguous.

This is a mechanical sed-style rename; included here because the TE
rename above would otherwise leave callers reading `before(a, b)`
and `IntervalRel{kind: "before:after", a, b}` side by side and
having to reverse-engineer that they mean the same thing.

## Migration shape

The change is large enough that a single-shot rewrite is risky. A
staged path:

1. **Define `Constraint` and `TurnExpr`** in `types.ts` alongside the
   existing `Tree`. Add a `lower(tree: Tree): TurnExpr` function.
   Lowering is one-way; the test bar is *semantic preservation*, not
   round-trip — for every program in `ts/src/tests/data`, the TE
   evaluator must produce the same store as the tree-walker.
2. **Dual-run.** Run each test program twice — once through the
   existing tree-walker, once through the TE evaluator on the
   lowered form, each against its own `RefStore`. At fixpoint
   exit, diff the two stores (rows + interval-relationship edges).
   No in-line cross-checking inside `step` — two parallel runs are
   easier to wire and catch the same class of bug. Discrepancies
   are bugs in the lowering or in the new evaluator.
3. **Switch the fixpoint to TE.** `step.ts` consumes
   `TurnExpr` directly; the recursive `Tree` walker is retired.
   `tree.ts` keeps the source-side helpers (`fringe`, `walkTree`,
   `termContains`) since those operate on parsed source, not on the
   evaluator's IR.
4. **Drop dead Tree fields and code paths.** With nothing reading
   `Tree.children` post-expand, retire the tree-walker code paths
   in `unify.ts` / `tree.ts` (`matchSubtree`, `collectPositiveNodes`,
   the `prevBindableSibling` plumbing, `MatchConstraint` on
   `Tree`). The source `Tree` shape slims down to just what `parse`
   and `expand` need.

Stages 1–2 are non-breaking: the existing tests keep passing because
the TE evaluator is a shadow path. Stage 3 is the cutover; stage 4 is
cleanup.

## Files to change

Not exhaustive — these are the load-bearing ones.

1. `ts/src/types.ts` — add `Constraint`, `TurnExpr`, `AtomMode`,
   `IntervalRelKind`, `AssertIntervalRelKind`.
2. New `ts/src/lower.ts` — `lower(tree: Tree): TurnExpr`.
3. `ts/src/step.ts` — switch from `collectPositiveNodes(pattern)` +
   `unifyTree(pattern, …)` to iterating a `TurnExpr` and calling the
   new constraint-list unifier; dispatch `AssertIntervalRel` to the
   new edge primitives.
4. `ts/src/unify.ts` — replace the recursive `matchSubtree` with a
   constraint-list driver. Strict-descent / sibling-order / overlap
   checks become refstore lookups via `contains` / `before` /
   `overlap`.
5. `ts/src/refstore.ts` — eliminate `insertChild` (split into a
   row-only insert with no parent + `addParentChild` /
   `addBeforeAfter` edge primitives); drop the synthetic `$root`
   row (remove `rootId` / `getRoot`; `emptyRefStore` returns a
   genuinely empty store); rewrite `refStoreToTree` to synthesise
   an in-memory root over the parentless rows; drop the
   "non-root row must have a parent" and "root present" clauses
   in `checkIntegrity`; demote `parentOf` to optional/removed;
   rename `before` → `beforeAfter` (see §"Refstore rename"
   above).
6. `ts/src/tree.ts` — `isTemporallyBefore` and the source-walking
   `fringe` helpers stay (still operate on parsed source).
   `collectPositiveNodes` is replaced by its TE-list filter
   equivalent in `lower.ts` / `step.ts`.
7. `ts/src/expand.ts` — unchanged shape; runs `lower` on its output
   before handing off to `step`.
8. Tests — add lowering tests; existing semantic tests should pass
   unchanged once the TE evaluator is wired.

## Open questions / ambiguities

The overview bullet is short and several decisions are left implicit.
Flagging them here so they can be resolved before implementation
starts:

1. ~~Do the four interval relationships live as atoms in the same
   constraint list, or as a separate constructor?~~ Resolved:
   separate `IntervalRel` constructor with a `kind: IntervalRelKind` enum
   over the four relations.

2. ~~`MatchConstraint` (delta / old / any) — on the `Match`
   constraint or as a separate per-iteration overlay?~~
   **Resolved:** attach `mode` to `Constraint{tag: "Match"}`.

3. ~~Single negative leaf vs. atoms-only.~~ **Resolved:** atoms-only.
   `before` and `overlap` are binary properties, encoded explicitly
   via `IntervalRel`. The old `match` mode was standing in for "as a
   child of its parent, if it has one", which was confusing —
   especially for Match nodes under the synthetic root Match. The
   new IR has exactly one kind of leaf atom-matching concept; all
   temporal/structural relationships are carried separately as
   `IntervalRel` constraints.

4. ~~Where does the TE root anchor — does insertion still require a
   parent?~~ **Resolved:** parentless rows are allowed. The
   evaluator emits atom insertion and `parent:child` /
   `before:after` edges as *separate* constraints
   (`Assert` + `AssertIntervalRel`), so there is no need for the
   coupled `insertChild` primitive that requires a parent.
   Concrete consequences (folded into the relevant sections above):

   - Add `AssertIntervalRel` to the `Constraint` union (positive,
     paired with the existing negative `IntervalRel`).
   - Drop the "non-root row must have a parent" invariant from
     `checkIntegrity`. Also drop the synthetic `$root` row itself:
     `emptyRefStore` starts genuinely empty, `store.rootId` /
     `getRoot` go away, and `refStoreToTree` synthesises an
     in-memory root view at materialisation time over the
     parentless rows (see §Evaluator changes for the full
     consequences).
   - Eliminate `refstore.ts:insertChild`. Replace with a row-only
     insert (no parent) plus `addParentChild` / `addBeforeAfter`
     edge primitives — the lowering already produces the row and
     the edges as separate constraints, so the coupling buys
     nothing.
   - `step.ts` iterates the constraint list, dispatching `Assert`
     / `Constrain` to a row insert and `AssertIntervalRel` to the
     matching edge primitive.

5. ~~Interaction with `plans/temporal-relationships.md` staging.~~
   **Resolved (mostly already landed):** `refstore.ts` already
   carries `parentChild` / `parentsOf` / `beforeAfter` /
   `afterBefore` as `Map<NodeId, Set<NodeId>>` plus their inverses,
   and exports `contains`, `strictlyContains`, `before`, `prior`,
   `overlap` as derived helpers (with a memoised `descendantsCache`
   for the `contains` hot path). `step.ts` already calls
   `addBeforeAfter` for the "positive as sibling of match" case.
   Lowering can dispatch each `IntervalRel.kind` directly onto these
   existing helpers — no transitional bridge needed. Bits of the
   temporal-relationships plan that are *not* yet landed (the `,`
   Overlap literal in the parser; multi-parent insertion; promoting
   `parentOf` to `parentsOf` everywhere) are independent of TE.

6. ~~Equal nodes and interval relationships.~~ **Resolved:** Equal
   stays a separate constructor (no id, no atom — atoms-only would
   force a synthetic id with no meaning).

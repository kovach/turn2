# Explicit temporal relationships

Lift two currently-implicit assumptions — "positive insertions go at the end
of their parent's child list" and "sibling index order *is* temporal
order" — so that both parent/child and before/after become ordinary
relations over node ids. Spec: `notes/overview.md` §"new temporal
relationships / removing totally ordered child requirement".

## Goals

1. `parent:child(X, Y)` is an assertable atomic fact. Any node may have
   multiple parents; the transitive closure is required to be a partial
   order (no cycles, not necessarily a tree).
2. `before:after(X, Y)` is an assertable atomic fact giving temporal
   adjacency between two nodes. Sibling index order no longer implies
   temporal order.
3. Four derived relations are defined in terms of the two primitives:
   - **contains**  = refl-trans-closure of `parent:child`.
   - **before**    = transitive closure of the one-step relation
     `R(A, B) ⟺ ∃ A', B'. before:after(A', B') ∧ contains(A', A) ∧ contains(B', B)`.
     Equivalently: `before(A, B)` iff there is a sequence
     `A = X₀, X₁, …, Xₙ = B` (n ≥ 1) with `R(Xᵢ, Xᵢ₊₁)` for every step.
     The one-step `R` alone is not transitive — `before:after(a,b) ∧ before:after(b,c)`
     would not yield `(a,c)` without closing. Closing gives the expected partial
     order: any chain of raw `before:after` edges (possibly jumping through
     containment between steps) is collapsed into a single `before` fact.
   - **prior**     = `before ∪ contains⁻¹` (B contains A ⇒ A is prior to B).
   - **overlap**   = `∃ C. contains(A, C) ∧ contains(B, C)`.
4. A new literal type **`,`** (Overlap) matches when the reference node
   overlaps the parent image, relaxing the strict-descent constraint
   used by Match / Before today.

## What this means for data

The reference store today (`ts/src/refstore.ts`) encodes structure via a
single `path: number[]` column, with parent recovered as the path prefix
and sibling order recovered by lex-compare on paths. Both encodings
collapse under the new semantics:

- **A node can have multiple parents.** `path` is no longer a key —
  there isn't a unique path from the root. `path` is dropped entirely
  from `NodeRow`; callers that currently read `path` move to the new
  `contains` / `before` helpers.
- **Sibling index order is meaningless for temporal queries.** The
  `children` arrays keep their role as an *iteration index* (fast
  "enumerate children of parent P") but their ordering is a storage
  artefact, not a semantic fact. `isTemporallyBefore` as currently
  implemented (lex-compare on paths) no longer corresponds to anything
  observable.

Two new relations appear in the store, keyed by `NodeId` pairs:

| relation           | shape                                   | role                                  |
| ------------------ | --------------------------------------- | ------------------------------------- |
| `parent:child`     | `Map<NodeId, Set<NodeId>>` + inverse    | direct child edges (many-to-many)     |
| `before:after`     | `Map<NodeId, Set<NodeId>>` + inverse    | temporal adjacency (many-to-many)     |

The existing `SymbolIndex`, `nodes`, and hashconsed atoms carry over
unchanged. The `parentOf: Map<NodeId, NodeId>` single-parent cache goes
away (or becomes a `parentsOf: Map<NodeId, Set<NodeId>>`).

## Derived-relation costs

Four helpers replace the current path checks. None of them are as cheap
as today's O(depth) prefix/lex compares, so indexing matters.

- **`contains(A, B)` — reachability over `parent:child`.** O(nodes)
  per call in the naive form. Two options:
  - compute on demand with memoization per fixpoint pass;
  - materialize the transitive closure as a third relation
    `contains: Map<NodeId, Set<NodeId>>` updated incrementally on each
    `parent:child` insert (amortised O(|contains(B)|) per insert).
  The materialized form matches the spirit of "relational storage":
  structural predicates become lookups. Start with memoised on-demand;
  measure.
- **`before(A, B)`.** The naive form asks "does there exist `(A', B')`
  in `before:after` with `A' ⊇ A` and `B' ⊇ B`?". With `contains`
  materialised, this is two lookups per candidate `before:after` pair.
  The useful direction at query time is usually "given A, enumerate all
  B before A (or after A)"; an index `beforeOf: Map<NodeId, Set<NodeId>>`
  giving *all nodes temporally before N* (transitively closed through
  containment on both sides) is the structural analogue of
  `contains`. Same recommendation: memoise on demand first, materialise
  when it shows up in profiles.
- **`prior`** is `before ∪ contains⁻¹` — no extra storage, just a
  disjunction at the call site.
- **`overlap(A, B)`** is "`contains(A) ∩ contains(B) ≠ ∅`"; memoised
  `contains` gives it in O(min(|contains(A)|, |contains(B)|)).

## Unify.ts impact

Three call sites in `unify.ts` currently consult path structure:

1. `isStrictDescendant(prevDeepest, path)` at the Match/Before descent
   check. Becomes `contains(prevDeepestId, candidateId) && prevDeepestId !== candidateId`.
2. `isTemporallyBefore(path, anchor)` for the Before literal becomes
   `before(candidateId, anchorId)` — strict `before`, not `prior`.
   `prior` would let a sibling pattern match a descendant of its
   predecessor, which is the job of Match's own descent check and would
   double-count.
3. `computeAnchor` for Before resolves "previous sibling, else parent".
   "Previous sibling" is no longer a structural concept; the anchor
   becomes "the pattern's parent image" in the common case, or is
   replaced by a query over `before:after` when Before needs to look
   through intermediate nodes. See `plans/before-sibling.md` for the
   current anchor rules — they need to be revisited here.

The new `,` literal slots in alongside Match/Before at the literal-type
dispatch in `matchSubtree`. Its descent check is `overlap(parentImageId,
candidateId)` instead of strict descent.

Pattern-sibling position does **not** imply temporal ordering. Two
Match siblings `- a` / `- b` match any pair of descendants of the
parent image with no required ordering between them (including `a`
and `b` overlapping or matching the same node, modulo the Match
descent check). The pattern root is just another Match node; its
direct children follow the same rule.

## Step.ts impact

Insertion currently appends a new row as the last child of its parent,
computing `path = parent.path ++ [parent.childCount]`. Under the new
model, insertion emits three facts instead of one composite:

1. The `node` row itself (id, literal, atom, gen) — unchanged.
2. A `parent:child(parentImageId, newId)` edge for each pattern parent
   the positive node claims. In the common case that's just the image
   of the pattern parent, matching today's behaviour.
3. A `before:after(prevId, newId)` edge if there is a natural "previous"
   node to sequence against. For inserts that extend a linear timeline
   this is the last inserted sibling; for inserts whose ordering is
   genuinely unconstrained, the edge is omitted.

Point (3) is where semantics get genuinely new: today every insertion is
totally ordered against every sibling; tomorrow some inserts are
incomparable. The sequencing rule is determined by *position in the rule
source*, not by an extra marker:

- A positive node nested under its match parent asserts only
  `parent:child`. Example:
  ```
  - a
    + b
  ```
  inserts `b` as a child of `a` with no `before:after` edge.
- A positive node as a *sibling* of its match also asserts
  `before:after(matchId, newId)`. Example:
  ```
  - a
  + b
  ```
  inserts `b` after `a`. This matches the post-expansion form of
  ```
  - r
    + a
    + b
  ```
  where `b` naturally sequences after `a`.

So the "previous" node for `before:after` is the pattern node at the
same indentation level immediately above the positive node, if any — no
new syntax required.

## Integrity check

`refstore.ts:checkIntegrity` currently enforces path uniqueness,
well-formedness, parent presence, sibling contiguity, `parentOf`
consistency, and symbol index consistency. Under the new model:

- Drop **path uniqueness**, **sibling contiguity**, and the
  path-derived parts of parent presence.
- Add **DAG acyclicity** on the `parent:child` closure (partial-order
  invariant called out in the overview).
- Add **before-after acyclicity** on the closure of `before:after`
  lifted through containment (otherwise `before` is not a partial
  order).
- Keep symbol index and node-set consistency.

Acyclicity is O(nodes + edges); still linear in the store size per
check, so cheap to call from tests and optionally at fixpoint boundaries
under a debug flag.

## Aggregate interaction

`aggregate-fold.ts` uses `isTemporallyBefore` in two places:

1. `sortBindings` orders `agg-binding` rows for deterministic folding.
   Becomes a topological sort of the bindings under `before`.
   Incomparable bindings are resolved by a new per-aggregator
   `commutative: boolean` flag: commutative operators (sum, count, set
   union) fold incomparable bindings in arbitrary order; non-commutative
   operators (last, list, string-concat) raise a runtime error —
   replacing today's "cannot order agg-bindings: paths are incomparable"
   exception. `getAggregator` in `ts/src/aggregators.ts` is the natural
   place to carry the flag.

2. `selectEarliestTier` picks the earliest paused `agg-instance`
   together with everything temporally incomparable to it. Uses
   `prior` (= `before ∪ contains⁻¹`) rather than `before`: an
   `agg-instance` nested inside another paused instance must be
   closed first so the outer fold sees its `agg-result`, and
   `contains⁻¹` is what captures that dependency.

Nothing in aggregates depends on paths structurally — only on the
ordering relation — so porting is mechanical once `before` is
available.

## Expand / parser impact

The `,` literal needs:
- a token in the parser (`,` as a line-leading marker, alongside `+`, `-`,
  `<`, `#`);
- a new `LiteralType` constructor `Overlap`;
- `isPositive` → false (it's a matching/negative literal like Match and
  Before);
- expand behaviour: `,` nodes participate in rule expansion the same way
  Match/Before do — they bind variables without producing output.

`,` is a negative literal and shares the full Match/Before treatment in
the expander. In particular, `generateDeltaVariants` (see
`ts/src/expand.ts`) must enumerate delta variants over every `,` node
alongside every `-` and `<` node — semi-naive evaluation depends on
delta-expanding each negative literal in turn, and omitting `,` from
that enumeration would silently miss derivations whose novelty lives on
the `,`-matched node.

### Parser and initial trees

The parser does not change. User source never mentions `parent:child`
or `before:after` directly, and the parser continues to produce nested
`Tree` values with `literalType ∈ {Match, Assert, Before, Overlap, …}`
and a `children[]` array that records source nesting.

All emission of the two new relations happens downstream:

- **From `expand.ts` + `step.ts` at run time.** A rule like
  ```
  + root
    + a
    + b
  ```
  expands today into three rules:
  ```
  + root

  - root
    + a

  - root
    - a
    + b
  ```
  The third rule's `+ b` is a sibling of `- a` at the same indent
  level, which (per "Step.ts impact") means insertion emits
  `parent:child(root, b)` *and* `before:after(a, b)`. Every temporal
  edge a program observes is produced this way; nothing about the
  expansion rules themselves needs to change.
- **From `buildRefStore` on a pre-populated initial `Tree`.** When
  tests or embedders hand `fixpoint` a non-empty initial tree,
  `buildRefStore` emits the same edges an expanded rule would have
  emitted: `parent:child(parent, child)` per nesting step, and
  `before:after(siblingN, siblingN+1)` between lexically consecutive
  children. This keeps the "read top-to-bottom" intuition for hand-
  built fixtures without giving the surface language any new syntax.

`before:after` and `parent:child` as *source-writable* relations require
the parser to accept them as ordinary atoms (they already do — they're
just symbols), plus some way for a rule author to *assert* them. This
is the spot where the insertion syntax mentioned in "Step.ts impact"
has to be designed.

## Migration shape

The change is large enough to want a staged rollout rather than a big-
bang swap:

1. **Add the relations behind the scenes.** `buildRefStore` populates
   `parent:child` from the nested-children layout and `before:after`
   from sibling order. All structural checks switch to querying the
   relations (via the derived helpers), but the observable input/output
   is unchanged. `path` remains on `NodeRow` during this stage only to
   keep the diff small; it is no longer consulted by any structural
   predicate.
2. **Add the `,` literal.** New literal type, parser entry, `overlap`
   check wired into `matchSubtree`. Still relying on inferred
   `before:after`/`parent:child` from the default layout.
3. **Open up insertion.** `step.ts` emits `before:after(prevImage,
   newId)` edges directly when the positive's pattern-preceding sibling
   binds an id (the "positive as sibling of match" case). The implicit
   "append after last existing sibling" edge in `insertChild` is kept as
   a default for linear-timeline inserts — duplicates collapse in the
   Set — and is dropped in stage 4.
4. **Drop the inferred defaults and the `path` column.** `NodeRow.path`
   is removed; `children` becomes a pure iteration index with no
   semantic content; integrity check loses sibling contiguity / path
   uniqueness and gains `parent:child` and `before:after` acyclicity.
   The auto-emitted `before:after(lastSibling, new)` edge in
   `insertChild` stays as a transitional bridge; removing it depends on
   designing the explicit-predecessor rule syntax that §Step.ts calls
   out (aggregate folding currently relies on the inferred edge to
   connect newly inserted `agg-instance` nodes to the existing timeline).

Steps 1–2 can land without breaking any existing program — every test
currently passes because the inferred relations agree with the old
path-based checks. Steps 3–4 are the ones that change the surface
language.

## Files to change

Not exhaustive — these are the load-bearing ones.

1. `ts/src/types.ts` — `LiteralType` gets an `Overlap` constructor.
2. `ts/src/refstore.ts` — add `parentChild` and `beforeAfter` relations
   (with their inverse maps) to `RefStore`; remove or demote `path` and
   `parentOf`.
3. `ts/src/tree.ts` — replace `isTemporallyBefore` and
   `isStrictDescendant` with `before` and `contains` queries over the
   new relations; add `overlap`.
4. `ts/src/unify.ts` — three call-site migrations (descent, Before
   anchor, overlap dispatch for `,`).
5. `ts/src/step.ts` — emit `parent:child` / `before:after` edges on
   insert; stop computing `path`.
6. `ts/src/aggregate-fold.ts` — `sortBindings` and
   `selectEarliestTier` use `before`.
7. `ts/src/parse.ts` + `ts/src/expand.ts` — `,` marker, Overlap
   literal type handling.
8. Test suite — `tree.test.ts` and the structural bits of
   `unify.test.ts` need cases for multi-parent nodes, incomparable
   siblings, and `,`-literal matching.

## `before` vs `prior`

Two sites need temporal ordering, and they pick different relations:

- **Sibling ordering at match time (unify.ts) uses `before`.** Strict
  temporal precedence, excluding ancestors. A sibling Match pattern's
  candidate must be genuinely before the anchor, not merely "anything
  the anchor is contained in".
- **Aggregate scheduling (`aggregate-fold.ts:selectEarliestTier`) uses
  `prior`.** The fold pass must close inner `agg-instance`s before
  outer ones so the outer fold can observe the inner's `agg-result`.
  That dependency is exactly `contains⁻¹`, which `prior` adds on top of
  `before`.

## Open questions

- **Perf on real programs.** `contains` memoisation is the first thing
  to try; if it's hot, materialise. This shouldn't gate the plan — just
  flag that `path`-prefix was free and the replacement isn't.

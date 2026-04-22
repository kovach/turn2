# Relational storage — feasibility overview

Proposal (from notes/overview.md §"relational storage"):
- Reference tree is stored as a flat set of node tuples.
- Parent relationships are explicit `(parent:child A B)` facts.
- Sibling order is explicit `(before:after A B)` facts.
- Structural predicates used inside `unify` collapse into lookups against this fact store.

This plan refines the proposal: once every node carries its `path` (array of
child-indices from root), both parent and sibling order are recoverable from
paths alone, so we omit explicit `parent` / `next` relations and rely on
`path` as the single structural column.

## What unify actually needs from the tree

Reading `ts/src/unify.ts` and `ts/src/tree.ts`, the only ways the unifier touches
structure are:

1. **Enumerate candidate nodes**
   - symbol-headed pattern: `SymbolIndex.get(name)` → `Candidate[]`
   - otherwise: `walkAllCandidates(root, [])` pre-order
2. **Descendant check** `isStrictDescendant(prevDeepest, path)`
   (`matchSubtree` at unify.ts:332)
3. **Temporal-before check** `isTemporallyBefore(aPath, anchor)` for `<` nodes
   (matchSubtree at unify.ts:330, implemented via lex-compare on paths in
   `tree.ts:65`)
4. **Path/id navigation** `findPath(id, root)` and `nodeAt(root, path)` — used by
   `computeAnchor` (Before) and by `step.ts:47,56`
5. **Constraint filter** `passesConstraint(node, constraint, iteration)` —
   reads `node.gen`; orthogonal to structure
6. **Mutation** `indexedInsertAt(itree, parentPath, child)` (unify.ts:180) —
   appends a child and extends the symbol index

Everything else (`unifyTerms`, `unifyAtoms`, `unifyNode`, trail) is purely
term-level and unaffected.

## Mapping each operation to a relational store

Let the store carry, per node `N`:
- `node(N, literalType, atom, path, gen)` — the node tuple itself. `path` is
  the sequence of child-indices from root as a `number[]`; `path(root) = []`.
  `gen` is written once at insertion and never updated.
- symbol index: `firstSym(N, s)` for symbol-headed atoms (already exists in
  another form).

Parent, sibling order, and ancestor are *not* separate relations — all three
are derivable from `path`:
- parent of `C`: the unique row whose `path == C.path.slice(0, -1)`; absent
  for root.
- A precedes B as a sibling: `A.path.slice(0, -1) === B.path.slice(0, -1)`
  (same parent) and `A.path` < `B.path` lex.
- proper ancestor of `D`: rows whose `path` is a strict prefix of `D.path`.

Then:

| unify need                      | relational form                                       | cost                                       |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| enumerate symbol-headed         | scan `firstSym(?, s)` index                           | same as today                              |
| enumerate all                   | scan `node(?, _, _, _, _)`                            | same O(n)                                  |
| `isStrictDescendant(dp, n)`     | `dp.path` is a strict prefix of `n.path`              | O(depth), same as today's path prefix      |
| `isTemporallyBefore(a, b)`      | lex-compare `a.path` vs `b.path`                      | O(depth), same as today's path lex-compare |
| `findPath(id, root)`            | not needed — `path` is carried on the node itself     | — removed                                  |
| `nodeAt(root, path)`            | not needed                                            | — removed                                  |
| insert child at parent `P`      | `child.path = P.path ++ [P.childCount]`; write `node` | O(depth) for the path array                |

Iteration order over candidate sets is not assumed anywhere: the descendant
and before filters apply per candidate, so any scan order is acceptable.

Several things actively *simplify*:
- `findPath` / `nodeAt` disappear. `path` travels with the node on the tuple,
  so code that needs "this node's path" just reads it off the row instead of
  walking the tree from the root.
- `computeAnchor` in unify.ts:291 currently calls `findPath` on a bound id; in
  the relational form it looks up the node by id and reads `node.path`.

## Where the cost trade-off actually lives

The existing path-based representation is unusually cheap at two specific
checks:

- `isTemporallyBefore`: a 4-line lexicographic compare on two `number[]`s
  (`tree.ts:65`).
- `isStrictDescendant`: array prefix check, inlined in unify.ts:210.

Storing the path as a `path: number[]` field on each node tuple preserves
both costs exactly. A global integer counter assigned at insertion *does not*
work: pre-order interleaves subtree expansion with sibling lists, so a node
inserted later (larger counter) can be pre-order-before an earlier one.
Concretely, after inserting A under root, B under A, C under root, D under A,
pre-order is `root A B D C` but the counter gives `A=1 B=2 C=3 D=4`. Only a
position-valued key — the path itself — gives an ordering that agrees with
pre-order under arbitrary insertion interleavings.

So `path` is promoted from a value carried alongside each candidate to a
column on the node tuple. Net changes vs today:
- `isTemporallyBefore` and `isStrictDescendant` stay as lex-compare /
  prefix-check on arrays. Same cost, same code.
- Code that used to compute a path on demand (`findPath`) now reads
  `node.path` directly. Strictly cheaper.
- Insertion writes one extra column (`path = parent.path ++
  [parent.childCount]`) — already O(depth), same as allocating a
  `[...parentPath, i]` array today in `buildIndexedTree` (unify.ts:170) and
  `indexedInsertAt` (unify.ts:183).

`P.childCount` at insertion is recoverable from the node relation (count rows
whose path-prefix is `P.path` and whose path length is `P.path.length + 1`),
but in practice an implementation will cache it — a `Map<Id, number>` updated
on each insert, kept as auxiliary state of the store rather than a logical
relation.

## Ids and keying

Every row in the `node` relation is keyed by a numeric id: the `Ref.id` field
of a hashconsed `Term`. The store requires that every node id and every atom
term appearing in the reference has already been lowered to a `Ref` via
`hashconsTerm` / `hashconsAtom` (ts/src/hashcons.ts) before reaching it — the
store itself never re-hashconses. All auxiliary structures (`SymbolIndex`, the
`Map<Id, number>` childCount cache, any future `parent` or `ancestor`
materialization) share the same numeric key space.

`HashconsState` is threaded as an explicit parameter through `unify.ts` /
`tree.ts` (see `unifyTerms(..., hc)`, `termEq(..., hc)`, `SearchState.hc`);
there is no module-level hashcons state. The `RefStore` follows the same
convention — it does not hold a reference to an `HashconsState`. Callers that
perform cross-type `Atom`/`Ref` comparisons against store rows pass `hc`
through to the helpers that need it, exactly as `unifyTree` does today.

The `Variable("0")` root produced by `types.ts:104` belongs to the *pattern*
side; patterns and reference trees share the `Tree` type today, which is a
source of confusion. The reference root inside `RefStore` is a single
canonical hashconsed id allocated at store creation, with `path = []` and no
parent.

## Mutation-during-iteration invariant

`walkAllCandidates` (unify.ts:203) is safe today because freshly inserted
nodes carry `gen === iteration` and `passesConstraint` rejects them
(`gen < iteration` for "any", etc.). The same filter works unchanged under
relational storage: attach `gen` to the `node` tuple, filter on scan. No
special snapshotting needed.

## Integration shape

The reference store is reified as a flat tuple set. The current `Tree` object
with nested `children[]` goes away; its contents become rows in the `node`
relation. Concretely:

1. Drop `Tree.children` from the reference representation. Represent the
   reference as a `RefStore` carrying: a `node` set keyed by id (literal,
   atom, `path: number[]`, `gen`), plus the existing `SymbolIndex` keyed on
   first-atom symbol. `path(root) = []`.
2. Keep the `Candidate { path, node }` shape so current consumers in
   `matchSubtree` and `matchChildrenFrom` don't change. The `node` field
   becomes the node row (with `children` gone), and `path` is populated from
   `node.path` — technically redundant with `node.path`, but preserving the
   interface avoids touching the hot-path loops. Rewrite
   `isStrictDescendant(prevDeepest, path)` as "`prevDeepest.path` is a strict
   prefix of `n.path`" and `isTemporallyBefore(path, anchor)` as lex-compare
   on `path`. Both are the same operations on the same data that `tree.ts`
   currently performs; only the carrier moves.
3. Drop `findPath` / `nodeAt` from step.ts. The parent id of the reference
   insertion point is looked up directly via `substTerm` on the pattern
   parent's id — no path recovery needed. Insertion: write the new `node` row
   with `path = P.path ++ [P.childCount]` and extend the symbol index.
4. Later: if the engine ever needs to *match* structural facts from inside a
   rule (e.g. a pattern referencing `parent X Y`), derive the parent
   relationship from paths on demand or materialize an explicit `parent`
   relation at that point.

The test surface is small — `tree.test.ts`, `unify.test.ts`, `expand.test.ts`,
`fixpoint.test.ts` — so regressions should be easy to catch. Several helpers
in `tree.ts` (`findPath`, `nodeAt`, `nodesBefore`, `insertAt`) disappear;
`isTemporallyBefore` moves to operate on `path` fields of node rows but keeps
its implementation.

## Interaction with aggregates

Aggregates (`plans/aggregates.md`, `ts/src/aggregate-fold.ts`) lower `#` nodes
into three ordinary rules using reserved predicates (`agg-instance`,
`agg-binding`, `agg-result`), plus a post-fixpoint fold pass. The fold pass is
the only aggregate-specific code that touches tree structure directly. It uses
paths at three points:

- `collectAggNodes` (aggregate-fold.ts:34) does a full pre-order walk, tagging
  every found node with its `path: number[]` and its parent path.
- `sortBindings` (aggregate-fold.ts:95) orders bindings via
  `isTemporallyBefore(a.path, b.path)`, throwing if a pair is incomparable.
- `selectEarliestTier` (aggregate-fold.ts:105) uses the same path comparison
  to pick the earliest paused instance plus anything temporally incomparable
  to it.
- Result insertion uses `instance.parentPath` to place `agg-result` as a
  sibling of `agg-instance` via `indexedInsertAt`.

Under the relational storage proposal each of these simplifies, and in one
case gets slightly *more* expressive:

1. **Collection.** The walk becomes a scan over the node tuple set, filtered
   on the first atom symbol. The existing `SymbolIndex` already buckets by
   first symbol, so `collectAggNodes` iterates three small buckets
   (`agg-instance`, `agg-binding`, `agg-result`) instead of traversing the
   whole tree.

2. **Binding sort.** Unchanged in form — still `isTemporallyBefore` lex-compare
   on `path` — but `path` is read off the node row instead of being tracked
   alongside it. The "incomparable" case (one `path` is a prefix of the
   other) is unchanged.

3. **Earliest-tier selection.** Same mechanics: lex-compare on `path`, with
   "incomparable" still meaning prefix-related. No change in semantics.

4. **Result insertion.** `instance.parentPath` becomes
   `instance.path.slice(0, -1)`. `indexedInsertAt(ref, parentPath, node)` is
   replaced by the `RefStore` insertion helper used by `step.ts`, so there is
   a single insertion path rather than two.

Two points worth flagging:

- **The lexId trick in aggregate-fold.ts:140 is unaffected.** Looking up the
  aggregator by parsing `lexId` as `agg_<funcName>_N` is term-level and
  structure-agnostic.
- **Nested `#` across rules still works the same way.** Aggregates don't
  depend on the storage representation for correctness — only for ordering
  and placement. Once `path` is on the node row, the post-fixpoint pass
  could arguably be rewritten as a relational rule itself (scan
  `agg-instance`, anti-join against `agg-result` to find paused, group
  `agg-binding` by `(lexId, Id)` ordered by `path`, fold, insert). That is a
  natural follow-on if/when the engine gets first-class ordered aggregation,
  but is not required for the storage change.

There is no *negative* interaction: no aggregate feature depends on paths in
a way that relational storage would break.

## Integrity check

Since `path` is the sole structural column and every other structural
relation is derived from it, we want a cheap sanity check to catch
corruptions early. Add a `checkIntegrity(store: RefStore): void` function
that verifies:

1. **Path uniqueness.** No two rows in the `node` relation share the same
   `path` value. A violation means two nodes were assigned the same position
   — e.g. a `childCount` cache drift or a double insert — which breaks every
   downstream use of `path`.
2. **Path well-formedness.** Every non-root row's `path` is a non-empty
   `number[]`; the root's path is `[]`; every entry is a non-negative
   integer.
3. **Parent presence.** For every non-root row with `path = p`, there is a
   row with `path = p.slice(0, -1)`. This catches "floating" nodes whose
   ancestor chain was never materialized.
4. **Sibling contiguity.** For each parent path `p`, the children's last
   indices form a contiguous `0..k-1` prefix. Catches gaps from deletes or
   out-of-order inserts.
5. **Symbol index consistency.** Every entry in `SymbolIndex` points to a
   row currently in the `node` relation, and every symbol-headed row appears
   in the appropriate bucket.

Path uniqueness (1) is the minimum; the others are cheap add-ons that catch
related bugs. `checkIntegrity` runs in O(n) over the node set and is called
from tests and optionally from fixpoint at iteration boundaries under a
debug flag.

## Verdict

**Feasible, essentially cost-neutral on the hot path.** The existing code
already treats nodes as records keyed by id; paths are a positional shadow of
that identity. Moving `path` onto the node row and reifying the tree as a
flat `node` relation:

- *wins:* uniform substrate, eliminates `findPath` / `nodeAt`, prepares
  ground for in-rule structural introspection, single insertion path shared
  by `step.ts` and the aggregate fold pass.
- *costs:* none on the hot path. `isTemporallyBefore` and `isStrictDescendant`
  stay as lex-compare / prefix-check on the same `number[]` data — just
  sourced from `node.path` instead of a separately-carried argument.

Recommended order: introduce a `RefStore` whose only logical relation is
`node` (with `path` as a column), drop `Tree.children` from the reference
representation, migrate unify's structural checks to read `path` off node
rows, and only then consider materializing `parent` / `ancestor` as
rule-accessible facts if the engine grows a need for them.

## Divergences during implementation

Notes on where the landed code differs from the plan above.

- **`parentOf: Map<NodeId, NodeId>` added.** The plan only called out a
  `Map<Id, number>` childCount cache. Implementation carries an explicit
  parent pointer per node, giving O(1) `parentIdOf` (consumed by
  `aggregate-fold.ts` when inserting `agg-result` as a sibling of
  `agg-instance`) and subsuming child counting via
  `children.get(key).length`.
- **`children: Map<NodeId, NodeRow[]>` cache added.** The plan derived
  children by scanning rows whose path is a length+1 extension of the
  parent. The implementation caches ordered child lists keyed by parent
  token because `refStoreToTree` — the bridge back to nested `Tree` for the
  web UI and existing tests — would otherwise rescan the full node set per
  parent.
- **`span?: Span` on `NodeRow`.** Not in the plan (it listed
  `literalType, atom, path, gen`). Added after `fixpoint.test.ts`
  `deepEqual(result, ref)` failed on roundtrip — parse-produced initial
  trees carry `span`, so the store must preserve it for the Tree bridge to
  be lossless.
- **Integrity check has six invariants, not five.** The plan specified
  path uniqueness, well-formedness, parent presence, sibling contiguity,
  and symbol index consistency. Implementation adds a sixth: `parentOf`
  consistency (every non-root row has a `parentOf` entry that points to the
  row whose path is this row's path minus the last index). The extra check
  exists because `parentOf` itself is a new cache.
- **`step.ts` hashconses `parentRefId` before `hasNode`.** The plan stated
  "the store itself never re-hashconses" and assumed parent ids arrive
  already hashconsed. In practice `substTerm(posParent.id, trail)` can
  yield a raw `Atom` when a pattern variable binds an atom, so `step.ts`
  calls `hashconsTerm` before the lookup. The invariant still holds on the
  store boundary — the hashconsing happens in the caller.
- **Token space is wider than `Ref.id`.** The plan said rows are "keyed by
  a numeric id: the `Ref.id` field of a hashconsed `Term`." The
  implementation keys by `tokenOfId`, which assigns disjoint integer
  ranges per tag (Ref → +N, Wildcard → 0, Symbol → odd negatives, Variable
  → even negatives). This is what lets non-Ref ids — e.g. the
  `Variable("0")` or `Symbol("root")` carried on pattern / initial-tree
  roots — live in the same `nodes` map without colliding with Ref ids.

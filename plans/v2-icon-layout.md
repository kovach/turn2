# Plan: extending `icon` with layout constraints

Adds two relations, `left:right I1 I2` and `above:below I1 I2`, that let a
program express relative visual arrangement of icons in the bundled default
display (`ts/src/v2/default-display.ts`). Icons are packed into a CSS grid
that satisfies every applicable constraint; with no constraints the rendering
is byte-for-byte what it is today (one wrapping flex row per container).

## Relations

```
left:right A B    -- A is placed strictly left of B
above:below A B   -- A is placed strictly above B
```

Both are arity-2, plain (non-aggregated) relations, read as raw rows like
`icon` — no `#agg` handling, since these are constraints and multiple
contributions are meant to accumulate rather than collapse. Stored tuple shape
is `[head, A, B, id]` (length 4), the same as `icon:name` / `at`. Rows are
filtered to those whose interval contains the render moment `M`
(`renderMoment`), exactly like `icon` / `icon:name` / `at`.

Colon-containing heads already work (`icon:name`), and `candidatesByHead` needs
no registration, so no parser or store changes are required.

### Scope rule (which constraints apply)

A constraint is honored only between **siblings**: `left:right A B` applies iff
`A` and `B` are both icons and both are children of the same container. Per the
task note, this is the `at A -> Z` / `at B -> Z` case.

**Assumption (extension of the note):** the set of icons with no `at` parent —
today's top-level row — is treated as a container too (a pseudo-parent
`ROOT_KEY = -1`). Without this, a program with no `at` rows at all could not use
layout, which would make the feature unusable for flat programs. Same-parent
semantics are otherwise unchanged.

An icon with several parents is rendered once per parent (existing behavior);
constraint scoping is evaluated independently inside each container, so the same
icon can be laid out differently under different parents.

Constraints whose endpoints are not icons, or are not siblings, or are
self-edges (`left:right A A`) are ignored and counted for a warning line.

## Placement algorithm

Per container, over its member icons:

1. Collect the applicable `left:right` edges into a horizontal DAG `H` and the
   `above:below` edges into a vertical DAG `V`.
2. **Cycle check** per relation, independently (DFS gray/black, mirroring
   `buildIconTree`). If `H` has a cycle, drop *all* of `H`'s edges for that
   container and set a warning flag; likewise for `V`. Dropping one does not
   affect the other.
3. `col(x)` = longest-path depth of `x` in `H` (0 for sources); `row(x)` =
   longest-path depth in `V`. Longest-path layering guarantees
   `col(A) < col(B)` for every edge `A left:right B`, so every surviving
   constraint is satisfied, and it packs everything as far up/left as possible.
   O(V+E) via memoized DFS on the acyclic graph.
4. Grid is `maxRow+1` × `maxCol+1`. Icons sharing a cell are unrelated by any
   constraint (equal depth in both graphs ⇒ no edge between them), so they are
   rendered side by side in one wrapping cell in collection order.

Consequences worth noting:

- No constraints at all → every icon lands at `(0,0)` → a single wrapping cell,
  i.e. exactly today's row. The implementation short-circuits this case and
  emits the current `.dd-icon-children` / `.dd-icons` flex markup unchanged, so
  the no-constraint path has zero regression risk.
- An icon constrained only horizontally sits in row 0; only vertically, in
  column 0. That is the intended "respect what was asked, default the rest".
- Contradictory pairs (`left:right A B` and `left:right B A`) surface as a
  2-cycle and disable horizontal layout for that container, with a warning.

## Code

### New: `ts/src/v2/icon-layout.ts`

DOM-free and store-free so it is unit-testable headless (same posture as
`timeline.ts` vs. its renderer). Keys are `tokenOf` term keys (`number`).

```ts
export interface LayoutEdge { from: number; to: number }
export interface IconPlacement { key: number; row: number; col: number }
export interface IconLayout {
  placements: IconPlacement[];   // one per member, collection order preserved
  rows: number; cols: number;
  hCycle: boolean; vCycle: boolean;
}
export function layoutIcons(
  members: readonly number[],
  horizontal: readonly LayoutEdge[],  // from is left of to
  vertical: readonly LayoutEdge[],    // from is above to
): IconLayout;
```

Also exported for reuse/testing:
`export function longestPathDepths(members, edges): { depth: Map<number, number>; cycle: boolean }`.

`layoutIcons` filters edges to member-internal, non-self edges itself, so
callers may pass a superset.

### Modified: `ts/src/v2/default-display.ts`

- `collectConstraints(store, M, iconKeys)` — one pass each over
  `candidatesByHead(store, "left:right")` and `"above:below"`; interval-filter;
  map endpoints through `tokenOf`; keep only rows where both endpoints are in
  `iconKeys`; return `{ horizontal, vertical, ignored }` where `ignored` counts
  dropped rows (non-icon endpoints).
- `renderInner` — after `buildIconTree`, compute a `parentKeyOf` grouping:
  `roots` under `ROOT_KEY`, and each `childrenOf` entry under its parent key.
  For each container, partition the constraint lists to sibling-internal edges
  (non-sibling edges add to the ignored count) and call `layoutIcons`.
- `renderIcon` / the top-level loop — where a container's layout is trivial
  (single cell) keep today's markup; otherwise build a grid container:
  `.dd-grid` with one `.dd-grid-cell` per non-empty cell, positioned with
  `style.gridRow = String(row+1)` / `style.gridColumn = String(col+1)`. Icon
  divs themselves are unchanged, so click/hover/pending behavior, candidate
  highlighting and `commit` are untouched.
- Warnings (existing `.dd-warn` lines, one per condition):
  - `` warning: `left:right` cycle; horizontal layout ignored ``
  - `` warning: `above:below` cycle; vertical layout ignored ``
  - `` warning: N layout constraint(s) ignored (not siblings) ``
- CSS added to the module's `CSS` string:
  ```
  .dd-grid { display: grid; gap: 6px; grid-auto-columns: min-content; align-items: start; justify-items: start; }
  .dd-grid-cell { display: flex; flex-wrap: wrap; gap: 6px; }
  ```
  No `index-v2.html` change — the module injects its own styles via
  `addStyles`.

### New test: `ts/src/tests/v2_icon_layout.test.ts`

Pure-function tests against `layoutIcons` (no DOM, matching
`v2_timeline_layout.test.ts` style):

1. no edges → all placements `(0,0)`, `rows === 1`, `cols === 1`
2. chain `a<b<c` horizontally → cols `0,1,2`, all row 0
3. 2×2: `a left b`, `c left d`, `a above c`, `b above d` → the four corners
4. diamond / shared depth: `a left b`, `a left c` → `b` and `c` both col 1
5. cycle `a left b`, `b left a` → `hCycle`, all cols 0, vertical still applied
6. self-edge and edges referencing non-members are dropped without a cycle
7. every surviving edge is satisfied (generic assertion helper reused across
   cases)

Plus one end-to-end-ish check in the same file: parse a small program with
`icon` / `at` / `left:right` rows, run `runFixpoint`, and assert
`collectConstraints`-level sibling filtering drops a cross-parent constraint
(export `collectConstraints` for this, or lift the sibling filter into
`icon-layout.ts` as `siblingEdges(edges, memberSet)` and test that instead —
prefer the latter, it keeps the store out of the test).

### Demo

Extend `ts/data/v2/demo.t` (the `setup` block already asserts `icon hand`,
`icon c`, `icon board`) with e.g.

```
setup
  +left:right hand board
  +above:below hand c
```

for a manual check in the playground.

## Docs

- Update `ts/src/v2/overview.md`, `# default-display.ts` section: mention
  `left:right` / `above:below` in the prose, add key terms for
  `layoutIcons` / grid packing, and add a `# icon-layout.ts` section for the
  new module (it is a new file, so overview.md must gain an entry).
- Replace `plan: TODO` under `# extending icon` in `notes/overview.md` with
  `plan: plans/v2-icon-layout.md`.

## Risks / edge cases

- **Cell collisions across containers** — grid state is per container; nested
  containers each get their own grid, so no coordinate leakage.
- **Icon rendered under multiple parents** — layout computed per container;
  the same `termKey` may get different `(row, col)` in each. Intentional.
- **Interaction with `at` cycles** — if `buildIconTree` reports a cycle it
  flattens all parents to top level; layout then runs over that single root
  container, which is consistent (everything really is a sibling then).
- **Large grids** — `grid-auto-columns: min-content` keeps empty columns
  zero-width, so a sparse chain does not blow out the panel.

---

Written by Claude Opus 5 (claude-opus-5[1m]).

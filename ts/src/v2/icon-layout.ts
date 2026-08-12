// Grid packing for the default display's icon containers.
//
// A program may constrain the relative arrangement of icons that share a
// parent with `left:right A B` (A strictly left of B) and `above:below A B`
// (A strictly above B). This module turns those constraints, for one
// container's worth of sibling icons, into (row, col) placements.
//
// Placement is longest-path layering: an icon's column is its depth in the
// `left:right` DAG and its row is its depth in the `above:below` DAG. Every
// edge implies depth(from) < depth(to), so every surviving constraint is
// satisfied, and everything packs as far up-and-left as it can. The two axes
// are independent: a cycle on one drops only that axis's edges.
//
// Store-free and DOM-free so it can be tested headless; keys are `tokenOf`
// term keys. See plans/v2-icon-layout.md.

export interface LayoutEdge {
  from: number;
  to: number;
}

export interface IconPlacement {
  key: number;
  row: number;
  col: number;
}

export interface IconLayout {
  // One entry per member, in the order members were given.
  placements: IconPlacement[];
  rows: number;
  cols: number;
  hCycle: boolean;
  vCycle: boolean;
}

// Edges usable within `members`: both endpoints present, no self-edges.
// Callers may pass a superset of the container's edges.
export function siblingEdges(
  edges: readonly LayoutEdge[],
  members: ReadonlySet<number>,
): LayoutEdge[] {
  return edges.filter(
    (e) => e.from !== e.to && members.has(e.from) && members.has(e.to),
  );
}

// Longest-path depth of each member over `edges` (depth 0 for sources).
// On a cycle, reports `cycle: true` and every depth 0 — the caller drops the
// axis rather than laying out a contradictory constraint set.
export function longestPathDepths(
  members: readonly number[],
  edges: readonly LayoutEdge[],
): { depth: Map<number, number>; cycle: boolean } {
  // depth(x) = 1 + max depth over x's predecessors, memoized. A GRAY hit is a
  // back-edge, i.e. a cycle.
  const pred = new Map<number, number[]>();
  for (const e of edges) {
    let arr = pred.get(e.to);
    if (arr === undefined) { arr = []; pred.set(e.to, arr); }
    arr.push(e.from);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();
  const depth = new Map<number, number>();
  let cycle = false;

  function visit(k: number): number {
    const c = color.get(k) ?? WHITE;
    if (c === GRAY) { cycle = true; return 0; }
    if (c === BLACK) return depth.get(k) ?? 0;
    color.set(k, GRAY);
    let d = 0;
    for (const p of pred.get(k) ?? []) {
      const pd = visit(p);
      if (pd + 1 > d) d = pd + 1;
    }
    color.set(k, BLACK);
    depth.set(k, d);
    return d;
  }

  // `siblingEdges` guarantees every endpoint is a member, so visiting the
  // members reaches every node.
  for (const m of members) visit(m);

  if (cycle) {
    const flat = new Map<number, number>();
    for (const m of members) flat.set(m, 0);
    return { depth: flat, cycle: true };
  }
  for (const m of members) if (!depth.has(m)) depth.set(m, 0);
  return { depth, cycle: false };
}

// Place `members` on a grid satisfying every applicable constraint.
export function layoutIcons(
  members: readonly number[],
  horizontal: readonly LayoutEdge[],
  vertical: readonly LayoutEdge[],
): IconLayout {
  const set = new Set(members);
  const h = siblingEdges(horizontal, set);
  const v = siblingEdges(vertical, set);

  const cols = longestPathDepths(members, h);
  const rows = longestPathDepths(members, v);

  const placements: IconPlacement[] = members.map((k) => ({
    key: k,
    row: rows.depth.get(k) ?? 0,
    col: cols.depth.get(k) ?? 0,
  }));

  let maxRow = 0, maxCol = 0;
  for (const p of placements) {
    if (p.row > maxRow) maxRow = p.row;
    if (p.col > maxCol) maxCol = p.col;
  }

  return {
    placements,
    rows: placements.length === 0 ? 0 : maxRow + 1,
    cols: placements.length === 0 ? 0 : maxCol + 1,
    hCycle: cols.cycle,
    vCycle: rows.cycle,
  };
}

// True when the layout is a single cell — the caller can then emit the plain
// wrapping-row markup instead of a grid.
export function isTrivialLayout(layout: IconLayout): boolean {
  return layout.rows <= 1 && layout.cols <= 1;
}

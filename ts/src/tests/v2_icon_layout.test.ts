// Grid packing for the default display's `left:right` / `above:below`
// constraints. Pure layout assertions — no DOM, no store.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { createDefaultDisplay } from "../v2/default-display.js";
import { renderTerm, tokensEq } from "../v2/print.js";
import type { Atom, Term } from "../v2/term.js";
import type { Store } from "../v2/store.js";
import {
  isTrivialLayout,
  layoutIcons,
  longestPathDepths,
  siblingEdges,
  type IconLayout,
  type LayoutEdge,
} from "../v2/icon-layout.js";

const a = 1, b = 2, c = 3, d = 4;

function cellOf(layout: IconLayout, key: number): { row: number; col: number } {
  const p = layout.placements.find((q) => q.key === key);
  assert.ok(p, `no placement for ${key}`);
  return { row: p.row, col: p.col };
}

// Every surviving edge must be strictly satisfied on its axis.
function assertSatisfied(
  layout: IconLayout,
  horizontal: LayoutEdge[],
  vertical: LayoutEdge[],
  msg: string,
): void {
  if (!layout.hCycle) {
    for (const e of horizontal) {
      if (e.from === e.to) continue;
      assert.ok(
        cellOf(layout, e.from).col < cellOf(layout, e.to).col,
        `${msg}: left:right ${e.from} ${e.to} violated`,
      );
    }
  }
  if (!layout.vCycle) {
    for (const e of vertical) {
      if (e.from === e.to) continue;
      assert.ok(
        cellOf(layout, e.from).row < cellOf(layout, e.to).row,
        `${msg}: above:below ${e.from} ${e.to} violated`,
      );
    }
  }
}

// 1. No constraints: one cell, i.e. today's plain wrapping row.
{
  const layout = layoutIcons([a, b, c], [], []);
  assert.equal(layout.rows, 1);
  assert.equal(layout.cols, 1);
  assert.ok(isTrivialLayout(layout), "unconstrained layout should be trivial");
  for (const p of layout.placements) {
    assert.deepEqual({ row: p.row, col: p.col }, { row: 0, col: 0 });
  }
  assert.deepEqual(layout.placements.map((p) => p.key), [a, b, c], "member order preserved");
}

// 2. Horizontal chain a < b < c.
{
  const h = [{ from: a, to: b }, { from: b, to: c }];
  const layout = layoutIcons([c, a, b], h, []);
  assert.equal(layout.cols, 3);
  assert.equal(layout.rows, 1);
  assert.equal(cellOf(layout, a).col, 0);
  assert.equal(cellOf(layout, b).col, 1);
  assert.equal(cellOf(layout, c).col, 2);
  for (const k of [a, b, c]) assert.equal(cellOf(layout, k).row, 0);
  assert.ok(!isTrivialLayout(layout));
  assertSatisfied(layout, h, [], "chain");
}

// 3. 2x2 grid.
{
  const h = [{ from: a, to: b }, { from: c, to: d }];
  const v = [{ from: a, to: c }, { from: b, to: d }];
  const layout = layoutIcons([a, b, c, d], h, v);
  assert.equal(layout.rows, 2);
  assert.equal(layout.cols, 2);
  assert.deepEqual(cellOf(layout, a), { row: 0, col: 0 });
  assert.deepEqual(cellOf(layout, b), { row: 0, col: 1 });
  assert.deepEqual(cellOf(layout, c), { row: 1, col: 0 });
  assert.deepEqual(cellOf(layout, d), { row: 1, col: 1 });
  assertSatisfied(layout, h, v, "2x2");
}

// 4. Shared depth: b and c both to the right of a, unrelated to each other,
//    so they land in the same cell and render side by side.
{
  const h = [{ from: a, to: b }, { from: a, to: c }];
  const layout = layoutIcons([a, b, c], h, []);
  assert.equal(layout.cols, 2);
  assert.equal(cellOf(layout, b).col, 1);
  assert.equal(cellOf(layout, c).col, 1);
  assert.deepEqual(cellOf(layout, b), cellOf(layout, c));
  assertSatisfied(layout, h, [], "shared depth");
}

// 5. Contradiction on one axis drops only that axis.
{
  const h = [{ from: a, to: b }, { from: b, to: a }];
  const v = [{ from: a, to: b }];
  const layout = layoutIcons([a, b], h, v);
  assert.equal(layout.hCycle, true, "a<b<a should be a horizontal cycle");
  assert.equal(layout.vCycle, false, "vertical axis unaffected");
  assert.equal(layout.cols, 1, "horizontal edges dropped");
  assert.equal(cellOf(layout, a).row, 0);
  assert.equal(cellOf(layout, b).row, 1, "vertical constraint still honored");
  assertSatisfied(layout, h, v, "one-axis cycle");
}

// 6. Longer cycle, and the depths reported flat.
{
  const { depth, cycle } = longestPathDepths(
    [a, b, c],
    [{ from: a, to: b }, { from: b, to: c }, { from: c, to: a }],
  );
  assert.equal(cycle, true);
  for (const k of [a, b, c]) assert.equal(depth.get(k), 0);
}

// 7. Self-edges and edges naming non-members are dropped, not cycles.
{
  const h: LayoutEdge[] = [
    { from: a, to: a },        // self
    { from: a, to: 99 },       // 99 is not an icon in this container
    { from: 99, to: b },
    { from: a, to: b },        // the only usable one
  ];
  assert.deepEqual(siblingEdges(h, new Set([a, b])), [{ from: a, to: b }]);
  const layout = layoutIcons([a, b], h, []);
  assert.equal(layout.hCycle, false, "a self-edge must not read as a cycle");
  assert.equal(cellOf(layout, a).col, 0);
  assert.equal(cellOf(layout, b).col, 1);
}

// 8. Transitive redundancy doesn't inflate the grid: a<b, b<c, a<c → 3 cols.
{
  const h = [{ from: a, to: b }, { from: b, to: c }, { from: a, to: c }];
  const layout = layoutIcons([a, b, c], h, []);
  assert.equal(layout.cols, 3);
  assertSatisfied(layout, h, [], "transitive");
}

// 9. Empty container.
{
  const layout = layoutIcons([], [{ from: a, to: b }], []);
  assert.deepEqual(layout.placements, []);
  assert.equal(layout.rows, 0);
  assert.equal(layout.cols, 0);
  assert.ok(isTrivialLayout(layout));
}

// 10. End-to-end through the display module: source → fixpoint → DOM. The
//     repo has no DOM harness, so we stub the handful of `document` bits
//     `createDefaultDisplay` touches.
{
  class El {
    className = "";
    textContent = "";
    style: Record<string, string> = {};
    children: El[] = [];
    classes = new Set<string>();
    classList = { add: (c: string) => { this.classes.add(c); }, remove: () => {} };
    appendChild(c: El): El { this.children.push(c); return c; }
    addEventListener(): void {}
    set innerHTML(_v: string) { this.children = []; }
    hasClass(c: string): boolean {
      return this.classes.has(c) || this.className.split(" ").includes(c);
    }
    find(cls: string): El[] {
      const out: El[] = this.hasClass(cls) ? [this] : [];
      for (const k of this.children) out.push(...k.find(cls));
      return out;
    }
    text(): string {
      return this.textContent || this.children.map((k) => k.text()).join("");
    }
  }
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (): El => new El(),
  };

  const SRC = `
~setup

setup
  +icon board
  +icon x
  +icon y
  +icon z
  +at x -> board
  +at y -> board
  +at z -> board
  +left:right x y
  +above:below x z
`;
  const parsed = parse(SRC);
  if ("message" in parsed) {
    throw new Error(`parse error line ${parsed.line}: ${parsed.message}`);
  }
  const { store, status } = runFixpoint(parsed, 200, 5000);
  assert.equal(status.kind, "done", `fixpoint did not finish: ${status.kind}`);

  const api = {
    addStyles: () => {},
    // Same one-level peek the host installs (web-v2.ts).
    peek: (t: Term, s: Store): Atom | null => {
      if (t.tag === "Ref") return s.hash.refToAtom.get(t.id) ?? null;
      if (t.tag === "Atom" || t.tag === "Id") return t.atom;
      return null;
    },
    renderTerm,
    tokensEq,
    commit: () => {},
  };
  const out = createDefaultDisplay(api)!.render(store, {
    components: [],
    schema: parsed.schema,
  });
  assert.ok(out, "display should render something");
  const root = out.element as unknown as El;

  // The top-level container holds one icon and no constraints — plain row.
  const rows = root.find("dd-icons");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hasClass("dd-grid"), false, "unconstrained container stays a flex row");

  // board's children are constrained — grid, with x/y/z in the right cells.
  const grids = root.find("dd-grid");
  assert.equal(grids.length, 1, "exactly one constrained container");
  const cellAt = new Map<string, string>();
  for (const cell of grids[0]!.find("dd-grid-cell")) {
    cellAt.set(`r${cell.style.gridRow}c${cell.style.gridColumn}`, cell.text());
  }
  assert.equal(cellAt.get("r1c1"), "x");
  assert.equal(cellAt.get("r1c2"), "y", "y sits to the right of x");
  assert.equal(cellAt.get("r2c1"), "z", "z sits below x");
  assert.equal(cellAt.size, 3);

  // No warnings: every constraint was usable.
  assert.deepEqual(root.find("dd-warn").map((w) => w.text()), []);
}

console.log("v2_icon_layout: ok");

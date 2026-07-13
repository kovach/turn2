// Timeline visualization of a v2 store. Lays moments out along a time axis
// according to the moment partial order, draws each episode (~) tuple as a
// labeled bar, each fact (+) tuple as a line + label, and connects moments
// by Hasse-edge arrows.
//
// Two orientations:
//  - horizontal: time → x (rightward); bars stack upward; fact labels drop
//    below the spine; fact lines are vertical.
//  - vertical:   time → y (downward); bars stack rightward (lane 0 nearest
//    to spine, growing rightward to show nesting); fact labels sit past
//    the rightmost bar lane; fact lines are horizontal across the bar
//    area.
//
// `is` rows and `constrain` (`!`) rows are pulled out to the sidebar.
// See plans/v2-timeline-view.md and plans/v2-timeline-orientation.md.

import type { Atom, Term } from "./term.js";
import type { Store } from "./store.js";
import { tokenOf } from "./store.js";
import { renderAtom, renderTerm, renderTermShallow } from "./print.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export type Orientation = "horizontal" | "vertical";
export type LaneMode = "compact" | "nested" | "tree";
// "spine": moments sit on the time axis at their longest-path rank (distinct
// incomparable moments can collapse to one x). "edges": each moment gets its
// own column via a linear extension of the moment order, its dot is drawn on
// the edge of one of its bars, and Hasse-cover arrows run dot to dot.
// Horizontal-only; vertical orientation ignores it. See
// plans/v2-timeline-edge-moments.md.
export type MomentStyle = "spine" | "edges";

// Font constants — used both for SVG <text> attributes and for
// canvas-based width measurement so the two cannot drift apart.
const FONT_FAMILY = "monospace";
const BAR_LABEL_PX = 11;
const FACT_LABEL_PX = 11;
const END_TICK_PX = 10;
// Horizontal step a pair-arrow tail takes off a bar's right edge before it
// turns vertical, so it clears the bar instead of running along its edge.
const PAIR_EXIT_STEP = 8;

export type Measurer = (text: string, fontPx: number) => number;

let _measureCtx: CanvasRenderingContext2D | null = null;
function defaultMeasurer(text: string, fontPx: number): number {
  if (_measureCtx === null) {
    _measureCtx = document.createElement("canvas").getContext("2d")!;
  }
  _measureCtx.font = `${fontPx}px ${FONT_FAMILY}`;
  return _measureCtx.measureText(text).width;
}

export interface TimelineOpts {
  hideInternal: boolean;
  orientation: Orientation;
  minColWidth: number;         // floor for per-rank-step width along the time axis
  minFracWidth: number;        // edges variant: floor for within-rank gaps
                               // (incomparable moments); much smaller than the step
  laneHeight: number;          // bar thickness in cross axis (horizontal) /
                               // bar width in cross axis (vertical)
  factLabelHeight: number;     // per-row gap on the fact stack
  factLabelMaxRows: number;
  barLabelMaxLen: number;
  margin: number;
  laneMode: LaneMode;
  momentStyle: MomentStyle;
}

export const DEFAULT_OPTS: TimelineOpts = {
  hideInternal: true,
  orientation: "horizontal",
  minColWidth: 32,
  minFracWidth: 12,
  laneHeight: 26,
  factLabelHeight: 16,
  factLabelMaxRows: 8,
  barLabelMaxLen: 28,
  margin: 16,
  laneMode: "tree",
  momentStyle: "spine",
};

interface MomentNode {
  tok: number;
  term: Term;
  rank: number;
}

interface Bar {
  tupleIndex: number;
  lTok: number;
  rTok: number;
  lane: number;
  label: string;
  full: string;
  // Index of this bar among all bars sharing its starting rank (lane order).
  // Used by the vertical projector to stagger label y-positions so labels
  // for bars that start at the same moment don't overlap.
  startGroupRow: number;
}

interface Fact {
  tupleIndex: number;
  lTok: number;
  row: number; // stack row at this moment
  label: string;
}

interface SidebarSection {
  heading: string;
  rows: { label: string; full: string }[];
}

export interface TimelineLayout {
  moments: Map<number, MomentNode>;
  bars: Bar[];
  facts: Fact[];
  edges: { from: number; to: number }[];
  laneCount: number;
  factRowCount: number;
  maxRank: number;
  // Max number of bars sharing a single starting rank — drives vertical
  // mode's per-rank-step sizing so stacked labels fit.
  maxStartGroupSize: number;
  // Per-rank-step widths in pixels; length === maxRank. Step r is the
  // gap between rank r and rank r+1. Sized to fit bar/fact label widths
  // measured via the canvas measurer.
  colWidths: number[];
  // Measured pixel widths of the "bot" / "top" tick labels — used by the
  // horizontal projector to push the timeline rightward so the labels
  // fit in the margins flanking the spine. 0 when unused (e.g. empty
  // store with maxRank < 1).
  botLabelWidth: number;
  topLabelWidth: number;
  sidebar: SidebarSection[];
  // --- edges-variant outputs (momentStyle "edges"; see MomentStyle) ---
  // Canonical anchor per displayed moment: the (bar, side) edge its dot
  // sits on, or null for spine placement (fact-only moments, bot, top).
  momentAnchor: Map<number, { barIndex: number; side: "l" | "r" } | null>;
  // Non-canonical bar edges sharing a moment — drawn as dashed vertical
  // ties from the bar edge to the canonical dot.
  momentTies: { tok: number; barIndex: number; side: "l" | "r" }[];
  // Hasse cover pairs to draw as dot-to-dot arrows, minus pairs already
  // implied by some bar's own (l, r) endpoints.
  orderPairs: { from: number; to: number }[];
}

// --- Classification ---

const SIDEBAR_HEADS = new Set(["is", "_constrain"]);
const INTERNAL_HEADS = new Set(["_choose", "_constrain", "_do-agg", "_agg-result", "_aggval"]);

function headSym(atom: Atom): string | null {
  const h = atom.terms[0];
  if (h !== undefined && h.tag === "Symbol") return h.name;
  return null;
}

function isInternalHead(name: string | null): boolean {
  if (name === null) return false;
  if (INTERNAL_HEADS.has(name)) return true;
  if (name.startsWith("_")) return true;
  return false;
}

// --- Layout (orientation-agnostic) ---

export function layoutTimeline(
  store: Store,
  opts: TimelineOpts,
  measure: Measurer = defaultMeasurer,
): TimelineLayout {
  const moments = new Map<number, MomentNode>();
  const sidebarTuples: { idx: number; head: string }[] = [];
  const mainTuples: number[] = [];

  for (let i = 0; i < store.tuples.length; i++) {
    const t = store.tuples[i]!;
    const head = headSym(t.atom);
    if (head !== null && SIDEBAR_HEADS.has(head)) {
      sidebarTuples.push({ idx: i, head });
      continue;
    }
    if (opts.hideInternal && isInternalHead(head)) continue;
    mainTuples.push(i);
    const lTok = tokenOf(store, t.l);
    const rTok = tokenOf(store, t.r);
    if (!moments.has(lTok)) moments.set(lTok, { tok: lTok, term: t.l, rank: 0 });
    if (!moments.has(rTok)) moments.set(rTok, { tok: rTok, term: t.r, rank: 0 });
  }
  if (!moments.has(store.botTok)) moments.set(store.botTok, { tok: store.botTok, term: store.bot, rank: 0 });
  if (!moments.has(store.topTok)) moments.set(store.topTok, { tok: store.topTok, term: store.top, rank: 0 });

  // Reachability over the FULL moment-order graph, projected onto displayed
  // moments. This catches transitive orderings through hidden (filtered)
  // moments — without it, two displayed moments connected only via hidden
  // intermediaries would land at the same rank, violating the visual
  // ordering invariant. bot/top are baked in: bot is below every other
  // displayed moment, top is above every other. (`store.orderFwd` itself
  // omits bot/top edges per `addOrder`'s contract.)
  const displayed = new Set(moments.keys());
  const botTok = store.botTok;
  const topTok = store.topTok;
  const gt = new Map<number, Set<number>>();
  for (const m of displayed) {
    const reach = new Set<number>();
    if (m === botTok) {
      for (const x of displayed) if (x !== botTok) reach.add(x);
    } else if (m !== topTok) {
      const seen = new Set<number>();
      const stack: number[] = [m];
      while (stack.length > 0) {
        const x = stack.pop()!;
        const succs = store.orderFwd.get(x);
        if (succs === undefined) continue;
        for (const y of succs) {
          if (seen.has(y)) continue;
          seen.add(y);
          if (displayed.has(y)) reach.add(y);
          stack.push(y);
        }
      }
      reach.add(topTok);
    }
    gt.set(m, reach);
  }

  // Hasse reduction over the displayed sub-poset: succ(m) = direct covers.
  // u → v iff v ∈ gt(u) and no w ∈ gt(u), w ≠ v has v ∈ gt(w).
  const succ = new Map<number, Set<number>>();
  for (const m of displayed) succ.set(m, new Set());
  for (const m of displayed) {
    const myGt = gt.get(m)!;
    for (const v of myGt) {
      let redundant = false;
      for (const w of myGt) {
        if (w === v) continue;
        if (gt.get(w)!.has(v)) { redundant = true; break; }
      }
      if (!redundant) succ.get(m)!.add(v);
    }
  }
  const incoming = new Map<number, Set<number>>();
  for (const m of displayed) incoming.set(m, new Set());
  for (const [from, tos] of succ) {
    for (const to of tos) incoming.get(to)!.add(from);
  }

  // Longest-path layering.
  const rank = new Map<number, number>();
  const indeg = new Map<number, number>();
  for (const [m, inc] of incoming) indeg.set(m, inc.size);
  const queue: number[] = [];
  for (const [m, d] of indeg) if (d === 0) { rank.set(m, 0); queue.push(m); }
  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++]!;
    const ru = rank.get(u)!;
    for (const v of succ.get(u)!) {
      const candidate = ru + 1;
      const rv = rank.get(v);
      if (rv === undefined || candidate > rv) rank.set(v, candidate);
      const left = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, left);
      if (left === 0) queue.push(v);
    }
  }
  for (const m of moments.keys()) if (!rank.has(m)) rank.set(m, 0);

  let maxRank = 0;
  for (const [m, r] of rank) {
    if (m === store.topTok) continue;
    if (r > maxRank) maxRank = r;
  }
  rank.set(store.topTok, maxRank + 1);
  maxRank += 1;

  // edges variant: give every moment its own column, but separate columns by
  // two tiers. The longest-path `rank` above is the "step" tier (comparable
  // moments always land on different ranks). We order moments by (rank, token)
  // — a valid linear extension that also keeps each rank's moments contiguous —
  // and overwrite `rank` with the column index. `colStepRank[col]` remembers
  // the original step-rank so the width pass can floor within-rank gaps to a
  // small fractional width and rank-boundary gaps to the full step. See
  // plans/v2-timeline-fractional-columns.md.
  let colStepRank: number[] | null = null;
  if (opts.momentStyle === "edges" && opts.orientation === "horizontal") {
    const stepRank = new Map(rank);
    const order = [...displayed].sort((a, b) => (stepRank.get(a)! - stepRank.get(b)!) || (a - b));
    colStepRank = order.map((u) => stepRank.get(u)!);
    order.forEach((u, col) => rank.set(u, col));
    maxRank = Math.max(0, order.length - 1);
  }

  for (const m of moments.values()) m.rank = rank.get(m.tok)!;

  // `succ` is already the Hasse cover relation; reuse for arrows.
  const edges: { from: number; to: number }[] = [];
  for (const [u, tos] of succ) for (const v of tos) edges.push({ from: u, to: v });

  // Classify main tuples into bars / facts.
  const rawBars: { tupleIndex: number; lTok: number; rTok: number; lRank: number; rRank: number; label: string; full: string }[] = [];
  const factsByMoment = new Map<number, { tupleIndex: number; label: string; full: string }[]>();

  for (const i of mainTuples) {
    const t = store.tuples[i]!;
    const lTok = tokenOf(store, t.l);
    const rTok = tokenOf(store, t.r);
    const full = renderAtom(store, t.atom);
    const label = truncate(full, opts.barLabelMaxLen);
    if (rTok === topTok) {
      let bucket = factsByMoment.get(lTok);
      if (bucket === undefined) { bucket = []; factsByMoment.set(lTok, bucket); }
      bucket.push({ tupleIndex: i, label, full });
    } else {
      const lRank = moments.get(lTok)!.rank;
      const rRank = moments.get(rTok)!.rank;
      rawBars.push({ tupleIndex: i, lTok, rTok, lRank, rRank, label, full });
    }
  }

  // For nested mode, containment uses the moment partial order (the
  // local `gt` reachability map above), not ranks: two moments may
  // share a rank without being comparable in the order.
  const leqTok = (a: number, b: number): boolean =>
    a === b || (gt.get(a)?.has(b) ?? false);
  const { bars, laneCount: packedLaneCount } =
    opts.laneMode === "nested" ? packBarsNested(rawBars, leqTok, store.botTok) :
    opts.laneMode === "tree"   ? packBarsTree(rawBars, leqTok, store.botTok) :
    packBarsCompact(rawBars);
  // Group bars by starting rank; assign each its row within the group
  // (lane-ordered). Track the largest group for downstream sizing.
  const byStartRank = new Map<number, PartialBar[]>();
  for (const b of bars) {
    let bucket = byStartRank.get(b.lRank);
    if (bucket === undefined) { bucket = []; byStartRank.set(b.lRank, bucket); }
    bucket.push(b);
  }
  let maxStartGroupSize = 0;
  for (const group of byStartRank.values()) {
    group.sort((a, b) => a.lane - b.lane);
    for (let i = 0; i < group.length; i++) group[i]!.startGroupRow = i;
    if (group.length > maxStartGroupSize) maxStartGroupSize = group.length;
  }

  // Stack facts by rank (collapsed columns get a single shared stack).
  const facts: Fact[] = [];
  let factRowCount = 0;
  const factsByRank = new Map<number, { lTok: number; tupleIndex: number; label: string; full: string }[]>();
  for (const [lTok, list] of factsByMoment) {
    const r = moments.get(lTok)!.rank;
    let bucket = factsByRank.get(r);
    if (bucket === undefined) { bucket = []; factsByRank.set(r, bucket); }
    for (const f of list) bucket.push({ lTok, tupleIndex: f.tupleIndex, label: f.label, full: f.full });
  }
  for (const list of factsByRank.values()) {
    list.sort((a, b) => (a.lTok - b.lTok) || (a.tupleIndex - b.tupleIndex));
    const cap = opts.factLabelMaxRows;
    const shown = list.slice(0, cap);
    for (let i = 0; i < shown.length; i++) {
      facts.push({ tupleIndex: shown[i]!.tupleIndex, lTok: shown[i]!.lTok, row: i, label: shown[i]!.label });
      if (i + 1 > factRowCount) factRowCount = i + 1;
    }
    if (list.length > cap) {
      const more = list.length - cap;
      facts.push({ tupleIndex: -1, lTok: shown[shown.length - 1]!.lTok, row: cap, label: `+${more} more` });
      if (cap + 1 > factRowCount) factRowCount = cap + 1;
    }
  }

  // Sidebar.
  const isRows: { label: string; full: string }[] = [];
  const constrainRows: { label: string; full: string }[] = [];
  for (const { idx, head } of sidebarTuples) {
    const t = store.tuples[idx]!;
    const full = renderAtom(store, t.atom);
    if (head === "is") {
      const choice = t.atom.terms[1];
      const value = t.atom.terms[2];
      if (choice !== undefined && value !== undefined) {
        isRows.push({
          label: `${renderTerm(store, choice)} ↦ ${renderTerm(store, value)}`,
          full,
        });
      } else {
        isRows.push({ label: full, full });
      }
    } else {
      constrainRows.push({ label: full, full });
    }
  }
  isRows.sort((a, b) => a.label.localeCompare(b.label));
  constrainRows.sort((a, b) => a.label.localeCompare(b.label));
  const sidebar: SidebarSection[] = [];
  if (isRows.length > 0) sidebar.push({ heading: `is (${isRows.length})`, rows: isRows });
  if (constrainRows.length > 0) sidebar.push({ heading: `! / constrain (${constrainRows.length})`, rows: constrainRows });

  const laneCount = packedLaneCount;

  // --- Per-rank-step widths (horizontal mode sizing) ---
  // Step r is the gap between rank r and rank r+1. We compute a lower
  // bound from local contributors (fact labels, end ticks) first, floor
  // by `minColWidth`, then walk multi-step bars from shortest span to
  // longest and top up the last step of each bar whose cumulative span
  // can't fit its label. Vertical mode ignores this array; computing
  // it unconditionally keeps the layout function orientation-agnostic.
  const colWidths: number[] = new Array(Math.max(0, maxRank)).fill(0);
  const BAR_LABEL_PAD = 12;   // 6px on each end inside a bar
  const FACT_LABEL_PAD_L = 4;
  const FACT_LABEL_PAD_R = 8;

  for (const f of facts) {
    const r = moments.get(f.lTok)!.rank;
    if (r >= maxRank) continue;
    const w = FACT_LABEL_PAD_L + measure(f.label, FACT_LABEL_PX) + FACT_LABEL_PAD_R;
    if (w > colWidths[r]!) colWidths[r] = w;
  }
  // bot/top tick labels sit OUTSIDE the rank range (left of rank 0, right
  // of rank maxRank). Their widths flow into the projector's left/right
  // margins, not into the per-step widths.
  const botLabelWidth = maxRank >= 1 ? measure("bot", END_TICK_PX) : 0;
  const topLabelWidth = maxRank >= 1 ? measure("top", END_TICK_PX) : 0;
  // Floor each per-step gap. In the edges variant a gap between two columns of
  // the same step-rank (incomparable moments) only needs the small fractional
  // width; a gap that crosses a rank boundary gets the full step. Other modes
  // floor every gap to the step uniformly (colStepRank is null).
  for (let r = 0; r < maxRank; r++) {
    const floor = colStepRank !== null && colStepRank[r] === colStepRank[r + 1]
      ? opts.minFracWidth : opts.minColWidth;
    if (colWidths[r]! < floor) colWidths[r] = floor;
  }

  // Bar pass: enforce sum(colWidths[lRank..rRank-1]) >= label + pad.
  // Sort by span ascending so shorter bars settle first; longer bars
  // see the accumulated state and only top up what's still missing.
  const barOrder = bars.slice().sort((a, b) => {
    const sa = moments.get(a.rTok)!.rank - moments.get(a.lTok)!.rank;
    const sb = moments.get(b.rTok)!.rank - moments.get(b.lTok)!.rank;
    return sa - sb;
  });
  for (const b of barOrder) {
    const lR = moments.get(b.lTok)!.rank;
    const rR = moments.get(b.rTok)!.rank;
    if (rR <= lR) continue;
    const need = measure(b.label, BAR_LABEL_PX) + BAR_LABEL_PAD;
    let have = 0;
    for (let r = lR; r < rR; r++) have += colWidths[r]!;
    if (need > have) {
      // Add the slack to the last rank-boundary gap in the span rather than
      // the literal last gap, so a wide label doesn't shove apart two
      // same-rank moments at a fractional gap. A bar spans l < r, so a
      // boundary gap always exists; fall back to rR-1 if not (other modes).
      let topUp = rR - 1;
      if (colStepRank !== null) {
        for (let r = rR - 1; r >= lR; r--) {
          if (colStepRank[r] !== colStepRank[r + 1]) { topUp = r; break; }
        }
      }
      colWidths[topUp]! += (need - have);
    }
  }

  // Strip the helper `lRank` field used during layout.
  const finalBars: Bar[] = bars.map((b) => ({
    tupleIndex: b.tupleIndex,
    lTok: b.lTok, rTok: b.rTok,
    lane: b.lane, label: b.label, full: b.full,
    startGroupRow: b.startGroupRow,
  }));

  // Edges-variant data (cheap; computed unconditionally to keep the layout
  // function orientation/style-agnostic, like colWidths above).
  // Canonical anchor = the first (bar, side) occurrence of each moment in
  // tupleIndex order, `l` before `r`; later occurrences become dashed ties.
  const momentAnchor = new Map<number, { barIndex: number; side: "l" | "r" } | null>();
  const momentTies: { tok: number; barIndex: number; side: "l" | "r" }[] = [];
  const barOrderIdx = finalBars.map((_, i) => i)
    .sort((a, b) => finalBars[a]!.tupleIndex - finalBars[b]!.tupleIndex);
  for (const i of barOrderIdx) {
    const b = finalBars[i]!;
    for (const side of ["l", "r"] as const) {
      const tok = side === "l" ? b.lTok : b.rTok;
      if (momentAnchor.has(tok)) momentTies.push({ tok, barIndex: i, side });
      else momentAnchor.set(tok, { barIndex: i, side });
    }
  }
  for (const tok of moments.keys()) {
    if (!momentAnchor.has(tok)) momentAnchor.set(tok, null);
  }
  // Hasse covers minus pairs a bar already shows as its own endpoints.
  const barPairs = new Set<string>();
  for (const b of finalBars) barPairs.add(`${b.lTok},${b.rTok}`);
  const orderPairs = edges.filter((e) => !barPairs.has(`${e.from},${e.to}`));

  return { moments, bars: finalBars, facts, edges, laneCount, factRowCount, maxRank, maxStartGroupSize, colWidths, botLabelWidth, topLabelWidth, sidebar, momentAnchor, momentTies, orderPairs };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// --- Lane-pack strategies ---

type RawBar = { tupleIndex: number; lTok: number; rTok: number; lRank: number; rRank: number; label: string; full: string };
type PartialBar = Bar & { lRank: number };

// Greedy interval-graph packing — minimum lane count.
function packBarsCompact(rawBars: RawBar[]): { bars: PartialBar[]; laneCount: number } {
  const order = rawBars.slice().sort((a, b) =>
    (a.lRank - b.lRank) || (a.rRank - b.rRank) || (a.tupleIndex - b.tupleIndex));
  const laneEnds: number[] = [];
  const bars: PartialBar[] = [];
  for (const b of order) bars.push(placeBar(b, laneEnds));
  return { bars, laneCount: laneEnds.length };
}

type Forest = {
  N: number;
  parent: (number | null)[];
  children: number[][];
  roots: number[];
};

// Containment forest over the moment partial order: A properly contains
// B iff lA <= lB AND rB <= rA in the order. Identical-endpoint ties are
// broken by tupleIndex (lower index = "outer"). Each bar's parent is
// its innermost container; rank-interval span is the tiebreaker when
// two containers are incomparable to each other.
function buildContainmentForest(
  rawBars: RawBar[],
  leqTok: (a: number, b: number) => boolean,
): Forest {
  const N = rawBars.length;
  const properlyContains = (A: RawBar, B: RawBar): boolean => {
    if (!leqTok(A.lTok, B.lTok)) return false;
    if (!leqTok(B.rTok, A.rTok)) return false;
    const same = A.lTok === B.lTok && A.rTok === B.rTok;
    if (same) return A.tupleIndex < B.tupleIndex;
    return true;
  };
  const span = (b: RawBar) => b.rRank - b.lRank;
  const parent: (number | null)[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    const bi = rawBars[i]!;
    let bestJ: number | null = null;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const bj = rawBars[j]!;
      if (!properlyContains(bj, bi)) continue;
      if (bestJ === null) { bestJ = j; continue; }
      const bb = rawBars[bestJ]!;
      const ds = span(bj) - span(bb);
      if (ds < 0 || (ds === 0 && bj.tupleIndex < bb.tupleIndex)) bestJ = j;
    }
    parent[i] = bestJ;
  }
  const children: number[][] = Array.from({ length: N }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < N; i++) {
    const p = parent[i] ?? null;
    if (p === null) roots.push(i);
    else children[p]!.push(i);
  }
  // Children sorted by start rank; shorter first as the tiebreaker so
  // that crossing siblings at the same start rank settle the short one
  // first (frees its lane sooner) and let the longer one take a higher
  // lane. Sequential (non-tied) siblings keep their natural
  // left-to-right order, preserving lane reuse.
  const sortChildren = (a: number, b: number): number => {
    const A = rawBars[a]!, B = rawBars[b]!;
    const sa = A.rRank - A.lRank;
    const sb = B.rRank - B.lRank;
    return (A.lRank - B.lRank) || (sa - sb) || (A.tupleIndex - B.tupleIndex);
  };
  roots.sort(sortChildren);
  for (const cs of children) cs.sort(sortChildren);
  return { N, parent, children, roots };
}

// Build a placer + finalizer shared between nested/tree packers.
// Lane-sharing rule: a bar can join a lane iff its lTok comes
// non-strictly after the lane's last placed rTok in the moment partial
// order. No owner check — two bars from different subtrees may share a
// lane when they're temporally disjoint. Structural separation between
// a bar and its descendants/ancestor is preserved by the caller via
// `minLane`, not here.
function makePlacer(
  rawBars: RawBar[],
  leqTok: (a: number, b: number) => boolean,
  botTok: number,
) {
  const N = rawBars.length;
  // Each lane stores its last placed bar's rTok. Empty lanes hold
  // `botTok` as a sentinel, which `leqTok` treats as ≤ anything.
  const laneLastRTok: number[] = [];
  const lane: number[] = new Array(N).fill(-1);

  const place = (idx: number, minLane: number): void => {
    const b = rawBars[idx]!;
    for (let li = minLane; li < laneLastRTok.length; li++) {
      if (leqTok(laneLastRTok[li]!, b.lTok)) {
        laneLastRTok[li] = b.rTok;
        lane[idx] = li;
        return;
      }
    }
    // No reusable lane. Open the new lane AT minLane so the bar sits as
    // close to its parent as possible, shifting any existing lanes at
    // minLane and above up by one. Pad with empty sentinels if minLane
    // jumps past current length.
    while (laneLastRTok.length < minLane) laneLastRTok.push(botTok);
    laneLastRTok.splice(minLane, 0, b.rTok);
    for (let i = 0; i < N; i++) {
      if (i !== idx && lane[i]! >= minLane) lane[i] = lane[i]! + 1;
    }
    lane[idx] = minLane;
  };

  const finalize = (): { bars: PartialBar[]; laneCount: number } => {
    const out: PartialBar[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const b = rawBars[i]!;
      out[i] = {
        tupleIndex: b.tupleIndex,
        lTok: b.lTok, rTok: b.rTok,
        lane: lane[i]!, label: b.label, full: b.full,
        startGroupRow: 0, lRank: b.lRank,
      };
    }
    return { bars: out, laneCount: laneLastRTok.length };
  };

  return { place, lane, finalize };
}

// Post-order DFS — leaves get low lanes; each parent sits on a lane
// above all of its direct children. Yields a nested picture where root
// is OUTermost and leaves are nearest the spine.
function packBarsNested(
  rawBars: RawBar[],
  leqTok: (a: number, b: number) => boolean,
  botTok: number,
): { bars: PartialBar[]; laneCount: number } {
  if (rawBars.length === 0) return { bars: [], laneCount: 0 };
  const forest = buildContainmentForest(rawBars, leqTok);
  const { place, lane, finalize } = makePlacer(rawBars, leqTok, botTok);
  const visit = (idx: number): void => {
    for (const c of forest.children[idx]!) visit(c);
    // Re-read lane[c] AFTER all child subtrees finish — earlier-placed
    // siblings can have been shifted up by `place`'s splice-insert
    // when a later sibling's subtree opened a new lane at <= their lane.
    let childMax = -1;
    for (const c of forest.children[idx]!) if (lane[c]! > childMax) childMax = lane[c]!;
    place(idx, childMax + 1);
  };
  for (const r of forest.roots) visit(r);
  return finalize();
}

// Pre-order DFS — parent placed first, then descendants on lanes above.
// Yields a picture where the root sits nearest the spine (lane 0) and
// the tree branches outward. Siblings that share a parent can share
// a lane when temporally disjoint, even if their own subtrees push
// further outward — useful when sibling structure matters more than
// hierarchical depth.
function packBarsTree(
  rawBars: RawBar[],
  leqTok: (a: number, b: number) => boolean,
  botTok: number,
): { bars: PartialBar[]; laneCount: number } {
  if (rawBars.length === 0) return { bars: [], laneCount: 0 };
  const forest = buildContainmentForest(rawBars, leqTok);
  const { place, lane, finalize } = makePlacer(rawBars, leqTok, botTok);
  const visit = (idx: number, minLane: number): void => {
    place(idx, minLane);
    const myLane = lane[idx]!;
    for (const c of forest.children[idx]!) visit(c, myLane + 1);
  };
  for (const r of forest.roots) visit(r, 0);
  return finalize();
}

function placeBar(b: RawBar, laneEnds: number[]): PartialBar {
  let lane = -1;
  for (let li = 0; li < laneEnds.length; li++) {
    if (laneEnds[li]! <= b.lRank) { lane = li; break; }
  }
  if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
  laneEnds[lane] = b.rRank;
  return {
    tupleIndex: b.tupleIndex,
    lTok: b.lTok, rTok: b.rTok,
    lane, label: b.label, full: b.full,
    startGroupRow: 0, lRank: b.lRank,
  };
}

// --- Projector: maps abstract (rank, lane/row) to pixel space + dims. ---

interface Projector {
  width: number;
  height: number;
  // Spine: a perpendicular line at the cross coordinate where moments sit.
  // moments(rank) returns the moment dot center.
  momentPos(rank: number): { x: number; y: number };
  // Hasse arrow from rank u to rank v along the spine.
  hasseLine(u: number, v: number): { x1: number; y1: number; x2: number; y2: number };
  // Episode bar between two ranks at a given lane.
  barRect(rankL: number, rankR: number, lane: number): { x: number; y: number; w: number; h: number };
  // Bar label anchor (text starts here, default left-anchored).
  // `startGroupRow` is the bar's index among bars sharing its starting
  // rank — used in vertical mode to stagger labels so they don't overlap.
  barLabelPos(rankL: number, lane: number, startGroupRow: number): { x: number; y: number };
  // Stub line from a moment outward across the fact area.
  factStub(rank: number, rowCount: number): { x1: number; y1: number; x2: number; y2: number };
  // Fact label at (rank, row).
  factLabelPos(rank: number, row: number): { x: number; y: number };
  // Bot/top tick label position + text-anchor.
  endTickPos(rank: number, which: "bot" | "top"): { x: number; y: number; anchor: "start" | "middle" | "end" };
  // edges variant: dot position on a bar's edge (bar spans rankL..rankR at
  // `lane`; `side` picks which edge).
  momentAnchorPos(rankL: number, rankR: number, lane: number, side: "l" | "r"): { x: number; y: number };
  // edges variant: orthogonal arrow path between two anchor points, routed
  // around the given bar rectangles using only right/up/down segments.
  // `fromRight` means the tail leaves a bar's right edge, in which case it
  // steps right off the edge first so it doesn't hug the bar.
  pairArrowPath(
    a: { x: number; y: number },
    b: { x: number; y: number },
    obstacles: { x: number; y: number; w: number; h: number }[],
    fromRight: boolean,
  ): string;
}

// Liang-Barsky: does the segment a→b pass through the interior of rect r?
// Boundary grazing (a clip interval of measure ~0) does not count, so lines
// running exactly along a bar's edge are not treated as overlapping it.
function segIntersectsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number },
): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i]! < 0) return false; continue; }
    const t = q[i]! / p[i]!;
    if (p[i]! < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-6;
}

function makeProjector(opts: TimelineOpts, layout: TimelineLayout): Projector {
  const { margin, laneHeight, factLabelHeight } = opts;
  const barH = laneHeight - 6;
  const barInset = 4; // gap between spine and the nearest bar lane

  if (opts.orientation === "horizontal") {
    const spineY = margin + layout.laneCount * laneHeight + laneHeight;
    const factAreaH = layout.factRowCount * factLabelHeight;
    // bot label sits left of rank 0; top label sits right of rank maxRank.
    // Gap between dot and label.
    const END_LABEL_GAP = 6;
    const leftPad = layout.botLabelWidth > 0 ? layout.botLabelWidth + END_LABEL_GAP : 0;
    const rightPad = layout.topLabelWidth > 0 ? layout.topLabelWidth + END_LABEL_GAP : 0;
    // Prefix-sum the per-step widths into rank x-coordinates.
    const xs: number[] = new Array(layout.maxRank + 1);
    xs[0] = margin + leftPad;
    for (let r = 0; r < layout.maxRank; r++) xs[r + 1] = xs[r]! + layout.colWidths[r]!;
    const width = xs[layout.maxRank]! + rightPad + margin;
    const height = spineY + laneHeight + factAreaH + margin;
    const xOf = (rank: number) => xs[rank]!;
    const maxRank = layout.maxRank;
    return {
      width, height,
      momentPos: (rank) => ({ x: xOf(rank), y: spineY }),
      hasseLine: (u, v) => ({ x1: xOf(u), y1: spineY, x2: xOf(v), y2: spineY }),
      barRect: (rL, rR, lane) => ({
        x: xOf(rL),
        y: spineY - (lane + 1) * laneHeight - barInset,
        w: Math.max(2, xOf(rR) - xOf(rL)),
        h: barH,
      }),
      barLabelPos: (rL, lane, _row) => ({
        x: xOf(rL) + 6,
        y: spineY - (lane + 1) * laneHeight - barInset + barH / 2 + 4,
      }),
      factStub: (rank, _rowCount) => ({
        x1: xOf(rank), y1: spineY + 6,
        x2: xOf(rank), y2: spineY + 6 + Math.max(1, _rowCount) * factLabelHeight,
      }),
      factLabelPos: (rank, row) => ({
        x: xOf(rank) + 4,
        y: spineY + 6 + (row + 1) * factLabelHeight - 4,
      }),
      endTickPos: (_rank, which) => which === "bot"
        ? { x: xOf(0) - END_LABEL_GAP, y: spineY + 4, anchor: "end" }
        : { x: xOf(maxRank) + END_LABEL_GAP, y: spineY + 4, anchor: "start" },
      momentAnchorPos: (rL, rR, lane, side) => ({
        x: xOf(side === "l" ? rL : rR),
        y: spineY - (lane + 1) * laneHeight - barInset + barH / 2,
      }),
      // Orthogonal routing — every segment runs right, up, or down (never
      // diagonal, never left; `to` is always in a later column than `from`).
      // When leaving a right edge, the tail first steps right off the edge so
      // it clears the bar it exits. Among candidate Manhattan routes (simple
      // L-bends and, if those are blocked, a corridor above the bars or
      // through the lane/spine gap) we pick the one crossing the fewest bars,
      // breaking ties by fewest turns, then smallest vertical travel — so a
      // clean one-bend route never gains a redundant jog.
      pairArrowPath: (a, b, obstacles, fromRight) => {
        const ax = Math.min(a.x + (fromRight ? PAIR_EXIT_STEP : 0), b.x);
        const aStep = { x: ax, y: a.y };
        const aboveY = Math.max(4, Math.min(a.y, b.y, ...obstacles.map((r) => r.y)) - 6);
        const belowY = spineY - barInset;
        // Each route is the full point list from the dot to the target; the
        // leading step to `aStep` collapses into the first segment when it is
        // also horizontal, so routes that turn right first stay single-bend.
        const routes = [
          [a, aStep, { x: b.x, y: a.y }, b],                          // right, then up/down
          [a, aStep, { x: ax, y: b.y }, b],                           // up/down at ax, then right
          [a, aStep, { x: ax, y: aboveY }, { x: b.x, y: aboveY }, b], // corridor above the bars
          [a, aStep, { x: ax, y: belowY }, { x: b.x, y: belowY }, b], // corridor below the bars
        ];
        // Drop the zero-length leading step (when not exiting a right edge)
        // and any other coincident points so turn counts stay honest.
        const clean = (pts: { x: number; y: number }[]) =>
          pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
        const dir = (p: { x: number; y: number }, q: { x: number; y: number }) =>
          `${Math.sign(q.x - p.x)},${Math.sign(q.y - p.y)}`;
        const cost = (pts: { x: number; y: number }[]): [number, number, number] => {
          let crossings = 0, turns = 0, travel = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            for (const r of obstacles) if (segIntersectsRect(pts[i]!, pts[i + 1]!, r)) crossings++;
            travel += Math.abs(pts[i + 1]!.y - pts[i]!.y);
            if (i > 0 && dir(pts[i - 1]!, pts[i]!) !== dir(pts[i]!, pts[i + 1]!)) turns++;
          }
          return [crossings, turns, travel];
        };
        let best = clean(routes[0]!), bestCost = cost(best);
        for (const r of routes.slice(1)) {
          const pts = clean(r), c = cost(pts);
          if (c[0] < bestCost[0]
            || (c[0] === bestCost[0] && (c[1] < bestCost[1]
              || (c[1] === bestCost[1] && c[2] < bestCost[2])))) {
            best = pts; bestCost = c;
          }
        }
        return `M ${best[0]!.x} ${best[0]!.y} ` + best.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ");
      },
    };
  }

  // Vertical: time → y; bars to the right of the spine; facts past bars.
  // Base rank step is ~2 line heights; bump it up if multiple bars start
  // at the same rank so each label gets its own y-row.
  const labelRowH = 14;
  const labelTopOffset = 12;
  const labelBottomPad = 4;
  const baseRankStep = 28;
  const rankStep = Math.max(
    baseRankStep,
    layout.maxStartGroupSize * labelRowH + labelTopOffset + labelBottomPad,
  );
  const spineX = margin + 12; // leave room for "bot" label above
  const barAreaW = layout.laneCount * laneHeight;
  const factGap = 12;
  const factAreaW = Math.max(1, layout.factRowCount) * /* per-row column */ 180;
  const yOf = (rank: number) => margin + 14 + rank * rankStep;
  const width = spineX + barAreaW + factGap + factAreaW + margin;
  const height = yOf(layout.maxRank) + rankStep + margin;
  return {
    width, height,
    momentPos: (rank) => ({ x: spineX, y: yOf(rank) }),
    hasseLine: (u, v) => ({ x1: spineX, y1: yOf(u), x2: spineX, y2: yOf(v) }),
    barRect: (rL, rR, lane) => ({
      x: spineX + barInset + lane * laneHeight,
      y: yOf(rL),
      w: laneHeight - 6,
      h: Math.max(2, yOf(rR) - yOf(rL)),
    }),
    barLabelPos: (rL, lane, row) => ({
      x: spineX + barInset + lane * laneHeight + (laneHeight - 6) / 2,
      // Stagger labels by start-group-row so co-starting bars don't overlap.
      y: yOf(rL) + labelTopOffset + row * labelRowH,
    }),
    factStub: (rank, _rowCount) => ({
      x1: spineX,
      y1: yOf(rank),
      x2: spineX + barAreaW + factGap,
      y2: yOf(rank),
    }),
    factLabelPos: (rank, row) => ({
      x: spineX + barAreaW + factGap + 4 + row * 180,
      y: yOf(rank) - 4,
    }),
    endTickPos: (rank, which) => ({
      x: spineX,
      y: which === "bot" ? yOf(rank) - 6 : yOf(rank) + 14,
      anchor: "middle",
    }),
    // edges mode is horizontal-only; these spine-level fallbacks are never
    // exercised but keep the projector interface total.
    momentAnchorPos: (rL, rR, _lane, side) => ({ x: spineX, y: yOf(side === "l" ? rL : rR) }),
    pairArrowPath: (a, b, _obstacles, _fromRight) => `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
  };
}

// --- ASCII rendering ---
//
// Renders the lane layout as text. Lanes stack top-down with the
// highest-lane bar on the first row. Each rank step occupies a fixed
// character width (sized to fit the longest bar label). Bars are drawn
// as `[label …]`; brackets mark lRank and rRank exactly. Facts and
// moment ticks are omitted — the intent is to make the bar/lane
// arrangement legible at a glance, not to replicate the SVG.
//
// Runs headless (stub measurer; no canvas/DOM), so it's the easiest
// way to inspect or compare layout-algorithm output from a `tsx`
// driver under `ts/src/` — e.g. for debugging lane packing or the
// containment forest without a browser round-trip.

export function renderTimelineAscii(
  store: Store,
  opts: Partial<TimelineOpts> = {},
): string {
  const o: TimelineOpts = { ...DEFAULT_OPTS, ...opts };
  // ASCII output doesn't need pixel widths; stub the measurer so this
  // works in node (no canvas) and skip the layout's per-step sizing pass.
  const layout = layoutTimeline(store, o, () => 0);
  if (layout.bars.length === 0 || layout.maxRank < 1) return "";

  // Pick cell width: smallest int >= 2 such that every bar's label fits
  // between its brackets. For a bar spanning S rank steps, the available
  // interior is S * cellWidth - 1 chars.
  let cellWidth = 2;
  for (const bar of layout.bars) {
    const lR = layout.moments.get(bar.lTok)!.rank;
    const rR = layout.moments.get(bar.rTok)!.rank;
    const span = Math.max(1, rR - lR);
    const need = Math.ceil((bar.label.length + 1) / span);
    if (need > cellWidth) cellWidth = need;
  }
  const totalCols = layout.maxRank * cellWidth + 1;

  const rows: string[] = [];
  for (let lane = layout.laneCount - 1; lane >= 0; lane--) {
    const row: string[] = new Array(totalCols).fill(" ");
    for (const bar of layout.bars) {
      if (bar.lane !== lane) continue;
      const lR = layout.moments.get(bar.lTok)!.rank;
      const rR = layout.moments.get(bar.rTok)!.rank;
      const startCol = lR * cellWidth;
      const endCol = rR * cellWidth;
      row[startCol] = "[";
      row[endCol] = "]";
      const labelMax = endCol - startCol - 1;
      const label = bar.label.length > labelMax ? bar.label.slice(0, labelMax) : bar.label;
      for (let i = 0; i < label.length; i++) row[startCol + 1 + i] = label[i]!;
    }
    rows.push(row.join("").replace(/ +$/, ""));
  }
  return rows.join("\n");
}

// --- Rendering ---

export function renderTimeline(
  store: Store,
  opts: Partial<TimelineOpts> = {},
): { main: SVGSVGElement; sidebar: HTMLElement } {
  const o: TimelineOpts = { ...DEFAULT_OPTS, ...opts };
  const layout = layoutTimeline(store, o);
  const proj = makeProjector(o, layout);

  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", String(proj.width));
  svg.setAttribute("height", String(proj.height));
  svg.setAttribute("viewBox", `0 0 ${proj.width} ${proj.height}`);
  svg.classList.add("timeline-svg");

  // Arrowhead marker.
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", "tl-arrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("orient", "auto-start-reverse");
  const mpath = document.createElementNS(SVG_NS, "path");
  mpath.setAttribute("d", "M0,0 L10,5 L0,10 z");
  mpath.setAttribute("fill", "#666");
  marker.appendChild(mpath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // edges mode draws bars first (dots sit on bar edges), then ties and
  // dot-to-dot cover arrows; spine mode keeps the original spine order.
  const edgesMode = o.momentStyle === "edges" && o.orientation === "horizontal";

  // Canonical dot position for a moment: its anchor bar's edge, or the
  // spine position for bar-less moments (fact-only, bot, top).
  const anchorPoint = (tok: number): { x: number; y: number } => {
    const a = layout.momentAnchor.get(tok);
    if (a !== null && a !== undefined) {
      const b = layout.bars[a.barIndex]!;
      const lR = layout.moments.get(b.lTok)!.rank;
      const rR = layout.moments.get(b.rTok)!.rank;
      return proj.momentAnchorPos(lR, rR, b.lane, a.side);
    }
    return proj.momentPos(layout.moments.get(tok)!.rank);
  };

  // Hasse edges along the spine (spine mode).
  const drawHasseEdges = (): void => {
  for (const e of layout.edges) {
    const fromM = layout.moments.get(e.from)!;
    const toM = layout.moments.get(e.to)!;
    const ln = proj.hasseLine(fromM.rank, toM.rank);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(ln.x1));
    line.setAttribute("y1", String(ln.y1));
    line.setAttribute("x2", String(ln.x2));
    line.setAttribute("y2", String(ln.y2));
    line.setAttribute("stroke", "#666");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("marker-end", "url(#tl-arrow)");
    svg.appendChild(line);
  }
  };

  // Dot-to-dot cover arrows (edges mode), routed around the bar rects.
  const drawPairArrows = (): void => {
    const barRects = layout.bars.map((b) => proj.barRect(
      layout.moments.get(b.lTok)!.rank,
      layout.moments.get(b.rTok)!.rank,
      b.lane,
    ));
    for (const p of layout.orderPairs) {
      const path = document.createElementNS(SVG_NS, "path");
      const fromRight = layout.momentAnchor.get(p.from)?.side === "r";
      path.setAttribute("d", proj.pairArrowPath(anchorPoint(p.from), anchorPoint(p.to), barRects, fromRight));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#666");
      path.setAttribute("stroke-width", "1");
      path.setAttribute("marker-end", "url(#tl-arrow)");
      svg.appendChild(path);
    }
  };

  // Dashed vertical ties from non-canonical bar edges to the canonical dot
  // (edges mode). Both ends share the moment's column, so ties are vertical.
  const drawTies = (): void => {
    for (const t of layout.momentTies) {
      const b = layout.bars[t.barIndex]!;
      const lR = layout.moments.get(b.lTok)!.rank;
      const rR = layout.moments.get(b.rTok)!.rank;
      const e = proj.momentAnchorPos(lR, rR, b.lane, t.side);
      const c = anchorPoint(t.tok);
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(e.x));
      line.setAttribute("y1", String(e.y));
      line.setAttribute("x2", String(c.x));
      line.setAttribute("y2", String(c.y));
      line.setAttribute("stroke", "#4fc1ff");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "2,3");
      svg.appendChild(line);
    }
  };

  // Moment dots + bot/top labels.
  const drawMoments = (): void => {
  for (const m of layout.moments.values()) {
    const isBot = m.tok === store.botTok;
    const isTop = m.tok === store.topTok;
    const p = edgesMode ? anchorPoint(m.tok) : proj.momentPos(m.rank);
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(p.x));
    dot.setAttribute("cy", String(p.y));
    dot.setAttribute("r", isBot || isTop ? "4" : "3");
    dot.setAttribute("fill", isBot || isTop ? "#888" : "#4fc1ff");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = renderTermShallow(store, m.term);
    dot.appendChild(title);
    svg.appendChild(dot);
    if (isBot || isTop) {
      const tp = proj.endTickPos(m.rank, isBot ? "bot" : "top");
      const txt = document.createElementNS(SVG_NS, "text");
      txt.setAttribute("x", String(tp.x));
      txt.setAttribute("y", String(tp.y));
      txt.setAttribute("text-anchor", tp.anchor);
      txt.setAttribute("fill", "#888");
      txt.setAttribute("font-size", String(END_TICK_PX));
      txt.setAttribute("font-family", FONT_FAMILY);
      txt.textContent = isBot ? "bot" : "top";
      svg.appendChild(txt);
    }
  }
  };

  // Episode bars.
  const drawBars = (): void => {
  for (const b of layout.bars) {
    const lM = layout.moments.get(b.lTok)!;
    const rM = layout.moments.get(b.rTok)!;
    const r = proj.barRect(lM.rank, rM.rank, b.lane);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(r.x));
    rect.setAttribute("y", String(r.y));
    rect.setAttribute("width", String(r.w));
    rect.setAttribute("height", String(r.h));
    rect.setAttribute("rx", "3");
    rect.setAttribute("fill", "#264f78");
    rect.setAttribute("stroke", "#4fc1ff");
    rect.setAttribute("stroke-width", "1");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = b.full;
    rect.appendChild(title);
    svg.appendChild(rect);
    const lp = proj.barLabelPos(lM.rank, b.lane, b.startGroupRow);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(lp.x));
    label.setAttribute("y", String(lp.y));
    label.setAttribute("fill", "#d4d4d4");
    label.setAttribute("font-size", String(BAR_LABEL_PX));
    label.setAttribute("font-family", FONT_FAMILY);
    if (o.orientation === "vertical") label.setAttribute("text-anchor", "middle");
    label.textContent = b.label;
    svg.appendChild(label);
  }
  };

  if (edgesMode) {
    // Arrows first so bars paint over them: an interval covers a cover-edge
    // where they cross. Ties and dots stay on top of the bars.
    drawPairArrows();
    drawBars();
    drawTies();
    drawMoments();
  } else {
    drawHasseEdges();
    drawMoments();
    drawBars();
  }

  // Fact stubs + labels (bucketed by rank so stub is drawn once per column).
  const factGroups = new Map<number, Fact[]>();
  for (const f of layout.facts) {
    const r = layout.moments.get(f.lTok)!.rank;
    let bucket = factGroups.get(r);
    if (bucket === undefined) { bucket = []; factGroups.set(r, bucket); }
    bucket.push(f);
  }
  for (const [rank, group] of factGroups) {
    const rowCount = Math.max(...group.map((f) => f.row)) + 1;
    const stub = proj.factStub(rank, rowCount);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(stub.x1));
    line.setAttribute("y1", String(stub.y1));
    line.setAttribute("x2", String(stub.x2));
    line.setAttribute("y2", String(stub.y2));
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1");
    line.classList.add("tl-fact-line");
    svg.appendChild(line);
    for (const f of group) {
      const lp = proj.factLabelPos(rank, f.row);
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(lp.x));
      label.setAttribute("y", String(lp.y));
      label.setAttribute("fill", "currentColor");
      label.setAttribute("font-size", String(FACT_LABEL_PX));
      label.setAttribute("font-family", FONT_FAMILY);
      label.classList.add("tl-fact-label");
      label.textContent = f.label;
      svg.appendChild(label);
    }
  }

  // Sidebar HTML.
  const sidebarEl = document.createElement("div");
  sidebarEl.classList.add("timeline-sidebar");
  if (layout.sidebar.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "#666";
    empty.style.fontSize = "11px";
    empty.style.padding = "8px";
    empty.textContent = "(no is/! tuples)";
    sidebarEl.appendChild(empty);
  } else {
    for (const section of layout.sidebar) {
      const heading = document.createElement("div");
      heading.classList.add("timeline-sidebar-heading");
      heading.textContent = section.heading;
      sidebarEl.appendChild(heading);
      for (const row of section.rows) {
        const r = document.createElement("div");
        r.classList.add("timeline-sidebar-row");
        r.title = row.full;
        r.textContent = row.label;
        sidebarEl.appendChild(r);
      }
    }
  }

  if (opts.orientation === "horizontal") attachHorizontalWheelScroll(svg);

  return { main: svg, sidebar: sidebarEl };
}

// Translate vertical wheel deltas into horizontal scroll on the timeline's
// scroll container. Pure vertical wheel (mouse wheel, no shift, no deltaX)
// scrolls the container left/right; shift-wheel and trackpad horizontal
// gestures pass through to default behavior.
function attachHorizontalWheelScroll(svg: SVGSVGElement): void {
  svg.addEventListener("wheel", (e: WheelEvent) => {
    if (e.shiftKey) return;
    if (e.deltaX !== 0) return;
    if (e.deltaY === 0) return;
    const scroller = svg.parentElement;
    if (!scroller) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    e.preventDefault();
    scroller.scrollLeft += e.deltaY;
  }, { passive: false });
}

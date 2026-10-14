// Moments and their order.
//
// Every moment v3 creates subdivides the running window `(XL, XR)` of the
// continuation that creates it: its `pred` is `XL` and its `succ` is `XR`
// (an episode's end has `pred` = its start). Those are exactly v2's
// `AssertLt` edges, so the order is the same partial order v2 builds. With
// the window invariant `XR ∈ succChain(XL)` (plans/v3-procedural.md) it is
// characterized by
//
//     u ≤ v  iff  some s on succChain(u) is a pred-tree ancestor-or-self of v
//
// `succChain(u)` is `u`, its `succ`, that one's `succ`, … up to `top`: the
// ends of the scopes `u` was created in, so its length is the frame nesting
// depth. Ancestor tests read an Euler tour of the pred tree (rooted at `bot`)
// kept in an order-maintenance list.

export interface Moment {
  readonly id: number;
  readonly pred: Moment | null; // null for bot and top
  readonly succ: Moment | null; // null for bot and top
  readonly enter: OmNode | null; // null for top
  readonly exit: OmNode | null;
  // The frame this moment ends (a frame's `r`), or the root frame for `top`.
  frame: unknown;
  // A frame's start moment knows its frame too (display only).
  startOf: unknown;
  // Cache for `le`: the succ chain's maximal Euler intervals, in list order.
  up?: Moment[];
}

interface OmNode {
  label: number;
  prev: OmNode | null;
  next: OmNode | null;
}

const MAX_LABEL = 2 ** 50;

export class MomentOrder {
  readonly bot: Moment;
  readonly top: Moment;
  readonly all: Moment[] = [];
  private head: OmNode;
  private tail: OmNode;
  private count = 2;

  constructor() {
    this.head = { label: 0, prev: null, next: null };
    this.tail = { label: MAX_LABEL, prev: this.head, next: null };
    this.head.next = this.tail;
    this.bot = { id: 0, pred: null, succ: null, enter: this.head, exit: this.tail, frame: null, startOf: null };
    this.top = { id: 1, pred: null, succ: null, enter: null, exit: null, frame: null, startOf: null };
    this.all.push(this.bot, this.top);
  }

  // A fresh moment strictly between `pred` and `succ`. Null when that is
  // impossible (`pred` is `top`): v2 fails the firing there.
  fresh(pred: Moment, succ: Moment): Moment | null {
    if (pred === this.top || succ === this.bot) return null;
    const enter = this.insertAfter(pred.enter!);
    const exit = this.insertAfter(enter);
    const m: Moment = { id: this.all.length, pred, succ, enter, exit, frame: null, startOf: null };
    this.all.push(m);
    return m;
  }

  isAncestor(a: Moment, v: Moment): boolean {
    return a.enter!.label <= v.enter!.label && v.exit!.label <= a.exit!.label;
  }

  // `u ≤ v`: is `v` inside the Euler interval of some moment on u's succ
  // chain? The chain's intervals form a laminar family, so its maximal
  // members are disjoint; sorted by list position (which relabeling never
  // changes) a binary search finds the only candidate.
  le(u: Moment, v: Moment): boolean {
    if (u === v || u === this.bot || v === this.top) return true;
    if (u === this.top || v === this.bot) return false;
    const up = u.up ?? this.buildUp(u);
    const x = v.enter!.label;
    let lo = 0;
    let hi = up.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (up[mid]!.enter!.label <= x) lo = mid;
      else hi = mid - 1;
    }
    const s = up[lo]!;
    return s.enter!.label <= x && x <= s.exit!.label;
  }

  private buildUp(u: Moment): Moment[] {
    const chain: Moment[] = [];
    for (let s: Moment | null = u; s !== null && s !== this.top; s = s.succ) chain.push(s);
    chain.sort((a, b) => a.enter!.label - b.enter!.label);
    const out: Moment[] = [];
    for (const s of chain) {
      const last = out[out.length - 1];
      if (last !== undefined && s.enter!.label <= last.exit!.label) continue; // nested in `last`
      out.push(s);
    }
    u.up = out;
    return out;
  }

  lt(u: Moment, v: Moment): boolean {
    return u !== v && this.le(u, v);
  }

  comparable(u: Moment, v: Moment): boolean {
    return this.le(u, v) || this.le(v, u);
  }

  max(a: Moment, b: Moment): Moment | null {
    if (this.le(a, b)) return b;
    if (this.le(b, a)) return a;
    return null;
  }

  min(a: Moment, b: Moment): Moment | null {
    if (this.le(a, b)) return a;
    if (this.le(b, a)) return b;
    return null;
  }

  // Least upper bound of `ms`, or `fallback`. For incomparable moments the
  // candidates are the scope ends above each (the first end on one's
  // succChain that is above the other); a unique least one wins.
  lub(ms: readonly Moment[], fallback: Moment): Moment {
    if (ms.length === 0) return fallback;
    let acc: Moment = ms[0]!;
    for (let i = 1; i < ms.length; i++) {
      const b = ms[i]!;
      const m = this.max(acc, b);
      if (m !== null) {
        acc = m;
        continue;
      }
      const c1 = this.firstAbove(acc, b);
      const c2 = this.firstAbove(b, acc);
      const j = c1 !== null && c2 !== null ? this.min(c1, c2) : (c1 ?? c2);
      if (j === null) return fallback;
      acc = j;
    }
    return acc;
  }

  private firstAbove(u: Moment, other: Moment): Moment | null {
    for (let s: Moment | null = u.succ; s !== null; s = s.succ) {
      if (this.le(other, s)) return s;
      if (s === this.top) break;
    }
    return this.top;
  }

  // ------------------------------------------------ order-maintenance list
  // Dietz–Sleator labels: insert after `a`; when there is no gap, relabel
  // the smallest run after `a` whose label span exceeds the square of its
  // length, else everything.
  private insertAfter(a: OmNode): OmNode {
    let b = a.next!;
    if (b.label - a.label < 2) {
      this.relabel(a);
      b = a.next!;
    }
    const n: OmNode = { label: a.label + Math.floor((b.label - a.label) / 2), prev: a, next: b };
    a.next = n;
    b.prev = n;
    this.count++;
    return n;
  }

  private relabel(a: OmNode): void {
    const v0 = a.label;
    let j = 1;
    let node = a.next!;
    while (node !== this.tail && node.label - v0 <= j * j) {
      node = node.next!;
      j++;
    }
    const w = node.label - v0;
    if (w <= j * j || w / j < 2) {
      this.relabelAll();
      return;
    }
    let cur = a.next!;
    for (let k = 1; k < j; k++) {
      cur.label = v0 + Math.floor((k * w) / j);
      cur = cur.next!;
    }
  }

  private relabelAll(): void {
    const step = Math.floor(MAX_LABEL / (this.count + 1));
    if (step < 4) throw new Error("v3: moment order overflow");
    let i = 0;
    for (let n: OmNode | null = this.head; n !== null; n = n.next) {
      n.label = n === this.tail ? MAX_LABEL : i++ * step;
    }
  }
}

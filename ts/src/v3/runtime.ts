// The v3 runtime (plans/v3-procedural.md): stored tuples, frames, the task
// queue, listeners, exception decisions and choices. Rule bodies are
// compiled to continuation-passing steps by compile.ts; they call back into
// this file to look things up, listen, emit and wait.
//
// Scheduling. A *task* is a continuation that will run (queued) or is
// waiting (for a frame's end, or for an exception decision). Each task is
// counted in its *scope*: the frame whose end is its window's right end. A
// frame ends when nothing is counted in it, none of its child frames is
// alive, and no unresolved choice sits below its end. Listeners are passive
// and keep nothing alive: a tuple can only reach a listener's window if its
// emitter runs inside that window's scope (moments.ts), and that emitter is
// counted there.

import type { Program } from "../v2/types.js";
import { AccEngine } from "./acc.js";
import { analyze, type Analysis } from "./analyze.js";
import { compileProgram, type CompiledRule } from "./compile.js";
import { compileJs, runJsRel, type JsEnv } from "./js.js";
import { MomentOrder, type Moment } from "./moments.js";
import { solve, type AccRow, type QAtom, type StoredTuple } from "./query.js";
import {
  CHOICE, groundPat, matchArgs, matchPat, Terms, UNBOUND,
  type Env, type Id, type Pat,
} from "./terms.js";

export interface Tuple extends StoredTuple {
  rel: string;
  frame: Frame | null; // an episode's frame
  deps: readonly Gate[]; // unfinished frames and decisions below `l` when emitted
}

// Something a continuation may have run ahead of: a frame that has not
// ended, or an exception decision not yet made. Reads wait for gates.
export interface Gate {
  ended: boolean;
  waiters: Task[];
  dependents: Frame[]; // frames that cannot end before this gate
  rel: string;
}

export interface Frame extends Gate {
  id: number;
  rel: string;
  args: Id[];
  l: Moment;
  r: Moment;
  parent: Frame | null;
  pending: number;
  ended: boolean;
  ghost: boolean; // an intercepted episode: no tuple, no handlers
  waiters: Task[];
  tuple: Tuple | null;
  // Unfinished frames below `l` at spawn (the spawner ran ahead of a `~>`):
  // work from them can still reach this frame, so it cannot end first.
  deps: readonly Gate[];
  depth: number;
}

// Frames nested deeper than this count as running out of gas: a runaway
// recursion of episodes, where `≤` (which costs the depth) would crawl.
const MAX_DEPTH = 2000;

// A continuation's context: bindings, the window, and the frames that end
// below `xl` but had not ended when the continuation got there. `~>p`, `;`
// and `>p` do not wait for `p`; reads do (`whenComplete`), so everything a
// rule can derive without waiting is derived — what v2 has at a choice.
export interface Ctx {
  env: Env;
  xl: Moment;
  xr: Moment;
  deps: readonly Gate[];
}

export function mergeDeps(a: readonly Gate[], b: readonly Gate[]): readonly Gate[] {
  if (b.length === 0) return a.length === 0 || a.every((f) => !f.ended) ? a : a.filter((f) => !f.ended);
  const out = a.filter((f) => !f.ended);
  for (const f of b) if (!f.ended && !out.includes(f)) out.push(f);
  return out;
}

export interface Task {
  scope: Frame;
  run: () => void;
}

interface Listener {
  seq: number;
  scope: Frame;
  fire: (t: Tuple) => void;
}

class Table {
  readonly tuples: Tuple[] = [];
  readonly listeners: Listener[] = [];
  private readonly index = new Map<number, Map<Id, Tuple[]>>();

  add(t: Tuple): void {
    this.tuples.push(t);
    for (const [pos, m] of this.index) {
      const k = t.args[pos]!;
      let b = m.get(k);
      if (b === undefined) m.set(k, (b = []));
      b.push(t);
    }
  }

  byArg(pos: number, id: Id): Tuple[] {
    let m = this.index.get(pos);
    if (m === undefined) {
      m = new Map();
      for (const t of this.tuples) {
        const k = t.args[pos]!;
        let b = m.get(k);
        if (b === undefined) m.set(k, (b = []));
        b.push(t);
      }
      this.index.set(pos, m);
    }
    return m.get(id) ?? [];
  }

  // Candidates for `pats` under `env`, in insertion order (so a sequence
  // bound ends the scan).
  candidates(pats: readonly Pat[], env: Env, terms: Terms): Tuple[] {
    if (this.tuples.length < 8) return this.tuples;
    for (let i = 0; i < pats.length; i++) {
      const g = groundPat(pats[i]!, env, terms);
      if (g !== null) return this.byArg(i, g);
    }
    return this.tuples;
  }
}

export interface Choice {
  term: Id;
  label: string;
  actor: string;
  moment: Moment;
  deps: readonly Gate[];
  constraints: Constraint[];
  value: Id | null;
  dead: boolean;
  seq: number;
}

export interface Constraint {
  subs: { rel: string; pats: Pat[]; negated: boolean }[];
  env: Env;
  moment: Moment;
  line: number;
}

export interface Component {
  choices: Choice[];
  options: Id[][];
  moment: Moment;
}

export type Status =
  | { kind: "done" }
  | { kind: "choices"; components: Component[] }
  | { kind: "gas"; tuples: number }
  | { kind: "error"; message: string };

class GasError extends Error {}

interface PendingDecision {
  tuple: Tuple;
  catchers: number[];
  scope: Frame; // counted there until decided (a view's owner, the emitter's scope)
  gate: Gate;
}

interface ExnContext {
  index: number; // which exception (compile.ts numbering)
  pats: Pat[];
  env: Env;
  xl: Moment;
  xr: Moment;
  rhs: (ctx: Ctx) => void;
}

export interface RunOptions {
  tupleGas?: number;
  random?: (() => number) | undefined;
}

export class Runtime {
  readonly terms = new Terms();
  readonly mom = new MomentOrder();
  readonly an: Analysis;
  readonly js: JsEnv;
  readonly acc: AccEngine;
  readonly root: Frame;
  readonly frames: Frame[] = [];
  readonly choices: Choice[] = [];
  readonly tables = new Map<string, Table>();
  readonly rules: CompiledRule[];
  private queue: Task[] = [];
  private qHead = 0;
  private toCheck: Frame[] = [];
  private blocked = new Set<Frame>();
  private parked: Task[] = []; // reads waiting for choices below them
  private pendingExn: PendingDecision[] = [];
  private contexts = new Map<number, ExnContext[]>();
  private seq = 0;
  private tupleCount = 0;
  private readonly tupleGas: number;
  private random: (() => number) | null;
  private started = false;
  readonly choiceOf = new Map<Id, Choice>();
  readonly warnings: string[] = [];

  constructor(readonly program: Program, opts: RunOptions = {}) {
    this.tupleGas = opts.tupleGas ?? 1_000_000;
    this.random = opts.random ?? null;
    this.an = analyze(program);
    this.js = compileJs(program, this.terms);
    this.root = {
      id: 0, rel: "<root>", args: [], l: this.mom.bot, r: this.mom.top, parent: null,
      pending: 0, ended: false, ghost: false, waiters: [], tuple: null, deps: [], dependents: [], depth: 0,
    };
    this.mom.top.frame = this.root;
    this.frames.push(this.root);
    const terms = this.terms;
    this.acc = new AccEngine(program, terms, this.mom, {
      alive: (rel, pats, env, m) => this.aliveAt(rel, pats, env, m),
      js: (rel, args) => this.jsRel(rel, args),
      ground: (p, env) => groundPat(p, env, terms),
      match: (ps, ids, env) => matchArgs(ps, ids, env, terms),
      matchOne: (p, id, env) => matchPat(p, id, env, terms),
    });
    this.rules = compileProgram(program, this);
  }

  // ---------------------------------------------------------------- store

  table(rel: string): Table {
    let t = this.tables.get(rel);
    if (t === undefined) this.tables.set(rel, (t = new Table()));
    return t;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  *aliveAt(rel: string, pats: Pat[], env: Env, m: Moment): Iterable<Tuple> {
    const t = this.tables.get(rel);
    if (t === undefined) return;
    for (const tu of t.candidates(pats, env, this.terms)) {
      if (this.mom.le(tu.l, m) && this.mom.le(m, tu.r)) yield tu;
    }
  }

  jsRel(rel: string, args: (Id | null)[]): Iterable<Id[]> {
    const clauses = this.js.rels.get(rel);
    if (clauses === undefined) throw new Error(`v3: unknown js relation '${rel}'`);
    return runJsRel(rel, clauses, args, this.terms);
  }

  warnLate(f: Frame, line: number): void {
    const w = `late arrival: rule on line ${line} entered '${f.rel}' after it ended`;
    if (!this.warnings.includes(w)) this.warnings.push(w);
  }

  frameOf(m: Moment): Frame {
    const f = m.frame as Frame | null;
    if (f === null) throw new Error("internal: a window's right end is not a frame end");
    return f;
  }

  // Store a tuple and hand it to the listeners registered before it.
  insert(t: Tuple): void {
    if (++this.tupleCount > this.tupleGas) throw new GasError();
    t.seq = this.nextSeq();
    const table = this.table(t.rel);
    table.add(t);
    const ls = table.listeners;
    let dead = 0;
    const n = ls.length;
    for (let i = 0; i < n; i++) {
      const l = ls[i]!;
      if (l.scope.ended) { dead++; continue; }
      if (l.seq < t.seq) l.fire(t);
    }
    if (dead > 16 && dead * 2 > n) {
      const live = ls.filter((l) => !l.scope.ended);
      ls.length = 0;
      ls.push(...live);
    }
  }

  listen(rel: string, scope: Frame, fire: (t: Tuple) => void): number {
    const seq = this.nextSeq();
    this.table(rel).listeners.push({ seq, scope, fire });
    return seq;
  }

  // ---------------------------------------------------------------- tasks

  enqueue(scope: Frame, run: () => void): void {
    scope.pending++;
    this.queue.push({ scope, run });
  }

  // Run `k` once `f` has ended (now, if it has).
  awaitEnd(f: Gate, scope: Frame, k: () => void): void {
    if (f.ended) {
      k();
      return;
    }
    scope.pending++;
    f.waiters.push({ scope, run: k });
  }

  // Continue at `ctx` whose window starts at a frame's end (`~>p`, `;`,
  // `>p`): at once, remembering the frame if it has not ended.
  continueAt(ctx: Ctx, k: (ctx: Ctx) => void): void {
    if (ctx.xl === ctx.xr) return; // a point window
    const f = ctx.xl.frame as Frame | null;
    if (f === null || f.ended || f === this.root) k(ctx);
    else k({ ...ctx, deps: mergeDeps(ctx.deps, [f]) });
  }

  // Run `k` once the state at `ctx.xl` is final: a point read (`#acc`,
  // `not`, a lookup that does not listen) needs it. Two things can still
  // change it: frames below `xl` that have not ended, and choices asked
  // below `xl` that have no answer yet (the `is` row will start below `xl`).
  // v2 is blocked at such moments the same way (its walk cannot pass them).
  whenComplete(ctx: Ctx, k: (ctx: Ctx) => void): void {
    const open = ctx.deps.find((f) => !f.ended);
    if (open !== undefined) {
      this.awaitEnd(open, this.frameOf(ctx.xr), () => this.whenComplete(ctx, k));
      return;
    }
    if (this.choiceBelow(ctx.xl)) {
      const scope = this.frameOf(ctx.xr);
      scope.pending++;
      this.parked.push({ scope, run: () => this.whenComplete(ctx, k) });
      return;
    }
    k(ctx.deps.length === 0 ? ctx : { ...ctx, deps: [] });
  }

  private choiceBelow(m: Moment): boolean {
    for (const c of this.open) if (this.mom.lt(c.moment, m)) return true;
    return false;
  }

  newFrame(rel: string, args: Id[], l: Moment, r: Moment, parent: Frame, deps: readonly Gate[]): Frame {
    // frames count against the tuple budget too: a runaway recursion of
    // episodes nests ever deeper, and `≤` costs the nesting depth
    if (this.frames.length > this.tupleGas || parent.depth >= MAX_DEPTH) throw new GasError();
    const f: Frame = {
      id: this.frames.length, rel, args, l, r, parent, pending: 0, ended: false, ghost: false, waiters: [], tuple: null,
      deps, dependents: [], depth: parent.depth + 1,
    };
    this.frames.push(f);
    r.frame = f;
    l.startOf = f;
    parent.pending++;
    this.toCheck.push(f);
    return f;
  }

  private tryEnd(f: Frame): void {
    while (f !== this.root && !f.ended && f.pending === 0) {
      const dep = f.deps.find((d) => !d.ended);
      if (dep !== undefined) {
        if (!dep.dependents.includes(f)) dep.dependents.push(f);
        return;
      }
      if (this.blockedByChoice(f)) {
        this.blocked.add(f);
        return;
      }
      f.ended = true;
      this.blocked.delete(f);
      for (const w of f.waiters) this.queue.push(w);
      f.waiters = [];
      for (const d of f.dependents) this.toCheck.push(d);
      f.dependents = [];
      const p = f.parent!;
      p.pending--;
      f = p;
    }
  }

  private blockedByChoice(f: Frame): boolean {
    for (const c of this.open) if (this.mom.lt(c.moment, f.r)) return true;
    return false;
  }

  private readonly open = new Set<Choice>();

  private get openChoices(): Choice[] {
    return [...this.open];
  }

  // ---------------------------------------------------------------- emits

  // Emit `t`: store and dispatch it, or, when an exception may intercept
  // it, hold it until the decision at quiescence. The emitter runs on at
  // once (as in v2, where the primed tuple exists); the decision is a gate
  // its later reads wait for.
  emit(t: Tuple, scope: Frame, catchers: number[], cont: (gate: Gate | null) => void): void {
    if (catchers.length > 0) {
      scope.pending++;
      if (t.frame !== null) t.frame.pending++;
      const gate: Gate = { ended: false, waiters: [], dependents: [], rel: `decide ${t.rel}` };
      this.pendingExn.push({ tuple: t, catchers, scope, gate });
      cont(gate);
      return;
    }
    if (t.frame !== null) t.frame.tuple = t;
    this.insert(t);
    cont(null);
  }

  private decidable(p: PendingDecision): boolean {
    return p.tuple.deps.every((f) => f.ended) && !this.choiceBelow(p.tuple.l);
  }

  addContext(c: ExnContext): void {
    let cs = this.contexts.get(c.index);
    if (cs === undefined) this.contexts.set(c.index, (cs = []));
    cs.push(c);
  }

  private decideExceptions(): void {
    // a tuple with unfinished frames below it waits: its moment is not
    // complete (v2 decides when the walk reaches it)
    const batch = this.pendingExn.filter((p) => this.decidable(p));
    this.pendingExn = this.pendingExn.filter((p) => !batch.includes(p));
    for (const p of batch) {
      const t = p.tuple;
      // The first exception (in v2's renaming order) with a context that
      // overlaps the tuple catches it; a later one would only have seen
      // the earlier one's default re-emission.
      let caught = false;
      for (const x of p.catchers) {
        for (const c of this.contexts.get(x) ?? []) {
          if (!this.mom.lt(c.xl, t.r) || !this.mom.lt(t.l, c.xr)) continue;
          const env = c.env.slice();
          if (!matchArgs(c.pats, t.args, env, this.terms)) continue;
          caught = true;
          const ctx: Ctx = { env, xl: t.l, xr: t.r, deps: t.deps };
          this.enqueue(this.frameOf(t.r), () => c.rhs(ctx));
        }
        if (caught) break;
      }
      if (caught) {
        if (t.frame !== null) t.frame.ghost = true;
      } else {
        if (t.frame !== null) t.frame.tuple = t;
        this.insert(t);
      }
      if (t.frame !== null) {
        t.frame.pending--;
        this.toCheck.push(t.frame);
      }
      p.gate.ended = true;
      for (const w of p.gate.waiters) this.queue.push(w);
      p.gate.waiters = [];
      for (const d of p.gate.dependents) this.toCheck.push(d);
      p.gate.dependents = [];
      p.scope.pending--;
      this.toCheck.push(p.scope);
    }
  }

  // ---------------------------------------------------------------- choices

  ask(label: string, actor: string, moment: Moment, deps: readonly Gate[]): Id {
    const term = this.terms.choice(label);
    const c: Choice = { term, label, actor, moment, deps, constraints: [], value: null, dead: false, seq: this.nextSeq() };
    this.choices.push(c);
    this.open.add(c);
    this.choiceOf.set(term, c);
    return term;
  }

  constrain(k: Constraint): void {
    const mentioned = new Set<Choice>();
    const visit = (id: Id) => {
      if (this.terms.kind[id] === CHOICE) {
        const c = this.choiceOf.get(id);
        if (c !== undefined) mentioned.add(c);
        return;
      }
      for (const x of this.terms.args[id] ?? []) visit(x);
    };
    for (const s of k.subs) for (const p of s.pats) {
      const g = groundPatDeep(p, k.env);
      for (const id of g) visit(id);
    }
    if (mentioned.size === 0) return;
    if (![...mentioned].some((c) => c.moment === k.moment)) {
      throw new Error(`late-constraint-error: the '!' on line ${k.line} is not at the moment its choice was asked`);
    }
    for (const c of mentioned) c.constraints.push(k);
  }

  // Answer a choice: an `is` row from the ask moment to `top`.
  resolve(c: Choice, value: Id): void {
    if (c.value !== null || c.dead) throw new Error(`v3: choice ${c.label} is already settled`);
    c.value = value;
    this.open.delete(c);
    const t: Tuple = { rel: "is", args: [c.term, value], l: c.moment, r: this.mom.top, seq: 0, frame: null, deps: [] };
    this.insert(t);
    this.releaseBlocked();
  }

  private markDead(c: Choice): void {
    c.dead = true;
    this.open.delete(c);
    this.releaseBlocked();
  }

  private releaseBlocked(): void {
    for (const f of [...this.blocked]) {
      this.blocked.delete(f);
      this.toCheck.push(f);
    }
    // parked reads retry (each stays counted in its scope until it runs)
    const parked = this.parked;
    this.parked = [];
    for (const t of parked) this.queue.push(t);
  }

  // The components that can be offered now (plans/v2-choice-components-by-moment.md):
  // unresolved choices with no unresolved choice below them, grouped by ask
  // moment and joined by shared constraints. A constraint that also
  // mentions a later choice belongs to that one.
  private components(): Component[] | { error: string } {
    const open = this.openChoices;
    const ready = open.filter((c) =>
      c.deps.every((f) => f.ended) && !open.some((d) => d !== c && this.mom.lt(d.moment, c.moment)));
    const byMoment = new Map<Moment, Choice[]>();
    for (const c of ready) {
      let g = byMoment.get(c.moment);
      if (g === undefined) byMoment.set(c.moment, (g = []));
      g.push(c);
    }
    const out: Component[] = [];
    for (const [m, cs] of byMoment) {
      // union-find over constraints owned by this moment
      const parent = new Map<Choice, Choice>(cs.map((c) => [c, c]));
      const find = (c: Choice): Choice => (parent.get(c) === c ? c : find(parent.get(c)!));
      const owned = new Set<Constraint>();
      for (const c of cs) {
        for (const k of c.constraints) {
          const others = this.mentionedOpen(k);
          if ([...others].some((o) => o.moment !== m)) continue; // belongs to a later choice
          owned.add(k);
          for (const o of others) parent.set(find(o), find(c));
        }
      }
      const groups = new Map<Choice, Choice[]>();
      for (const c of cs) {
        const r = find(c);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(c);
      }
      for (const g of groups.values()) {
        const ks = [...owned].filter((k) => [...this.mentionedOpen(k)].some((o) => g.includes(o)));
        for (const c of g) {
          if (!ks.some((k) => this.mentionedOpen(k).has(c))) {
            return { error: `empty-fringe-error: choice ${c.label} has no constraint of its own at its moment` };
          }
        }
        out.push({ choices: g.sort((a, b) => a.seq - b.seq), options: this.options(g, ks, m), moment: m });
      }
    }
    return out.sort((a, b) => a.choices[0]!.seq - b.choices[0]!.seq);
  }

  private mentionedOpen(k: Constraint): Set<Choice> {
    const out = new Set<Choice>();
    const visit = (id: Id) => {
      if (this.terms.kind[id] === CHOICE) {
        const c = this.choiceOf.get(id);
        if (c !== undefined && c.value === null && !c.dead) out.add(c);
        return;
      }
      for (const x of this.terms.args[id] ?? []) visit(x);
    };
    for (const s of k.subs) for (const p of s.pats) for (const id of groundPatDeep(p, k.env)) visit(id);
    return out;
  }

  // Enumerate a component's joint options at its moment.
  private options(cs: Choice[], ks: Constraint[], m: Moment): Id[][] {
    const terms = this.terms;
    const slotOf = new Map<string, number>();
    const slot = (key: string) => {
      let s = slotOf.get(key);
      if (s === undefined) slotOf.set(key, (s = slotOf.size));
      return s;
    };
    const choiceSlots = cs.map((c) => slot(`c${c.term}`));
    const lift = (id: Id): Pat => {
      if (terms.kind[id] === CHOICE) {
        const c = this.choiceOf.get(id)!;
        if (c.value !== null) return { k: "c", id: c.value };
        if (cs.includes(c)) return { k: "v", slot: slot(`c${id}`) };
        return { k: "c", id }; // a dead choice: matches nothing real
      }
      const a = terms.args[id];
      if (a === null || a === undefined || !terms.hasMinted(id)) return { k: "c", id };
      return { k: "a", args: a.map(lift) };
    };
    const atoms: QAtom[] = [];
    ks.forEach((k, ki) => {
      const conv = (p: Pat): Pat => {
        switch (p.k) {
          case "c": return lift(p.id);
          case "w": return { k: "w" };
          case "v": return k.env[p.slot] === UNBOUND ? { k: "v", slot: slot(`e${ki}.${p.slot}`) } : lift(k.env[p.slot]!);
          case "a": return { k: "a", args: p.args.map(conv) };
          case "js": throw new Error("v3: @js inside !(...)");
        }
      };
      for (const s of k.subs) {
        const pats = s.pats.map(conv);
        if (s.negated) atoms.push({ k: "not", rel: s.rel, pats });
        else if (this.an.acc.has(s.rel)) atoms.push({ k: "acc", rel: s.rel, pats });
        else if (this.an.js.has(s.rel)) atoms.push({ k: "js", rel: s.rel, pats });
        else atoms.push({ k: "rel", rel: s.rel, pats });
      }
    });
    const seen = new Set<string>();
    const out: Id[][] = [];
    const env: Env = new Array(slotOf.size).fill(UNBOUND);
    solve(atoms, env, m, {
      alive: (rel, pats, e, mm) => this.aliveAt(rel, pats, e, mm),
      rows: (rel, mm) => this.acc.rowsAt(rel, mm),
      js: (rel, args) => this.jsRel(rel, args),
      ground: (p, e) => groundPat(p, e, terms),
      match: (ps, ids, e) => matchArgs(ps, ids, e, terms),
      matchOne: (p, id, e) => matchPat(p, id, e, terms),
    }, (e) => {
      const tuple = choiceSlots.map((s) => e[s]!);
      if (tuple.some((v) => v === UNBOUND)) return;
      const key = tuple.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        out.push(tuple);
      }
    }, true);
    return out;
  }

  // ---------------------------------------------------------------- driver

  // Run until quiescent: done, waiting on choices, out of gas, or an error.
  run(): Status {
    try {
      if (!this.started) {
        this.started = true;
        for (const r of this.rules) this.enqueue(this.root, () => r.start());
      }
      for (;;) {
        this.drain();
        if (this.pendingExn.some((p) => this.decidable(p))) {
          this.decideExceptions();
          continue;
        }
        const comps = this.components();
        if ("error" in comps) return { kind: "error", message: comps.error };
        if (comps.length === 0) {
          const open = this.openChoices;
          if (open.length > 0) return { kind: "error", message: `entangled choices: ${open.map((c) => c.label).join(", ")}` };
          return { kind: "done" };
        }
        let progressed = false;
        for (const comp of comps) {
          if (comp.options.length === 0) {
            for (const c of comp.choices) this.markDead(c);
            progressed = true;
          } else if (comp.choices.every((c) => c.actor === "rng")) {
            const pick = comp.options[Math.floor(this.rng() * comp.options.length)]!;
            comp.choices.forEach((c, i) => this.resolve(c, pick[i]!));
            progressed = true;
          }
        }
        if (progressed) continue;
        return { kind: "choices", components: comps };
      }
    } catch (e) {
      if (e instanceof GasError) return { kind: "gas", tuples: this.tupleCount };
      return { kind: "error", message: (e as Error).message };
    }
  }

  answer(comp: Component, option: Id[]): void {
    comp.choices.forEach((c, i) => this.resolve(c, option[i]!));
  }

  private drain(): void {
    for (;;) {
      while (this.qHead < this.queue.length) {
        const task = this.queue[this.qHead++]!;
        task.run();
        task.scope.pending--;
        this.tryEnd(task.scope);
        this.checkFrames();
        if (this.qHead > 4096 && this.qHead * 2 > this.queue.length) {
          this.queue = this.queue.slice(this.qHead);
          this.qHead = 0;
        }
      }
      this.checkFrames();
      if (this.qHead >= this.queue.length) return;
    }
  }

  private checkFrames(): void {
    while (this.toCheck.length > 0) {
      const fs = this.toCheck;
      this.toCheck = [];
      for (const f of fs) this.tryEnd(f);
    }
  }

  private rng(): number {
    if (this.random === null) {
      const seeds = this.tables.get("rng-seed")?.tuples ?? [];
      const vals = new Set(seeds.map((t) => this.terms.num(t.args[0]!)));
      if (vals.size > 1 || vals.has(null)) throw new Error("rng-seed: one numeric value expected");
      const seed = vals.size === 1 ? [...vals][0]! : null;
      this.random = seed === null ? Math.random : mulberry32(seed);
    }
    return this.random();
  }

  get tuplesStored(): number {
    return this.tupleCount;
  }
}

// Every ground id inside `p` under `env` (constants and bound variables).
function groundPatDeep(p: Pat, env: Env): Id[] {
  switch (p.k) {
    case "c": return [p.id];
    case "v": return env[p.slot] === UNBOUND ? [] : [env[p.slot]!];
    case "w": return [];
    case "a":
    case "js": return p.args.flatMap((q) => groundPatDeep(q, env));
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type { AccRow };

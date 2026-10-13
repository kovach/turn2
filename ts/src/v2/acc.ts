// `#acc` relations: a snapshot per settled moment, computed where read
// (plans/v2-acc-relations.md; timing from
// plans/v2-choice-components-by-moment.md step 6).
//
// An acc relation's rows are a function of the state alive at a moment:
// `body / head` rules derive contributions from the stored tuples alive at
// `m` (and from other acc relations' rows at `m`), the declared op folds
// them per key (acc-ops.ts: η, ⊕, ρ), and the result is written as point
// rows `name k… v <id>` at `[m, m]`.
// Ordinary rules read them with a point match at their anchor's left
// endpoint (expand.ts `decomposeAccRead`); a `!(...)` block reads them with
// its ordinary stored-tuple match at the component's moment.
//
// Evaluation stratifies the acc relations over their read dependencies
// (edge r → s when a rule with head s reads r), evaluates each SCC in
// topological order, and iterates a recursive SCC to a fixpoint with
// accumulating contributions. When every op in the SCC is idempotent that
// is a least fixpoint; otherwise the program is assumed well-defined (the
// section's clause) and a round cap turns divergence into an error.
//
// Timing: the snapshot at `m` is fixed by the handler's `settle` hook, which
// fires once per moment, the first time a walk round with `m` on the
// frontier is quiet — after every fold and same-moment `^` chain at `m` has
// settled, before `m` is marked resolved and before any choice at `m`
// surfaces. It records the watermark `store.accWatermark[m] =
// tuples.length`; the rows at `m` are a function of the tuples below it
// (store.ts), so they can be computed then or at any later time with the
// same result. Rows are written once per moment, so what readers (or a
// choice's continuation) emit at `m` is not folded into `m`'s acc rows,
// only into later moments'. A second choice chained at the same moment
// therefore sees the acc state from before the first.
//
// Demand (the default under `runFixpoint`, `accMode: "demand"`): a
// relation's rows are computed only at moments something reads it
// (`store.accDemand`): an ordinary rule's acc read or a `not` read's
// `_acc-at r` read (eval.ts `evalMatch`), or a `_constrain` row's moment
// for the relations some `!(...)` reads (scanned here). Computing a
// relation computes the relations its acc rules read too (`accClosure`;
// whole strata), so a moment's rows for any one relation are complete and
// consistent with any computed later — all come from the same watermark.
// `settle` computes at once what `m` already demands; demand arriving
// later is served from the watermark through `demanded` / `run`. The handler is `exclusive` (moment-walk.ts): a walk round in which
// it writes rows runs no other handler, so readers of late rows fire before
// anything is judged — the same state the eager mode reaches. Eager mode
// computes at every settled moment (for displays that draw every moment's
// rows). Rows written are progress either way: readers wake through the
// ordinary semi-naive delta.

import type { Atom, Term } from "./term.js";
import { hashconsTerm } from "./hashcons.js";
import type { AccDecl, Program, Rule, RuleAtom } from "./types.js";
import { addTuple, candidatesByHead, demandAcc, leastUpperBound, momentCone, tokenOf, type Store } from "./store.js";
import { costEnter, costExit, inFrame } from "./stats.js";
import { ACC_MOMENT_VAR, evaluateRule, type AccEvalCtx, type AccRow, type CompiledJs } from "./eval.js";
import { resolveJsModes, type CompiledJsRel } from "./js-rel.js";
import { decomposeAccRule, SYM_ACC_AT } from "./expand.js";
import { accOp, type AccOpDef } from "./acc-ops.js";
import type { MomentHandler } from "./moment-walk.js";

// Rounds a recursive stratum may take at one moment before the run fails.
export const ACC_ROUND_CAP = 1000;

const SYM_ACC_ID: Term = { tag: "Symbol", name: "*acc" };
const SYM_ACC_AT_ID: Term = { tag: "Symbol", name: "*acc-at" };

export interface AccStratum {
  relations: string[];
  rules: Rule[];       // lowered acc rules whose heads are in `relations`
  recursive: boolean;  // some rule reads a relation of this stratum
}

export interface CompiledAcc {
  decls: Map<string, AccDecl>;
  strata: AccStratum[];
  // Relation -> the acc relations its rules read.
  reads: Map<string, Set<string>>;
}

// Lower every acc rule, resolve js modes, and stratify (§5.1).
export function compileAcc(program: Program): CompiledAcc {
  const lowered = resolveJsModes(
    program.accRules.map((r) => decomposeAccRule(r, program)),
    program.jsRels,
  );
  // Dependency graph over acc relations.
  const headOf = (r: Rule): string => {
    const c = r.body.find((a) => a.tag === "AccContribute");
    if (c === undefined || c.tag !== "AccContribute") throw new Error(`internal: acc rule '${r.name}' has no head`);
    return c.relation;
  };
  const readsOf = (r: Rule): string[] =>
    r.body.flatMap((a) => (a.tag === "AccMatch" ? [a.relation] : []));
  const succ = new Map<string, Set<string>>(); // r -> relations that read r
  const reads = new Map<string, Set<string>>(); // r -> relations r's rules read
  for (const name of program.accDecls.keys()) { succ.set(name, new Set()); reads.set(name, new Set()); }
  for (const r of lowered) {
    const h = headOf(r);
    for (const read of readsOf(r)) { succ.get(read)!.add(h); reads.get(h)!.add(read); }
  }
  const sccs = tarjan([...program.accDecls.keys()], (n) => succ.get(n) ?? new Set());
  // Stratified negation: `not r` in a rule for `h` needs `r` in a strictly
  // lower stratum, i.e. not in `h`'s SCC.
  const sccOf = new Map<string, number>();
  sccs.forEach((rels, i) => rels.forEach((r) => sccOf.set(r, i)));
  for (const r of lowered) {
    const h = headOf(r);
    for (const a of r.body) {
      if (a.tag === "AccMatch" && a.negated && sccOf.get(a.relation) === sccOf.get(h)) {
        throw new Error(
          `acc rule '${r.name}': 'not ${a.relation}' is recursive through '${h}' — ` +
          `negation must read a relation computed strictly before '${h}' (stratified negation)`,
        );
      }
    }
  }
  const strata: AccStratum[] = sccs.map((relations) => {
    const set = new Set(relations);
    const rules = lowered.filter((r) => set.has(headOf(r)));
    const recursive = rules.some((r) => readsOf(r).some((x) => set.has(x)));
    return { relations, rules, recursive };
  });
  return { decls: program.accDecls, strata, reads };
}

// `rels` and every acc relation they read, transitively.
export function accClosure(compiled: CompiledAcc, rels: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...rels];
  while (stack.length > 0) {
    const r = stack.pop()!;
    if (out.has(r)) continue;
    out.add(r);
    for (const d of compiled.reads.get(r) ?? []) stack.push(d);
  }
  return out;
}

// Tarjan's SCC, emitting components in topological order (a component is
// emitted after every component it has an edge into — i.e. dependencies
// first when edges point from a relation to its readers).
function tarjan(nodes: string[], succ: (n: string) => Iterable<string>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of succ(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      out.push(comp);
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  // Tarjan emits a component only after everything reachable from it, so
  // `out` lists readers before what they read; reverse for dependencies
  // first.
  return out.reverse();
}

// One deduplicated contribution (§2.2): key/value tokens, moment, firing.
interface Contribution {
  key: Term[];
  value: Term | null;
  moment: Term;
}

// Compute acc relations' rows at the point `m` (§5.2): every relation, or
// the strata holding a relation of `only` (which must be closed under
// `accClosure`; the result then has just those strata's relations).
// `bound`: only stored tuples with index below it are read (the moment's
// watermark; default the whole store).
export function computeAccAt(
  store: Store,
  compiled: CompiledAcc,
  m: Term,
  jsFuncs: Map<string, CompiledJs>,
  jsRels: Map<string, CompiledJsRel[]>,
  bound?: number,
  only?: ReadonlySet<string>,
): Map<string, AccRow[]> {
  const rows = new Map<string, AccRow[]>();
  const pin: RuleAtom = {
    tag: "Equal",
    lhs: { tag: "Variable", name: ACC_MOMENT_VAR },
    rhs: m,
    span: { line: 0 },
  };
  const cost = store.stats.cost;
  const cone = inFrame(cost, "acc cone", () => momentCone(store, m));
  for (const stratum of compiled.strata) {
    if (only !== undefined && !stratum.relations.some((r) => only.has(r))) continue;
    for (const rel of stratum.relations) rows.set(rel, []);
    const frame = cost !== undefined ? costEnter(cost, "engine", 0, `acc fold {${stratum.relations.join(", ")}}`) : undefined;
    // Contributions accumulate across rounds, keyed by
    // (key tokens, value token, moment token, firing identity).
    const contribs = new Map<string, Map<string, Contribution>>();
    for (const rel of stratum.relations) contribs.set(rel, new Map());
    let rounds = 0;
    for (;;) {
      const ctx: AccEvalCtx = {
        rows: (relation) => rows.get(relation) ?? [],
        contribute: (relation, terms, moment, firing) => {
          const decl = compiled.decls.get(relation)!;
          const key: Term[] = [];
          let value: Term | null = null;
          terms.forEach((t, i) => {
            if (i === decl.aggIndex) value = t;
            else key.push(t);
          });
          const sig = [
            ...key.map((t) => tokenOf(store, t)),
            value === null ? "" : tokenOf(store, value),
            tokenOf(store, moment),
            firing,
          ].join("|");
          const bucket = contribs.get(relation)!;
          if (!bucket.has(sig)) bucket.set(sig, { key, value, moment });
        },
      };
      if (bound !== undefined) ctx.tupleBound = bound;
      if (cone !== undefined) ctx.cone = cone;
      for (const rule of stratum.rules) {
        evaluateRule({ ...rule, body: [pin, ...rule.body] }, store, jsFuncs, jsRels, -1, ctx);
      }
      let changed = false;
      for (const rel of stratum.relations) {
        const decl = compiled.decls.get(rel)!;
        const fresh = foldRelation(store, decl, [...contribs.get(rel)!.values()], m);
        if (!sameRows(store, rows.get(rel)!, fresh)) {
          rows.set(rel, fresh);
          changed = true;
        }
      }
      if (!changed || !stratum.recursive) break;
      if (++rounds >= ACC_ROUND_CAP) {
        throw new Error(
          `acc: stratum {${stratum.relations.join(", ")}} did not converge at moment ` +
          `${renderMoment(store, m)} after ${ACC_ROUND_CAP} rounds`,
        );
      }
    }
    if (frame !== undefined) costExit(cost!, frame);
  }
  return rows;
}

// For inspection (the web moment inspector) and displays: the relations'
// rows at the settled moment `tok`, computed from its watermark — what eager
// mode would have written there — without writing anything or adding
// demand. `only` limits the work to those relations and what they read
// (the result may hold more); omitted, every relation. Undefined when `tok`
// has not settled (`top` settles last, once every other moment resolved).
export function accRowsAt(
  store: Store,
  compiled: CompiledAcc,
  jsFuncs: Map<string, CompiledJs>,
  jsRels: Map<string, CompiledJsRel[]>,
  tok: number,
  only?: Iterable<string>,
): Map<string, AccRow[]> | undefined {
  const bound = store.accWatermark.get(tok);
  const m = store.momentTerms.get(tok);
  if (bound === undefined || m === undefined) return undefined;
  const rels = only === undefined ? undefined : accClosure(compiled, [...only].filter((r) => compiled.decls.has(r)));
  return computeAccAt(store, compiled, m, jsFuncs, jsRels, bound, rels);
}

// ρ(⊕ᵢ η(cᵢ)) per key group (§2.2). Generic over the op registry; no
// op-specific code here.
function foldRelation(store: Store, decl: AccDecl, contribs: Contribution[], m: Term): AccRow[] {
  const aggCol = decl.aggIndex === null ? null : decl.columns[decl.aggIndex]!;
  const op: AccOpDef<unknown> = aggCol !== null && aggCol.kind === "agg"
    ? accOp(aggCol.op)!
    : accOp("bool", true)!;
  // Group by key tokens.
  const groups = new Map<string, { key: Term[]; items: Contribution[] }>();
  for (const c of contribs) {
    const sig = c.key.map((t) => tokenOf(store, t)).join("|");
    let g = groups.get(sig);
    if (g === undefined) { g = { key: c.key, items: [] }; groups.set(sig, g); }
    g.items.push(c);
  }
  // A keyless relation folds its (single, possibly empty) group so ρ(e)
  // gives the zero row; a keyed relation has no row for absent keys.
  if (groups.size === 0 && decl.columns.length === (aggCol === null ? 0 : 1)) {
    groups.set("", { key: [], items: [] });
  }
  const out: AccRow[] = [];
  for (const g of groups.values()) {
    let acc = op.identity;
    for (const c of g.items) {
      const v = c.value ?? { tag: "Atom", atom: { terms: [] } };
      acc = op.combine(acc, op.inject(v, c.moment, store, decl.relation), store);
    }
    const groupMoment = leastUpperBound(store, g.items.map((c) => c.moment)) ?? m;
    for (const r of op.readout(acc, store)) {
      const terms: Term[] = [];
      let vi = 0;
      for (let i = 0; i < decl.columns.length; i++) {
        if (i === decl.aggIndex) {
          if (op.column) terms.push(hashconsTerm(r.value, store.hash));
        } else {
          terms.push(g.key[vi++]!);
        }
      }
      out.push({ terms, moment: r.moment ?? groupMoment });
    }
  }
  return out;
}

function rowSig(store: Store, r: AccRow): string {
  return r.terms.map((t) => tokenOf(store, t)).join("|");
}

function sameRows(store: Store, a: readonly AccRow[], b: readonly AccRow[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map((r) => rowSig(store, r)));
  return b.every((r) => sa.has(rowSig(store, r)));
}

function renderMoment(store: Store, m: Term): string {
  if (m.tag === "Symbol") return m.name;
  return `#${tokenOf(store, m)}`;
}

export type AccMode = "eager" | "demand";

export interface AccHandlerOptions {
  // "eager": rows at every settled moment. "demand": only where read. The
  // handler's default is eager; `runFixpoint` defaults to demand.
  mode?: AccMode;
  // Relations some `not` reads: computing one also writes its `_acc-at r`
  // point row, which the read waits on (expand.ts decomposeAccRead).
  markers?: ReadonlySet<string>;
  // Relations some `!(...)` reads: they are demanded at every `_constrain`
  // row's moment, so the rows exist before its component is enumerated
  // (constraint-query.ts reads them at the component's moment).
  constrainReads?: ReadonlySet<string>;
}

// The moment handler (§5.5). `settle` fixes the snapshot (the watermark)
// and computes it when wanted; `demanded` / `run` serve demand at
// already-settled moments. One handler per store (it keeps a cursor into
// the store's `_constrain` rows).
export function accHandler(
  compiled: CompiledAcc,
  jsFuncs: Map<string, CompiledJs>,
  jsRels: Map<string, CompiledJsRel[]>,
  opts: AccHandlerOptions = {},
): MomentHandler {
  const mode = opts.mode ?? "eager";
  const all = [...compiled.decls.keys()];
  let constrainSeen = 0;
  const scanConstrain = (store: Store): void => {
    if (opts.constrainReads === undefined || opts.constrainReads.size === 0) return;
    const rows = candidatesByHead(store, "_constrain");
    for (; constrainSeen < rows.length; constrainSeen++) {
      const tok = tokenOf(store, store.tuples[rows[constrainSeen]!]!.l);
      for (const rel of opts.constrainReads) demandAcc(store, tok, rel);
    }
  };
  // Compute the relations wanted at `m` (all of them when eager, else the
  // demanded ones not yet computed) and those they read, from its
  // watermark, and write their rows and markers. True iff a tuple was added.
  const compute = (store: Store, m: Term, tok: number): boolean => {
    store.accPending.delete(tok);
    let done = store.accComputed.get(tok);
    if (done === undefined) { done = new Set(); store.accComputed.set(tok, done); }
    const want = (mode === "eager" ? all : [...(store.accDemand.get(tok) ?? [])]).filter((r) => !done.has(r));
    const need = accClosure(compiled, want);
    for (const r of need) done.add(r);
    let any = false;
    for (const rel of need) {
      if (opts.markers?.has(rel) !== true) continue;
      const relSym: Term = { tag: "Symbol", name: rel };
      const id: Term = hashconsTerm({ tag: "Id", atom: { terms: [SYM_ACC_AT_ID, relSym, m] } }, store.hash);
      if (addTuple(store, { terms: [SYM_ACC_AT, relSym, id] }, m, m)) any = true;
    }
    if (need.size === 0) return any;
    const rows = computeAccAt(store, compiled, m, jsFuncs, jsRels, store.accWatermark.get(tok), need);
    const frame = store.stats.cost !== undefined ? costEnter(store.stats.cost, "engine", 0, "acc write rows") : undefined;
    for (const [relation, rs] of rows) {
      const head: Term = { tag: "Symbol", name: relation };
      for (const r of rs) {
        const id: Term = hashconsTerm(
          { tag: "Id", atom: { terms: [SYM_ACC_ID, head, ...r.terms, m] } },
          store.hash,
        );
        const atom: Atom = { terms: [head, ...r.terms, id] };
        if (addTuple(store, atom, m, m)) any = true;
      }
    }
    if (frame !== undefined) costExit(store.stats.cost!, frame);
    return any;
  };
  return {
    name: "acc",
    exclusive: true,
    // Pending demand at a settled moment (frontier or resolved): compute it
    // from the watermark. Anything else is left to `settle`.
    run(store, m) {
      const tok = tokenOf(store, m);
      if (!store.accPending.has(tok) || !store.settled.has(tok)) return { progress: false, blocked: false };
      return { progress: compute(store, m, tok), blocked: false };
    },
    demanded(store) {
      scanConstrain(store);
      const out: number[] = [];
      for (const tok of store.accPending) if (store.settled.has(tok)) out.push(tok);
      return out;
    },
    settle(store, m) {
      const tok = tokenOf(store, m);
      store.accWatermark.set(tok, store.tuples.length);
      scanConstrain(store);
      if (mode === "demand" && !store.accPending.has(tok)) return false;
      return compute(store, m, tok);
    },
  };
}

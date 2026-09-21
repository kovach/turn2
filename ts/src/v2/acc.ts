// `#acc` relations: computed at moment resolution (plans/v2-acc-relations.md).
//
// An acc relation's rows are a function of the state alive at a moment:
// `body / head` rules derive contributions from the stored tuples alive at
// `m` (and from other acc relations' rows at `m`), the declared op folds
// them per key (acc-ops.ts: η, ⊕, ρ), and the result is written as point
// rows `name k… v <id>` at `[m, m]` when the moment walk marks `m`
// resolved. Ordinary rules read them with a point match at their anchor's
// left endpoint (expand.ts `decomposeAccRead`).
//
// Evaluation stratifies the acc relations over their read dependencies
// (edge r → s when a rule with head s reads r), evaluates each SCC in
// topological order, and iterates a recursive SCC to a fixpoint with
// accumulating contributions. When every op in the SCC is idempotent that
// is a least fixpoint; otherwise the program is assumed well-defined (the
// section's clause) and a round cap turns divergence into an error.
//
// Timing: the handler does nothing in `run` rounds; its `resolve` hook
// fires once per marked moment, after every fold and same-moment `^` chain
// at `m` has settled. The rows it writes are progress, so the inner loop
// runs and readers at `m` fire — but `m` is already resolved, so what they
// emit at `m` is not folded into `m`'s acc rows (a snapshot), only into
// later moments'.

import type { Atom, Term } from "./term.js";
import { hashconsTerm } from "./hashcons.js";
import type { AccDecl, Program, Rule, RuleAtom } from "./types.js";
import { addTuple, leastUpperBound, tokenOf, type Store } from "./store.js";
import { ACC_MOMENT_VAR, evaluateRule, type AccEvalCtx, type AccRow, type CompiledJs } from "./eval.js";
import { resolveJsModes, type CompiledJsRel } from "./js-rel.js";
import { decomposeAccRule } from "./expand.js";
import { accOp, type AccOpDef } from "./acc-ops.js";
import type { MomentHandler } from "./moment-walk.js";

// Rounds a recursive stratum may take at one moment before the run fails.
export const ACC_ROUND_CAP = 1000;

const SYM_ACC_ID: Term = { tag: "Symbol", name: "*acc" };

export interface AccStratum {
  relations: string[];
  rules: Rule[];       // lowered acc rules whose heads are in `relations`
  recursive: boolean;  // some rule reads a relation of this stratum
}

export interface CompiledAcc {
  decls: Map<string, AccDecl>;
  strata: AccStratum[];
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
  for (const name of program.accDecls.keys()) succ.set(name, new Set());
  for (const r of lowered) {
    const h = headOf(r);
    for (const read of readsOf(r)) succ.get(read)!.add(h);
  }
  const sccs = tarjan([...program.accDecls.keys()], (n) => succ.get(n) ?? new Set());
  const strata: AccStratum[] = sccs.map((relations) => {
    const set = new Set(relations);
    const rules = lowered.filter((r) => set.has(headOf(r)));
    const recursive = rules.some((r) => readsOf(r).some((x) => set.has(x)));
    return { relations, rules, recursive };
  });
  return { decls: program.accDecls, strata };
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

// Compute every acc relation's rows at the point `m` (§5.2).
export function computeAccAt(
  store: Store,
  compiled: CompiledAcc,
  m: Term,
  schema: Map<string, string>,
  jsFuncs: Map<string, CompiledJs>,
  jsRels: Map<string, CompiledJsRel[]>,
): Map<string, AccRow[]> {
  const rows = new Map<string, AccRow[]>();
  for (const name of compiled.decls.keys()) rows.set(name, []);
  const pin: RuleAtom = {
    tag: "Equal",
    lhs: { tag: "Variable", name: ACC_MOMENT_VAR },
    rhs: m,
    span: { line: 0 },
  };
  for (const stratum of compiled.strata) {
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
      for (const rule of stratum.rules) {
        evaluateRule({ ...rule, body: [pin, ...rule.body] }, store, schema, jsFuncs, jsRels, -1, ctx);
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
  }
  return rows;
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

// The moment handler (§5.5): nothing in `run`; at `resolve`, compute the
// rows at `m` and write them as point tuples with a deterministic id.
export function accHandler(
  compiled: CompiledAcc,
  schema: Map<string, string>,
  jsFuncs: Map<string, CompiledJs>,
  jsRels: Map<string, CompiledJsRel[]>,
): MomentHandler {
  return {
    name: "acc",
    run() {
      return { progress: false, blocked: false };
    },
    resolve(store, m) {
      if (compiled.decls.size === 0) return false;
      const rows = computeAccAt(store, compiled, m, schema, jsFuncs, jsRels);
      let any = false;
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
      return any;
    },
  };
}

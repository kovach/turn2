// v2 single-rule evaluator. CPS-style backtracking over a flat list of
// post-expand RuleAtom primitives.
//
// State:
//   - trail: Trail (positional stack of (name, term) bindings; mark/unwind
//            for backtracking).
//
// All anchor manipulation (overlap testing, intersection via max/min,
// fresh-moment construction, addOrder edges, sub-rule entry/exit) is done
// by explicit IR atoms emitted at expand time. The evaluator is a flat
// dispatch over Match / Emit / Le / AssertLt / Max / Min / Equal.

import type { Atom, Term, Trail } from "./term.js";
import { newTrail, trailLength, trailUnwind } from "./term.js";
import { substAtom, substTerm, unifyAtoms, unifyTerms } from "./unify.js";
import { hashconsTerm, type HashconsState } from "./hashcons.js";
import type { JsDef, Rule, RuleAtom } from "./types.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  comparable,
  internAtom,
  leastUpperBound,
  lessEq,
  lessThan,
  tokenOf,
  type Store,
} from "./store.js";
import { getOrCreateHead } from "./stats.js";
import { decodeTerm, encodeTerm } from "./js-values.js";
import { JS_REL_YIELD_CAP, type CompiledJsRel } from "./js-rel.js";

// A compiled `#js` function: takes the hashcons store + raw Term args, decodes
// the args, runs the user body, and encodes the result. See compileJsDefs.
export type CompiledJs = (hc: HashconsState, args: Term[]) => Term;

// Compile each `#js` def once (before the fixpoint). A malformed body throws
// here (a syntax error from `new Function`), surfaced with the function name.
export function compileJsDefs(jsDefs: Map<string, JsDef>): Map<string, CompiledJs> {
  const m = new Map<string, CompiledJs>();
  for (const [name, d] of jsDefs) {
    let inner: (...xs: unknown[]) => unknown;
    try {
      inner = new Function(...d.params, d.body) as (...xs: unknown[]) => unknown;
    } catch (e) {
      throw new Error(`#js ${name}: ${(e as Error).message}`);
    }
    m.set(name, (hc, args) => encodeTerm(inner(...args.map((t) => decodeTerm(t, hc)))));
  }
  return m;
}

// A computed acc row (plans/v2-acc-relations.md): the key and value column
// terms (hashconsed, no head, no id) and the row's moment (§2.1).
export interface AccRow {
  terms: Term[];
  moment: Term;
}

// What a lowered acc rule needs from its caller (acc.ts): the local rows of
// the relations it reads, and a sink for the contributions its head makes.
// `AccMatch` / `AccContribute` atoms throw without it.
export interface AccEvalCtx {
  rows(relation: string): readonly AccRow[];
  contribute(relation: string, terms: Term[], moment: Term, firing: string): void;
}

interface Ctx {
  store: Store;
  schema: Map<string, string>;
  jsFuncs: Map<string, CompiledJs>;
  jsRels: Map<string, CompiledJsRel[]>;
  trail: Trail;
  ruleName: string;
  ruleIdx: number;
  acc?: AccEvalCtx;
}

export function evaluateRule(
  rule: Rule,
  store: Store,
  schema: Map<string, string>,
  jsFuncs: Map<string, CompiledJs>,
  jsRels: Map<string, CompiledJsRel[]> = new Map(),
  ruleIdx = -1,
  acc?: AccEvalCtx,
): void {
  const ctx: Ctx = {
    store,
    schema,
    jsFuncs,
    jsRels,
    trail: newTrail(),
    ruleName: rule.name,
    ruleIdx,
  };
  if (acc !== undefined) ctx.acc = acc;
  const rs = ruleIdx >= 0 ? store.stats.rules[ruleIdx] : undefined;
  if (rs !== undefined) rs.invocations++;
  const tracking = store.stats.enabled && rs !== undefined;
  const t0 = tracking ? performance.now() : 0;
  const onFire = rs !== undefined ? () => { rs.firings++; } : () => {};
  evalSeq(rule.body, 0, ctx, onFire);
  if (tracking) rs!.wallMs += performance.now() - t0;
}

function evalSeq(body: RuleAtom[], i: number, ctx: Ctx, k: () => void): void {
  if (i >= body.length) { k(); return; }
  const a = body[i]!;
  const next = () => evalSeq(body, i + 1, ctx, k);

  switch (a.tag) {
    case "Equal":      evalEqual(a, ctx, next); return;
    case "Match":      evalMatch(a, ctx, next); return;
    case "Emit":       evalEmit(a, ctx, next); return;
    case "Le":         evalLe(a, ctx, next); return;
    case "AssertLt":   evalAssertLt(a, ctx, next); return;
    case "Max":        evalMaxMin(a, ctx, next, true); return;
    case "Min":        evalMaxMin(a, ctx, next, false); return;
    case "JsCall":     evalJsCall(a, ctx, next); return;
    case "JsIterate":  evalJsIterate(a, ctx, next); return;
    case "AccMatch":   evalAccMatch(a, ctx, next); return;
    case "AccContribute": evalAccContribute(a, ctx, next); return;
    case "Atom":
    case "Sub":
    case "Exception":
      throw new Error(`internal: pre-expand RuleAtom '${a.tag}' reached evaluator (decomposition pass missing?)`);
  }
}

// Enumerate a `#js-def` relation (plans/v2-js-relations.md). The resolved
// clause's generator receives the decoded `+`-position args; each yielded
// array unifies against the `-`-position arg terms as a backtracking choice
// point (an already-bound `-` arg filters — that's how a `-` clause serves a
// bound call position). The generator is stepped manually so continuation
// errors (GasError from `next()`) propagate unwrapped while user-body
// errors are surfaced with the relation name.
function evalJsIterate(
  a: Extract<RuleAtom, { tag: "JsIterate" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const clauses = ctx.jsRels.get(a.func);
  const clause = clauses?.[a.defIndex ?? -1];
  if (clause === undefined) {
    throw new Error(`internal: js relation '${a.func}' reached eval without mode resolution`);
  }
  const args = a.args.map((t) => substTerm(t, ctx.trail));
  const bound: unknown[] = [];
  const outIdx: number[] = [];
  for (let i = 0; i < clause.modes.length; i++) {
    if (clause.modes[i] === "+") {
      // Ground by the mode pass's binding analysis; decodeTerm throws an
      // internal error otherwise.
      bound.push(decodeTerm(args[i]!, ctx.store.hash));
    } else {
      outIdx.push(i);
    }
  }
  let it: Iterator<unknown>;
  try {
    it = clause.gen(...bound)[Symbol.iterator]();
  } catch (e) {
    throw new Error(`#js-def ${a.func} threw: ${(e as Error).message}`);
  }
  let yields = 0;
  for (;;) {
    let res: IteratorResult<unknown>;
    try {
      res = it.next();
    } catch (e) {
      throw new Error(`#js-def ${a.func} threw: ${(e as Error).message}`);
    }
    if (res.done === true) return;
    if (++yields > JS_REL_YIELD_CAP) {
      throw new Error(`#js-def ${a.func}: yield limit exceeded (possible infinite generator)`);
    }
    const row = res.value;
    if (!Array.isArray(row) || row.length !== outIdx.length) {
      throw new Error(
        `#js-def ${a.func}: yield must be an array of ${outIdx.length} value(s) (the '-' arguments)`,
      );
    }
    const mark = trailLength(ctx.trail);
    let ok = true;
    for (let j = 0; j < outIdx.length; j++) {
      if (!unifyTerms(args[outIdx[j]!]!, encodeTerm(row[j]), ctx.trail, ctx.store.hash)) {
        ok = false;
        break;
      }
    }
    if (ok) next();
    trailUnwind(ctx.trail, mark);
  }
}

// Read a local acc row (plans/v2-acc-relations.md §5.3): unify the pattern
// against `[relation, ...row.terms]` and the moment Variable against the
// row's moment, as a backtracking choice point over the relation's rows.
function evalAccMatch(
  a: Extract<RuleAtom, { tag: "AccMatch" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const acc = ctx.acc;
  if (acc === undefined) {
    throw new Error(`internal: rule '${ctx.ruleName}': AccMatch outside an acc rule`);
  }
  const head: Term = { tag: "Symbol", name: a.relation };
  for (const row of acc.rows(a.relation)) {
    const mark = trailLength(ctx.trail);
    const rowAtom: Atom = { terms: [head, ...row.terms] };
    if (
      unifyAtoms(a.atom, rowAtom, ctx.trail, ctx.store.hash) &&
      unifyTerms(a.moment, row.moment, ctx.trail, ctx.store.hash)
    ) {
      next();
    }
    trailUnwind(ctx.trail, mark);
  }
}

// The head of an acc rule: hand one contribution to the acc handler. The
// contribution's moment is the lub of the matched tuples' left endpoints
// and matched acc rows' moments (`bot` for none; the handler substitutes
// the moment being resolved if no lub exists). Firing identity = the ids
// of the matched stored tuples.
function evalAccContribute(
  a: Extract<RuleAtom, { tag: "AccContribute" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const acc = ctx.acc;
  if (acc === undefined) {
    throw new Error(`internal: rule '${ctx.ruleName}': AccContribute outside an acc rule`);
  }
  const terms = a.terms.map((t) => hashconsTerm(substTerm(t, ctx.trail), ctx.store.hash));
  const moments = a.moments.map((t) => substTerm(t, ctx.trail));
  const lub = leastUpperBound(ctx.store, moments);
  const moment = lub ?? substTerm({ tag: "Variable", name: ACC_MOMENT_VAR }, ctx.trail);
  const firing = a.ids.map((t) => String(tokenOf(ctx.store, substTerm(t, ctx.trail)))).join("|");
  acc.contribute(a.relation, terms, moment, firing);
  next();
}

// The Variable a lowered acc rule's body is pinned to (expand.ts
// `decomposeAccRule` binds every read to it; acc.ts prepends `Equal` of it
// to the moment being resolved).
export const ACC_MOMENT_VAR = "_acc_m";

function evalJsCall(
  a: Extract<RuleAtom, { tag: "JsCall" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const args = a.args.map((t) => substTerm(t, ctx.trail)); // may contain Refs
  const fn = ctx.jsFuncs.get(a.func);
  if (fn === undefined) throw new Error(`@js(${a.func} ...): undefined #js function`);
  let term: Term;
  try {
    term = fn(ctx.store.hash, args);
  } catch (e) {
    throw new Error(`@js(${a.func} ...) threw: ${(e as Error).message}`);
  }
  const mark = trailLength(ctx.trail);
  // unifyTerms/bindable hashconses `term` when binding `out`.
  if (unifyTerms(a.out, term, ctx.trail, ctx.store.hash)) next();
  trailUnwind(ctx.trail, mark);
}

function evalEqual(
  a: Extract<RuleAtom, { tag: "Equal" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const mark = trailLength(ctx.trail);
  if (unifyTerms(a.lhs, a.rhs, ctx.trail, ctx.store.hash)) {
    next();
  }
  trailUnwind(ctx.trail, mark);
}

function evalMatch(
  a: Extract<RuleAtom, { tag: "Match" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const head = headSymOf(a.atom);
  if (head === null) return;
  const it = ctx.store.iteration;
  const constraint = a.constraint ?? "any";
  const rs = ctx.ruleIdx >= 0 ? ctx.store.stats.rules[ctx.ruleIdx] : undefined;
  const hs = getOrCreateHead(ctx.store.stats, head);
  hs.scanCount++;
  // Display bookkeeping (plans/v2-acc-timeline-display.md): an ordinary
  // rule's point read of an acc relation is recorded at its moment whether
  // or not a row matches, so the timeline can mark where a relation was
  // consulted. Acc rules read through `AccMatch`, so they never land here.
  if (ctx.store.accRelations.size > 0 && ctx.store.accRelations.has(head)) {
    const at = substTerm(a.l, ctx.trail);
    if (at.tag !== "Variable" && at.tag !== "Wildcard") {
      let seen = ctx.store.accConsulted.get(head);
      if (seen === undefined) { seen = new Set(); ctx.store.accConsulted.set(head, seen); }
      seen.add(tokenOf(ctx.store, at));
    }
  }
  for (const idx of candidatesByHead(ctx.store, head)) {
    if (rs !== undefined) rs.candScanned++;
    const gen = ctx.store.gens[idx]!;
    if (constraint === "delta") {
      if (gen !== it - 1) continue;
    } else if (constraint === "old") {
      if (!(gen < it - 1)) continue;
    }
    if (rs !== undefined) rs.candPassedGen++;
    const tup = ctx.store.tuples[idx]!;
    const mark = trailLength(ctx.trail);
    // Bind endpoints first — typically these are fresh `_l_<k>`/`_r_<k>`
    // Variables that this Match introduces. Doing this before unifyAtoms
    // lets later overlap (`Le`) atoms in the body short-circuit on
    // already-known endpoint values without re-running atom unify.
    if (!unifyTerms(a.l, tup.l, ctx.trail, ctx.store.hash)) {
      trailUnwind(ctx.trail, mark);
      continue;
    }
    if (!unifyTerms(a.r, tup.r, ctx.trail, ctx.store.hash)) {
      trailUnwind(ctx.trail, mark);
      continue;
    }
    if (rs !== undefined) rs.candPassedOverlap++;
    if (!unifyAtoms(a.atom, tup.atom, ctx.trail, ctx.store.hash)) {
      trailUnwind(ctx.trail, mark);
      continue;
    }
    if (rs !== undefined) rs.candPassedLiteral++;
    if (rs !== undefined) rs.candPassedUnify++;
    next();
    trailUnwind(ctx.trail, mark);
  }
}

// Emit a stored tuple. The atom may contain Variables / Wildcards that
// were already bound on the trail by upstream Equal atoms (the
// decomposition pass injects those for unbound user vars and Wildcards).
// We substitute, intern, and addTuple at the supplied (already trail-
// bound) endpoints.
function evalEmit(
  a: Extract<RuleAtom, { tag: "Emit" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const substituted = substAtom(a.atom, ctx.trail);
  const interned = internAtom(ctx.store, substituted);
  const l = substTerm(a.l, ctx.trail);
  const r = substTerm(a.r, ctx.trail);
  addTuple(ctx.store, interned, l, r, a.span, ctx.ruleIdx);
  next();
}

function evalLe(
  a: Extract<RuleAtom, { tag: "Le" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const aT = substTerm(a.a, ctx.trail);
  const bT = substTerm(a.b, ctx.trail);
  if (!comparable(ctx.store, aT, bT)) return;
  if (lessEq(ctx.store, aT, bT)) next();
}

function evalAssertLt(
  a: Extract<RuleAtom, { tag: "AssertLt" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const aT = substTerm(a.a, ctx.trail);
  const bT = substTerm(a.b, ctx.trail);
  addOrder(ctx.store, aT, bT);
  next();
}

function evalMaxMin(
  a: Extract<RuleAtom, { tag: "Max" | "Min" }>,
  ctx: Ctx,
  next: () => void,
  isMax: boolean,
): void {
  const aT = substTerm(a.a, ctx.trail);
  const bT = substTerm(a.b, ctx.trail);
  // Incomparable args: relational failure (matches today's incomparable-
  // anchor → failed-overlap behavior). The next iteration of the outer
  // loop reaches a different candidate combination.
  if (!comparable(ctx.store, aT, bT)) return;
  // Equal args (by hashcons token) trivially: pick aT.
  let pick: Term;
  if (lessThan(ctx.store, aT, bT)) {
    pick = isMax ? bT : aT;
  } else {
    // aT >= bT. (lessThan(b,a) or equal.)
    pick = isMax ? aT : bT;
  }
  const mark = trailLength(ctx.trail);
  if (unifyTerms(a.out, pick, ctx.trail, ctx.store.hash)) {
    next();
  }
  trailUnwind(ctx.trail, mark);
}

function headSymOf(atom: Atom): string | null {
  const head = atom.terms[0];
  if (head === undefined || head.tag !== "Symbol") return null;
  return head.name;
}

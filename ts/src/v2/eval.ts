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
import type { Expr, JsDef, Rule, RuleAtom } from "./types.js";
import { isTermExpr } from "./types.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  argIndexFor,
  argKey,
  candidatesByHeadAt,
  comparable,
  coneLe,
  demandAcc,
  internAtom,
  leastUpperBound,
  lessEq,
  lessThan,
  latticeMax,
  latticeMin,
  tokenOf,
  type MomentCone,
  type Store,
} from "./store.js";
import { costEnter, costExit, getOrCreateHead, siteFor, type SiteStats } from "./stats.js";
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
  // Snapshot bound (store.ts `accWatermark`): stored-tuple matches see only
  // tuples with index below it. Absent = the whole store.
  tupleBound?: number;
  // The computation's moment cone (store.ts `momentCone`): answers the
  // `Le` checks against the acc moment without per-tuple closure walks.
  cone?: MomentCone;
}

interface Ctx {
  store: Store;
  jsFuncs: Map<string, CompiledJs>;
  jsRels: Map<string, CompiledJsRel[]>;
  trail: Trail;
  ruleName: string;
  ruleIdx: number;
  acc?: AccEvalCtx;
  // Stored-tuple matches skip candidates at or past this index (an acc
  // snapshot's watermark; `Infinity` otherwise).
  bound: number;
  // Join-site counters (stats.ts `SiteStats`), when stats are enabled:
  // `site` is the atom evalSeq is dispatching, read by evalMatch /
  // evalAccMatch before they recurse.
  track: boolean;
  site?: SiteStats;
}

export function evaluateRule(
  rule: Rule,
  store: Store,
  jsFuncs: Map<string, CompiledJs>,
  jsRels: Map<string, CompiledJsRel[]> = new Map(),
  ruleIdx = -1,
  acc?: AccEvalCtx,
): void {
  const ctx: Ctx = {
    store,
    jsFuncs,
    jsRels,
    trail: newTrail(),
    ruleName: rule.name,
    ruleIdx,
    bound: acc?.tupleBound ?? Infinity,
    track: store.stats.enabled,
  };
  if (acc !== undefined) ctx.acc = acc;
  const rs = ruleIdx >= 0 ? store.stats.rules[ruleIdx] : undefined;
  if (rs !== undefined) rs.invocations++;
  const tracking = store.stats.enabled && rs !== undefined;
  const t0 = tracking ? performance.now() : 0;
  const onFire = rs !== undefined ? () => { rs.firings++; } : () => {};
  const cost = store.stats.cost;
  const frame = cost !== undefined ? costEnter(cost, acc !== undefined ? "acc" : "rule", rule.span.line, rule.name) : undefined;
  if (ctx.track) {
    const done = store.stats.completions;
    evalSeq(rule.body, 0, ctx, () => { done.set(rule.name, (done.get(rule.name) ?? 0) + 1); onFire(); });
  } else if (frame !== undefined) {
    evalSeq(rule.body, 0, ctx, () => { frame.entry.completions++; onFire(); });
  } else {
    evalSeq(rule.body, 0, ctx, onFire);
  }
  if (frame !== undefined) costExit(cost!, frame);
  if (tracking) rs!.wallMs += performance.now() - t0;
}

function evalSeq(body: RuleAtom[], i: number, ctx: Ctx, k: () => void): void {
  if (i >= body.length) { k(); return; }
  const a = body[i]!;
  const next = () => evalSeq(body, i + 1, ctx, k);
  if (ctx.track) {
    const head = a.tag === "Match" ? headSymOf(a.atom) ?? "" : a.tag === "AccMatch" ? a.relation : "";
    const site = siteFor(ctx.store.stats, body, i, ctx.ruleName, head);
    site.entries++;
    ctx.site = site;
  }

  switch (a.tag) {
    case "Equal":      evalEqual(a, ctx, next); return;
    case "Match":      evalMatch(a, ctx, next); return;
    case "Emit":       evalEmit(a, ctx, next); return;
    case "Le":         evalLe(a, ctx, next); return;
    case "AssertLt":   evalAssertLt(a, ctx, next); return;
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
  const ss = ctx.track ? ctx.site : undefined;
  if (ss !== undefined) noteBound(ss, a.atom, ctx, undefined);
  const head: Term = { tag: "Symbol", name: a.relation };
  if (a.negated) {
    // `not r t̄` over a strictly lower stratum's (final) local rows.
    for (const row of accRowCandidates(a, acc.rows(a.relation), ctx)) {
      if (ss !== undefined) ss.scanned++;
      const mark = trailLength(ctx.trail);
      const hit = unifyAtoms(a.atom, { terms: [head, ...row.terms] }, ctx.trail, ctx.store.hash);
      trailUnwind(ctx.trail, mark);
      if (hit) return;
    }
    next();
    return;
  }
  for (const row of accRowCandidates(a, acc.rows(a.relation), ctx)) {
    if (ss !== undefined) { ss.scanned++; ss.passedGen++; ss.passedEnds++; }
    const mark = trailLength(ctx.trail);
    const rowAtom: Atom = { terms: [head, ...row.terms] };
    const rowId = a.id === undefined
      ? undefined
      : hashconsTerm({ tag: "Id", atom: { terms: [SYM_ACC_ROW, head, ...row.terms] } }, ctx.store.hash);
    if (
      unifyAtoms(a.atom, rowAtom, ctx.trail, ctx.store.hash) &&
      unifyTerms(a.moment, row.moment, ctx.trail, ctx.store.hash) &&
      (a.id === undefined || unifyTerms(a.id, rowId!, ctx.trail, ctx.store.hash))
    ) {
      if (ss !== undefined) ss.passedUnify++;
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
// Head of the marker row `_acc-at r <id>` the acc handler writes at a
// moment when it computes relation r's rows there (expand.ts `SYM_ACC_AT`).
export const ACC_AT_HEAD = "_acc-at";
const SYM_ACC_ROW: Term = { tag: "Symbol", name: "*acc-row" };

// Compute a non-Term `Expr` to a Term, or `null` for relational failure
// (incomparable Max/Min args).
function evalExpr(e: Exclude<Expr, Term>, ctx: Ctx): Term | null {
  switch (e.tag) {
    case "JsCall": {
      const args = e.args.map((t) => substTerm(t, ctx.trail)); // may contain Refs
      const fn = ctx.jsFuncs.get(e.func);
      if (fn === undefined) throw new Error(`@js(${e.func} ...): undefined #js function`);
      try {
        return fn(ctx.store.hash, args);
      } catch (err) {
        throw new Error(`@js(${e.func} ...) threw: ${(err as Error).message}`);
      }
    }
    case "Max":
    case "Min": {
      const aT = substTerm(e.a, ctx.trail);
      const bT = substTerm(e.b, ctx.trail);
      // Lattice mode (store.ts "Moment lattice"): never fails — the join /
      // meet is a lattice-node moment when the args are incomparable.
      if (ctx.store.lattice) {
        return e.tag === "Max" ? latticeMax(ctx.store, aT, bT) : latticeMin(ctx.store, aT, bT);
      }
      // Incomparable args: relational failure (matches today's incomparable-
      // anchor → failed-overlap behavior). The next iteration of the outer
      // loop reaches a different candidate combination.
      if (!comparable(ctx.store, aT, bT)) return null;
      // Equal args (by hashcons token) trivially: pick aT.
      const isMax = e.tag === "Max";
      if (lessThan(ctx.store, aT, bT)) return isMax ? bT : aT;
      // aT >= bT. (lessThan(b,a) or equal.)
      return isMax ? aT : bT;
    }
  }
}

function evalEqual(
  a: Extract<RuleAtom, { tag: "Equal" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const rhs = isTermExpr(a.rhs) ? a.rhs : evalExpr(a.rhs, ctx);
  if (rhs === null) return;
  const mark = trailLength(ctx.trail);
  // unifyTerms/bindable hashconses a computed `rhs` when binding `lhs`.
  if (unifyTerms(a.lhs, rhs, ctx.trail, ctx.store.hash)) {
    next();
  }
  trailUnwind(ctx.trail, mark);
}

// Argument positions to index a Match / AccMatch on: the args ground at
// the atom's first evaluation, plus 0 for a Match whose left endpoint is
// (an acc point read: the key then picks that moment's rows only). Body order is fixed, so which args are bound
// there is the same every time (`--join-stats` masks confirm it); a later
// evaluation that finds one unground just scans (`argKey` undefined).
const argPlans = new WeakMap<Atom, number[]>();

function argPlan(atom: Atom, ctx: Ctx, l: Term | undefined): number[] {
  let plan = argPlans.get(atom);
  if (plan === undefined) {
    plan = [];
    if (l !== undefined && isGround(substTerm(l, ctx.trail))) plan.push(0);
    for (let j = 1; j < atom.terms.length; j++) {
      if (isGround(substTerm(atom.terms[j]!, ctx.trail))) plan.push(j);
    }
    argPlans.set(atom, plan);
  }
  return plan;
}

// The probe key for `plan` under the current bindings, or undefined.
function probeKey(atom: Atom, plan: number[], ctx: Ctx, l: Term | undefined): string | number | undefined {
  const ts: Term[] = [];
  for (const p of plan) if (p > 0) ts[p] = substTerm(atom.terms[p]!, ctx.trail);
  return argKey(ctx.store, ts, plan, l === undefined ? undefined : substTerm(l, ctx.trail));
}

// Stored tuples a Match must consider, in insertion order: the argument
// index bucket for its bound args, else the (head, left end) / head bucket.
function matchCandidates(a: Extract<RuleAtom, { tag: "Match" }>, head: string, ctx: Ctx): readonly number[] {
  if (ctx.store.useArgIndex) {
    const plan = argPlan(a.atom, ctx, a.l);
    if (plan.length > 0 && !(plan.length === 1 && plan[0] === 0)) {
      const key = probeKey(a.atom, plan, ctx, a.l);
      const ai = key === undefined ? undefined : argIndexFor(ctx.store, head, plan);
      if (ai !== undefined) return ai.buckets.get(key!) ?? NO_ROWS;
    }
  }
  return candidatesByHeadAt(ctx.store, head, substTerm(a.l, ctx.trail));
}

const NO_ROWS: readonly never[] = [];

// Acc rows an AccMatch must consider: the same argument index over one
// rows array (rows arrays are replaced, never mutated, so the index is
// cached per array). Small arrays are scanned.
const accRowIndexes = new WeakMap<readonly AccRow[], Map<string, Map<string | number, AccRow[]> | null>>();

function accRowCandidates(a: Extract<RuleAtom, { tag: "AccMatch" }>, rows: readonly AccRow[], ctx: Ctx): readonly AccRow[] {
  if (!ctx.store.useArgIndex || rows.length < 8) return rows;
  const plan = argPlan(a.atom, ctx, undefined);
  if (plan.length === 0) return rows;
  const key = probeKey(a.atom, plan, ctx, undefined);
  if (key === undefined) return rows;
  let byPlan = accRowIndexes.get(rows);
  if (byPlan === undefined) { byPlan = new Map(); accRowIndexes.set(rows, byPlan); }
  const pk = plan.join(",");
  let idx = byPlan.get(pk);
  if (idx === undefined) {
    let built: Map<string | number, AccRow[]> | null = new Map();
    for (const row of rows) {
      // Row term j-1 sits at atom position j (position 0 is the head).
      const k = argKey(ctx.store, [a.atom.terms[0]!, ...row.terms], plan, undefined);
      if (k === undefined) { built = null; break; }
      const b = built.get(k);
      if (b === undefined) built.set(k, [row]);
      else b.push(row);
    }
    idx = built;
    byPlan.set(pk, idx);
  }
  if (idx === null) return rows;
  return idx.get(key) ?? NO_ROWS;
}

// Join-site bookkeeping at a scan's start: which args (after the head) are
// ground under the current bindings, and whether the left endpoint is (so
// the byHeadL index applied; `l` undefined for acc rows, which have none).
function noteBound(ss: SiteStats, atom: Atom, ctx: Ctx, l: Term | undefined): void {
  let mask = "";
  for (let j = 1; j < atom.terms.length; j++) mask += isGround(substTerm(atom.terms[j]!, ctx.trail)) ? "+" : "-";
  ss.masks.set(mask, (ss.masks.get(mask) ?? 0) + 1);
  if (l !== undefined && (l.tag === "Ref" || l.tag === "Symbol")) ss.lBound++;
}

function isGround(t: Term): boolean {
  switch (t.tag) {
    case "Variable":
    case "Wildcard":
      return false;
    case "Atom":
    case "Id":
      return t.atom.terms.every(isGround);
    default:
      return true;
  }
}

function evalMatch(
  a: Extract<RuleAtom, { tag: "Match" }>,
  ctx: Ctx,
  next: () => void,
): void {
  const ss = ctx.track ? ctx.site : undefined;
  const head = headSymOf(a.atom);
  if (head === null) return;
  const it = ctx.store.iteration;
  const constraint = a.constraint ?? "any";
  const rs = ctx.ruleIdx >= 0 ? ctx.store.stats.rules[ctx.ruleIdx] : undefined;
  const hs = getOrCreateHead(ctx.store.stats, head);
  hs.scanCount++;
  // An ordinary rule's point read of an acc relation — or of `_acc-at r`,
  // the marker a `not r` read waits on (expand.ts decomposeAccRead) —
  // demands that relation's rows at its moment (store.ts `accDemand`; acc.ts computes them at
  // settle or, for an already-settled moment, from its watermark). The acc
  // read is also display bookkeeping (plans/v2-acc-timeline-display.md):
  // recorded whether or not a row matches, so the timeline can mark where a
  // relation was consulted. Acc rules read through `AccMatch`, so they
  // never land here.
  if (ctx.store.accRelations.size > 0) {
    const isAcc = ctx.store.accRelations.has(head);
    if (isAcc || head === ACC_AT_HEAD) {
      const at = substTerm(a.l, ctx.trail);
      if (at.tag !== "Variable" && at.tag !== "Wildcard") {
        const tok = tokenOf(ctx.store, at);
        const rel = isAcc ? head : a.atom.terms[1]!;
        demandAcc(ctx.store, tok, typeof rel === "string" ? rel : (rel as { name: string }).name);
        if (isAcc) {
          let seen = ctx.store.accConsulted.get(head);
          if (seen === undefined) { seen = new Set(); ctx.store.accConsulted.set(head, seen); }
          seen.add(tok);
        }
      }
    }
  }
  if (ss !== undefined) noteBound(ss, a.atom, ctx, substTerm(a.l, ctx.trail));
  // Candidate buckets list tuple indices in insertion order, so a snapshot
  // bound (acc evaluation at a watermark) ends the scan.
  const bound = ctx.bound;
  if (a.negated) {
    // `not r t̄` (expand.ts decomposeAccRead): succeed once, binding
    // nothing, iff no stored row unifies at the given endpoints.
    for (const idx of matchCandidates(a, head, ctx)) {
      if (idx >= bound) break;
      if (ss !== undefined) ss.scanned++;
      const tup = ctx.store.tuples[idx]!;
      const mark = trailLength(ctx.trail);
      const hit =
        unifyTerms(a.l, tup.l, ctx.trail, ctx.store.hash) &&
        unifyTerms(a.r, tup.r, ctx.trail, ctx.store.hash) &&
        unifyAtoms(a.atom, tup.atom, ctx.trail, ctx.store.hash);
      trailUnwind(ctx.trail, mark);
      if (hit) return;
    }
    next();
    return;
  }
  for (const idx of matchCandidates(a, head, ctx)) {
    if (idx >= bound) break;
    if (rs !== undefined) rs.candScanned++;
    if (ss !== undefined) ss.scanned++;
    const gen = ctx.store.gens[idx]!;
    if (constraint === "delta") {
      if (gen !== it - 1) continue;
    } else if (constraint === "old") {
      if (!(gen < it - 1)) continue;
    }
    if (rs !== undefined) rs.candPassedGen++;
    if (ss !== undefined) ss.passedGen++;
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
    if (ss !== undefined) ss.passedEnds++;
    if (!unifyAtoms(a.atom, tup.atom, ctx.trail, ctx.store.hash)) {
      trailUnwind(ctx.trail, mark);
      continue;
    }
    if (rs !== undefined) rs.candPassedLiteral++;
    if (rs !== undefined) rs.candPassedUnify++;
    if (ss !== undefined) ss.passedUnify++;
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
  const aTok = tokenOf(ctx.store, aT);
  const bTok = tokenOf(ctx.store, bT);
  // Strict: a match whose window would shrink to a single point fails.
  if (a.strict === true && aTok === bTok) return;
  const cone = ctx.acc?.cone;
  // Strict needs only `a ≠ b` on top of `≤`, checked above: `coneLe`
  // answers `<` for distinct moments in both modes.
  if (cone !== undefined) {
    const le = coneLe(ctx.store, cone, aTok, bTok);
    if (le !== undefined) {
      if (le) next();
      return;
    }
  }
  if (a.strict === true) {
    if (lessThan(ctx.store, aT, bT)) next();
    return;
  }
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
  // `top < x` / `x < bot` can never hold: the firing fails. Reached when the
  // anchor's left end is `top` — e.g. after `>p` on a fact, whose interval
  // never ends — and an emit tries to place a moment after it.
  const aTok = tokenOf(ctx.store, aT);
  const bTok = tokenOf(ctx.store, bT);
  if (aTok === ctx.store.topTok || bTok === ctx.store.botTok) return;
  addOrder(ctx.store, aT, bT);
  next();
}

function headSymOf(atom: Atom): string | null {
  const head = atom.terms[0];
  if (head === undefined || head.tag !== "Symbol") return null;
  return head.name;
}

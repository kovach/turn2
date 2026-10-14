// Rule bodies → continuation-passing steps (plans/v3-procedural.md).
//
// A step takes the running context (bindings and the window `(XL, XR)`)
// and a continuation, and calls the continuation once per way it succeeds,
// now or later. The window arithmetic is v2's (expand.ts `decomposeMatch` /
// `decomposeEmit`), evaluated directly instead of lowered to `Le`/`Max`/
// `AssertLt` atoms.
//
// - a store match looks up the tuples that exist and, when analyze.ts says
//   more may arrive in the rule's scope, also listens for them;
// - `#acc` reads, `not` and js relations are point reads at `XL`;
// - `+`, `^`, `~` mint moments inside the window and emit; `~>p` and `;`
//   continue after a frame's end, waiting for it to end first;
// - `?` mints choice terms and `!` records a constraint, both at `XL`;
// - `{p => e}` registers an interception context.

import type { Rule, RuleAtom } from "../v2/types.js";
import { headOf } from "./analyze.js";
import { mergeDeps, type Ctx, type Gate, type Runtime, type Tuple } from "./runtime.js";
import { compilePat, groundPat, matchArgs, matchPat, Slots, UNBOUND, type Env, type Id, type Pat } from "./terms.js";

type K = (ctx: Ctx) => void;
type Step = (ctx: Ctx, k: K) => void;

export interface CompiledRule {
  rule: Rule;
  start: () => void;
}

// Which exceptions may intercept an emit site follows v2's source-to-source
// elimination (expand.ts `applyExceptions`): exceptions are numbered in
// source order; one renames the emits of every rule without exceptions, of
// the host rules before its own, and of the right-hand sides numbered
// before it. So an emit site has a *barrier* — -1 in a rule without
// exceptions, the host's last exception number in a host rule, the
// exception's own number in a right-hand side — and exception X may
// intercept it iff X's number is above the barrier (same relation and
// arity).
interface ExnMeta {
  rel: string;
  arity: number;
}

interface Cx {
  rt: Runtime;
  slots: Slots;
  rule: Rule;
  barrier: number;
  exns: ExnMeta[];
  exnIndex: Map<RuleAtom, number>;
}

export function compileProgram(program: { rules: Rule[] }, rt: Runtime): CompiledRule[] {
  const out: CompiledRule[] = [];
  const exns: ExnMeta[] = [];
  const exnIndex = new Map<RuleAtom, number>();
  const lastExn = new Map<Rule, number>();
  const number = (body: RuleAtom[], rule: Rule) => {
    for (const a of body) {
      if (a.tag === "Sub") number(a.body, rule);
      else if (a.tag === "Exception") {
        exnIndex.set(a, exns.length);
        lastExn.set(rule, exns.length);
        exns.push({ rel: headOf(a.left), arity: a.left.terms.length - 1 });
      }
    }
  };
  for (const rule of program.rules) number(rule.body, rule);
  for (const rule of program.rules) {
    if (emitsIs(rule.body)) {
      rt.warnings.push(`rule on line ${rule.span.line}: saved v2 choice rows are ignored by v3`);
      continue;
    }
    const slots = new Slots();
    const cx: Cx = { rt, slots, rule, barrier: lastExn.get(rule) ?? -1, exns, exnIndex };
    const body = compileSeq(rule.body, cx);
    out.push({
      rule,
      start: () => body({ env: new Array(slots.size).fill(UNBOUND), xl: rt.mom.bot, xr: rt.mom.top, deps: [] }, () => {}),
    });
  }
  // Rules that start by listening go first, so every root listener exists
  // before the first tuple is emitted (a late catch-up lookup could enter a
  // frame that has already ended).
  const listensFirst = (body: RuleAtom[]): boolean => {
    const a = body[0];
    if (a === undefined) return false;
    if (a.tag === "Sub") return listensFirst(a.body);
    if (a.tag !== "Atom" || a.marker !== "match" || a.negated) return false;
    const rel = headOf(a.atom);
    return !rt.an.acc.has(rel) && !rt.an.js.has(rel);
  };
  return [...out.filter((r) => listensFirst(r.rule.body)), ...out.filter((r) => !listensFirst(r.rule.body))];
}

function emitsIs(body: RuleAtom[]): boolean {
  return body.some((a) =>
    (a.tag === "Atom" && a.marker !== "match" && a.marker !== "constrain" && a.marker !== "ask" && headOf(a.atom) === "is") ||
    (a.tag === "Sub" && emitsIs(a.body)));
}

function compileSeq(atoms: RuleAtom[], cx: Cx): Step {
  const steps = atoms.map((a) => compileAtom(a, cx));
  const n = steps.length;
  return (ctx, k) => {
    const go = (i: number, c: Ctx): void => {
      if (i === n) k(c);
      else steps[i]!(c, (c2) => go(i + 1, c2));
    };
    go(0, ctx);
  };
}

function compileAtom(a: RuleAtom, cx: Cx): Step {
  const { rt, slots, rule } = cx;
  const terms = rt.terms;
  const mom = rt.mom;
  const where = `rule on line ${rule.span.line}`;

  if (a.tag === "Equal") {
    if (a.rhs.tag === "Max" || a.rhs.tag === "Min" || a.rhs.tag === "JsCall") throw new Error(`${where}: computed '=' is internal to v2`);
    const lhs = compilePat(a.lhs, terms, slots);
    const rhs = compilePat(a.rhs, terms, slots);
    return (ctx, k) => {
      const env = ctx.env.slice();
      const r = groundPat(rhs, env, terms, rt.js.call);
      if (r !== null) {
        if (matchPat(lhs, r, env, terms)) k({ ...ctx, env });
        return;
      }
      const l = groundPat(lhs, env, terms, rt.js.call);
      if (l === null) throw new Error(`${where}: '=' with both sides unbound`);
      if (matchPat(rhs, l, env, terms)) k({ ...ctx, env });
    };
  }

  if (a.tag === "Sub") {
    const inner = compileSeq(a.body, cx);
    if (a.sequence) {
      // `( … );` continues after the group's earliest end: XL := inner XR.
      return (ctx, k) => inner(ctx, (c) => {
        if (c.xr === ctx.xr) return; // nothing ended inside: a point window
        rt.continueAt({ env: c.env, xl: c.xr, xr: ctx.xr, deps: c.deps }, k);
      });
    }
    return (ctx, k) => inner(ctx, (c) => k({ env: c.env, xl: ctx.xl, xr: ctx.xr, deps: ctx.deps }));
  }

  if (a.tag === "Exception") {
    const rel = headOf(a.left);
    const pats = a.left.terms.slice(1).map((t) => compilePat(t, terms, slots));
    const index = cx.exnIndex.get(a)!;
    const rhs = compileSeq(a.right, { ...cx, barrier: index });
    return (ctx, k) => {
      rt.addContext({ index, pats, env: ctx.env.slice(), xl: ctx.xl, xr: ctx.xr, rhs: (c) => rhs(c, () => {}) });
      k(ctx);
    };
  }

  if (a.tag !== "Atom") throw new Error(`${where}: unexpected ${a.tag} before expansion`);
  const rel = headOf(a.atom);
  const pats = a.atom.terms.slice(1).map((t) => compilePat(t, terms, slots));

  switch (a.marker) {
    case "match": {
      if (rt.an.acc.has(rel)) {
        if (a.negated) {
          return (ctx0, k) => rt.whenComplete(ctx0, (ctx) => {
            for (const row of rt.acc.rowsAt(rel, ctx.xl)) {
              if (matchArgs(pats, row.args, ctx.env.slice(), terms)) return;
            }
            k(ctx);
          });
        }
        return (ctx0, k) => rt.whenComplete(ctx0, (ctx) => {
          for (const row of rt.acc.rowsAt(rel, ctx.xl)) {
            const env = ctx.env.slice();
            if (matchArgs(pats, row.args, env, terms)) k({ ...ctx, env });
          }
        });
      }
      if (a.negated) throw new Error(`${where}: 'not ${rel}': not reads only #acc relations`);
      if (rt.an.js.has(rel)) {
        return (ctx, k) => {
          const args = pats.map((p) => groundPat(p, ctx.env, terms));
          for (const out of rt.jsRel(rel, args)) {
            const env = ctx.env.slice();
            if (matchArgs(pats, out, env, terms)) k({ ...ctx, env });
          }
        };
      }
      return compileMatch(a, rel, pats, rt);
    }
    case "fact":
    case "anchor":
    case "episode": {
      if (rel === "is") throw new Error(`${where}: 'is' rows resolve choices; a rule cannot emit 'is'`);
      const marker = a.marker;
      const after = !!a.after;
      const arity = pats.length;
      const catchers = cx.exns.flatMap((x, i) => (i > cx.barrier && x.rel === rel && x.arity === arity ? [i] : []));
      return (ctx, k) => {
        const env = ctx.env.slice();
        const args = pats.map((p) => build(p, env, rt, slots));
        const scope = rt.frameOf(ctx.xr);
        if (marker === "anchor" && ctx.xl === mom.bot) {
          // a rule-initial `^` lands on the whole running anchor
          const t: Tuple = { rel, args, l: ctx.xl, r: ctx.xr, seq: 0, frame: null, deps: ctx.deps };
          rt.emit(t, scope, catchers, (g) => k({ ...ctx, env, deps: withGate(ctx.deps, g) }));
          return;
        }
        const l = mom.fresh(ctx.xl, ctx.xr);
        if (l === null) return;
        if (marker === "fact" || marker === "anchor") {
          const t: Tuple = { rel, args, l, r: marker === "fact" ? mom.top : ctx.xr, seq: 0, frame: null, deps: ctx.deps };
          rt.emit(t, scope, catchers, (g) => k({ env, xl: l, xr: ctx.xr, deps: withGate(ctx.deps, g) }));
          return;
        }
        const r = mom.fresh(l, ctx.xr)!;
        const frame = rt.newFrame(rel, args, l, r, scope, ctx.deps);
        const t: Tuple = { rel, args, l, r, seq: 0, frame, deps: ctx.deps };
        rt.emit(t, scope, catchers, after
          ? (g) => rt.continueAt({ env, xl: r, xr: ctx.xr, deps: withGate(ctx.deps, g) }, k)
          : (g) => k({ env, xl: l, xr: r, deps: withGate(ctx.deps, g) }));
      };
    }
    case "ask": {
      const vars = a.atom.terms.map((t) => {
        if (t.tag !== "Variable") throw new Error(`${where}: '?' takes variables`);
        return { slot: slots.slot(t.name), name: t.name };
      });
      const actor = a.actor ?? "you";
      return (ctx, k) => {
        const env = ctx.env.slice();
        for (const v of vars) {
          if (env[v.slot] !== UNBOUND) throw new Error(`${where}: variable '${v.name}' is already bound at '?'`);
          env[v.slot] = rt.ask(v.name, actor, ctx.xl, ctx.deps);
        }
        k({ ...ctx, env });
      };
    }
    case "constrain": {
      const subs = (a.subAtoms ?? []).map((s) => ({
        rel: headOf(s.atom),
        pats: s.atom.terms.slice(1).map((t) => compilePat(t, terms, slots)),
        negated: !!s.negated,
      }));
      return (ctx, k) => {
        rt.constrain({ subs, env: ctx.env.slice(), moment: ctx.xl, line: a.span.line });
        k(ctx);
      };
    }
  }
}

// A stored-relation match: v2's overlap checks and window intersection, or
// for `>p` the window after `p`.
function compileMatch(
  a: Extract<RuleAtom, { tag: "Atom" }>, rel: string, pats: Pat[], rt: Runtime,
): Step {
  const terms = rt.terms;
  const mom = rt.mom;
  const info = rt.an.matches.get(a);
  const subscribe = info === undefined ? true : info.subscribe;
  const after = !!a.after;
  // A lookup that does not also listen must see everything below its
  // moment, so it waits for unfinished frames there, like an acc read.
  const step: Step = (ctx, k) => {
    const tryT = (t: Tuple): Ctx | null => {
      const env = ctx.env.slice();
      if (!matchArgs(pats, t.args, env, terms)) return null;
      if (after) {
        if (!mom.lt(t.r, ctx.xr)) return null;
        const xl = mom.max(ctx.xl, t.r);
        return xl === null ? null : { env, xl, xr: ctx.xr, deps: mergeDeps(ctx.deps, t.deps) };
      }
      if (!mom.lt(ctx.xl, t.r) || !mom.lt(t.l, ctx.xr) || !mom.lt(t.l, t.r)) return null;
      const xl = mom.max(ctx.xl, t.l);
      const xr = mom.min(ctx.xr, t.r);
      return xl === null || xr === null ? null : { env, xl, xr, deps: mergeDeps(ctx.deps, t.deps) };
    };
    const late = (c: Ctx) => {
      const f = rt.frameOf(c.xr);
      if (f.ended) rt.warnLate(f, a.span.line);
    };
    const go: K = after ? (c) => rt.continueAt(c, k) : (c) => { late(c); k(c); };
    if (subscribe) {
      rt.listen(rel, rt.frameOf(ctx.xr), (t) => {
        const c = tryT(t);
        if (c !== null) rt.enqueue(rt.frameOf(c.xr), () => go(c));
      });
    }
    const table = rt.tables.get(rel);
    if (table === undefined) return;
    const cands = table.candidates(pats, ctx.env, terms);
    const n = cands.length;
    for (let i = 0; i < n; i++) {
      const c = tryT(cands[i]!);
      if (c !== null) go(c);
    }
  };
  return subscribe ? step : (ctx, k) => rt.whenComplete(ctx, (c) => step(c, k));
}

function withGate(deps: readonly Gate[], g: Gate | null): readonly Gate[] {
  return g === null ? deps : [...deps, g];
}

// The ground term an emit writes: unbound variables become fresh objects
// (bound for the rest of the rule), `_` a fresh object each time, `@js(…)`
// a call.
function build(p: Pat, env: Env, rt: Runtime, slots: Slots): Id {
  switch (p.k) {
    case "c":
      return p.id;
    case "w":
      return rt.terms.fresh("_");
    case "v": {
      const cur = env[p.slot]!;
      if (cur !== UNBOUND) return cur;
      const id = rt.terms.fresh(slots.names[p.slot]!);
      env[p.slot] = id;
      return id;
    }
    case "a":
      return rt.terms.app(p.args.map((q) => build(q, env, rt, slots)));
    case "js":
      return rt.js.call(p.fn, p.args.map((q) => build(q, env, rt, slots)));
  }
}

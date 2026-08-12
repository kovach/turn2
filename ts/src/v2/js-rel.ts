// js relations (`#js-def`, plans/v2-js-relations.md): mode selection and
// clause compilation.
//
// A js relation is a set of generator clauses over the same name/arity,
// each with a mode vector (`+` = argument bound at call, handed to the JS
// body as a parameter; `-` = enumerated, yielded by the body). A match atom
// on a js relation lowers to a `JsIterate` IR atom (expand.ts); this module
// resolves which clause each call site uses.
//
// Modes are ordered `- < +`, lifted pointwise. A `-` clause position can
// always serve a bound argument (yield, then unification filters), so the
// call site picks the *earliest declared* clause whose mode vector is ≤ the
// call's — where a call position is `+` iff its argument term is ground or
// all its variables are bound by the atoms to its left. That needs a
// left-to-right binding analysis, run on the *post-split* flat bodies
// (between `filtered` and the delta variants in expandStages): a consumer
// slice's leading Match unifies the stored row's trailing idTpl, so chain
// variables recovered across a split correctly count as bound.

import type { Term } from "./term.js";
import type { JsRelDef, Rule, RuleAtom } from "./types.js";

// Safety net for runaway generators: with no tuple emitted between yields
// there is no gas check to interrupt an infinite `for(;;) yield [..]`, which
// would hang the browser editor. Generous enough for any real enumeration.
export const JS_REL_YIELD_CAP = 1_000_000;

// A compiled clause: the mode vector plus the generator, taking the decoded
// `+`-position argument values (in `+`-position order) and yielding arrays
// of the `-`-position values (in `-`-position order).
export interface CompiledJsRel {
  modes: ("+" | "-")[];
  gen: (...bound: unknown[]) => Iterable<unknown[]>;
}

// The generator-function constructor (`function*` bodies have no direct
// `new Function` form).
const GeneratorFunction = Object.getPrototypeOf(function* () {})
  .constructor as new (...args: string[]) => (...xs: unknown[]) => Iterable<unknown[]>;

// Compile each clause once (before the fixpoint), mirroring `compileJsDefs`
// in eval.ts. A malformed body throws here (a syntax error from the
// generator constructor), surfaced with the relation name.
export function compileJsRels(jsRels: Map<string, JsRelDef[]>): Map<string, CompiledJsRel[]> {
  const m = new Map<string, CompiledJsRel[]>();
  for (const [name, clauses] of jsRels) {
    const compiled: CompiledJsRel[] = [];
    for (const c of clauses) {
      const boundParams = c.params.filter((p) => p.mode === "+").map((p) => p.name);
      let gen: (...xs: unknown[]) => Iterable<unknown[]>;
      try {
        gen = new GeneratorFunction(...boundParams, c.body);
      } catch (e) {
        throw new Error(`#js-def ${name}: ${(e as Error).message}`);
      }
      compiled.push({ modes: c.params.map((p) => p.mode), gen });
    }
    m.set(name, compiled);
  }
  return m;
}

// ----- Mode selection -----

// Variable names in `t`, excluding the anonymous `_`.
function collectVars(t: Term, out: Set<string>): void {
  if (t.tag === "Variable") {
    if (t.name !== "_") out.add(t.name);
  } else if (t.tag === "Atom" || t.tag === "Id") {
    for (const x of t.atom.terms) collectVars(x, out);
  }
}

// True iff `t` is ground or every Variable in it is in `bound`. A Wildcard
// (and the anonymous `_`) is never bound. A compound with any unbound part
// counts unbound — the generator can't receive a partial term; the bound
// parts are still checked by unification against the yielded value.
function allBound(t: Term, bound: Set<string>): boolean {
  switch (t.tag) {
    case "Symbol":
    case "Ref":
      return true;
    case "Variable":
      return t.name !== "_" && bound.has(t.name);
    case "Wildcard":
      return false;
    case "Atom":
    case "Id":
      return t.atom.terms.every((x) => allBound(x, bound));
  }
}

// Resolve `defIndex` on every `JsIterate` atom via left-to-right binding
// analysis. Rules without a JsIterate pass through untouched. Throws on a
// call site no clause can serve.
export function resolveJsModes(rules: Rule[], jsRels: Map<string, JsRelDef[]>): Rule[] {
  if (jsRels.size === 0) return rules;
  return rules.map((r) => (r.body.some((a) => a.tag === "JsIterate") ? resolveRule(r, jsRels) : r));
}

function resolveRule(rule: Rule, jsRels: Map<string, JsRelDef[]>): Rule {
  const bound = new Set<string>();
  const add = (t: Term): void => collectVars(t, bound);
  const body = rule.body.map((a: RuleAtom): RuleAtom => {
    switch (a.tag) {
      case "Match":
      case "Emit":
        // Match binds everything it mentions by unification (including
        // chain Variables inside the trailing idTpl — the cross-split
        // recovery). Emit's terms are ground at emit time by invariant.
        for (const t of a.atom.terms) add(t);
        add(a.l);
        add(a.r);
        return a;
      case "Equal": {
        // A fully-bound side determines the other. Both-sides-partial
        // binds nothing (conservative: under-approximating boundness only
        // ever selects a more general `-` clause, never a wrong `+` one).
        const okL = allBound(a.lhs, bound);
        const okR = allBound(a.rhs, bound);
        if (okR) add(a.lhs);
        if (okL) add(a.rhs);
        return a;
      }
      case "JsCall":
        add(a.out); // args were checked bound at lowering
        return a;
      case "Max":
      case "Min":
        add(a.out);
        return a;
      case "Le":
      case "AssertLt":
        return a;
      case "JsIterate": {
        const clauses = jsRels.get(a.func);
        if (clauses === undefined) {
          throw new Error(`internal: js relation '${a.func}' has no #js-def clauses`);
        }
        const call = a.args.map((t) => (allBound(t, bound) ? "+" : "-"));
        const idx = clauses.findIndex((c) =>
          c.params.every((p, i) => p.mode === "-" || call[i] === "+"),
        );
        if (idx < 0) {
          throw new Error(
            `rule '${rule.name}': no '#js-def ${a.func}' clause matches modes (${call.join(" ")}) ` +
            `(a '+' parameter requires the argument to be bound by earlier atoms)`,
          );
        }
        for (const t of a.args) add(t); // every arg is bound after the atom
        return { ...a, defIndex: idx };
      }
      case "Atom":
      case "Sub":
      case "Exception":
      case "AggComp":
        // Pre-expand kinds shouldn't reach this pass. Pass through.
        return a;
    }
  });
  return { ...rule, body };
}

// Backward-pass chain-liveness optimization for decomposed rule bodies.
//
// Each fresh-* template (`*id`, `*mom`, `*choose`) snapshots `state.chain`
// at construction time. A chain entry is droppable only if it's both
// non-essential (does not carry per-firing identity) and dead (not
// referenced by any later atom). The essential set is supplied by
// `decomposeRule` and contains the names whose values distinguish
// firings of the rule (user Variables and endpoint slots `_l_K` /
// `_r_K`); everything else in the chain (anchor SSA `_xl_K` / `_xr_K`,
// minted only by match intersections) is a pure reduction of other
// entries.
//
// The universal `emitIdTpl` doubles as a per-firing dedup fingerprint on
// stored rows, so essential entries must stay in chains regardless of
// downstream liveness — otherwise two distinct firings could collide on
// the same row id and dedup would coalesce them.
//
// Run between `decomposeRule` and `splitRule`. After pruning, the producer
// and consumer halves of a split rule share the same (smaller) idTpl term
// objects, so structural unification on idTpl still recovers chain Vars —
// just minus the redundant ones.

import type { Term } from "./term.js";
import type { Rule, RuleAtom } from "./types.js";

// Recursively rewrite a term: chain Variables inside any `*chain`-headed
// Id sub-term that aren't essential or live get filtered out. `*`-headed
// compounds are reserved for the compiler (parser rejects user-written
// ones), so finding `(*chain ...)` is unambiguous regardless of which
// outer fresh-* template wraps it.
function rewriteTerm(t: Term, live: Set<string>, essential: Set<string>): Term {
  if (t.tag !== "Atom" && t.tag !== "Id") return t;
  const inner = t.atom.terms.map((x) => rewriteTerm(x, live, essential));
  const head = inner[0];
  if (t.tag === "Id" && head !== undefined && head.tag === "Symbol" && head.name === "*chain") {
    const filtered = inner.slice(1).filter((v) => {
      if (v.tag !== "Variable") return true;
      return essential.has(v.name) || live.has(v.name);
    });
    return { tag: "Id", atom: { terms: [head, ...filtered] } };
  }
  return { tag: t.tag, atom: { terms: inner } };
}

function collectVars(t: Term, out: Set<string>): void {
  if (t.tag === "Variable") out.add(t.name);
  else if (t.tag === "Atom" || t.tag === "Id") {
    for (const x of t.atom.terms) collectVars(x, out);
  }
}

function rewriteAtom(a: RuleAtom, live: Set<string>, essential: Set<string>): RuleAtom {
  const rw = (t: Term) => rewriteTerm(t, live, essential);
  switch (a.tag) {
    case "Match":
    case "Emit":
      return { ...a, atom: { terms: a.atom.terms.map(rw) }, l: rw(a.l), r: rw(a.r) };
    case "Equal":
      return { ...a, lhs: rw(a.lhs), rhs: rw(a.rhs) };
    case "Max":
    case "Min":
      return { ...a, a: rw(a.a), b: rw(a.b), out: rw(a.out) };
    case "Le":
    case "AssertLt":
      return { ...a, a: rw(a.a), b: rw(a.b) };
    case "JsCall":
      return { ...a, args: a.args.map(rw), out: rw(a.out) };
    case "Atom":
    case "Sub":
    case "Exception":
    case "AggComp":
      // Pre-expand kinds shouldn't reach this pass. Pass through unchanged.
      return a;
  }
}

function addUses(a: RuleAtom, live: Set<string>): void {
  switch (a.tag) {
    case "Match":
    case "Emit":
      for (const t of a.atom.terms) collectVars(t, live);
      collectVars(a.l, live); collectVars(a.r, live);
      break;
    case "Equal":
      collectVars(a.lhs, live); collectVars(a.rhs, live);
      break;
    case "Max":
    case "Min":
      collectVars(a.a, live); collectVars(a.b, live); collectVars(a.out, live);
      break;
    case "Le":
    case "AssertLt":
      collectVars(a.a, live); collectVars(a.b, live);
      break;
    case "JsCall":
      for (const t of a.args) collectVars(t, live);
      collectVars(a.out, live);
      break;
    case "Atom":
    case "Sub":
    case "Exception":
    case "AggComp":
      break;
  }
}

// Max/Min `out` is freshly defined here; in decomposed output it's always
// a non-essential anchor SSA Variable. If `out` isn't essential and not
// live downstream, the atom is pure dead code. Equal is left alone (may
// be a user constraint, not a binding).
function definedVar(a: RuleAtom, essential: Set<string>): string | null {
  switch (a.tag) {
    case "Max":
    case "Min":
      if (a.out.tag !== "Variable") return null;
      return essential.has(a.out.name) ? null : a.out.name;
    default:
      return null;
  }
}

export function pruneChains(rule: Rule, essential: Set<string>): Rule {
  const live = new Set<string>();
  const reversed: RuleAtom[] = [];
  for (let i = rule.body.length - 1; i >= 0; i--) {
    const a = rule.body[i]!;
    const def = definedVar(a, essential);
    if (def !== null && !live.has(def)) continue;
    const pruned = rewriteAtom(a, live, essential);
    reversed.push(pruned);
    addUses(pruned, live);
  }
  return { ...rule, body: reversed.reverse() };
}

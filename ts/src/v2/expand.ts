// Rule splitting at weighted matches.
//
// A rule containing a weighted match `foo X -> N` splits into:
//   - producer: prefix + `^ _do-agg <aggIdVar> (foo X)`
//   - consumer: prefix + `_do-agg <aggIdVar> (foo X)` + `_agg-result <aggIdVar> N` + suffix
//
// `aggIdVar` is a synthesized Variable; both rules carry the *original* rule
// name so their prefix runs produce identical fresh-ids (mom/id) and dedupe.
// The producer emits the row with marker "anchor" so its interval equals the
// firing's anchor at the split point — that interval is what the scheduler
// uses for ordering and for the aggregate's contribution-set query.
//
// Multiple weighted matches: split is iterative — after the first split the
// consumer may itself contain a weighted match; recurse.

import type { Atom, Term } from "../types.js";
import type { Program, Rule, RuleAtom } from "./types.js";

export function expand(program: Program): Program {
  const rules: Rule[] = [];
  for (const rule of program.rules) {
    rules.push(...splitRule(rule));
  }
  for (const rule of rules) assignIds(rule);
  return { rules, schema: program.schema };
}

// Walk the rule body in pre-order, assigning each Atom a static `id` record:
//
//   id.l, id.r : Variable("_l_<lexPos>"), Variable("_r_<lexPos>") — slots
//                that the evaluator binds in `subst`. For matches, bound to
//                the matched tuple's endpoints; for asserts/asks/constrains,
//                bound to the constructed l, r the atom emits.
//   id.chain   : `(*id <ruleName> <lexPos> V1 V2 ... Vk)` template, where
//                V1..Vk are Variable references to every slot in scope
//                *before* this atom: the l/r slots of earlier atoms, plus
//                user-named variables introduced by earlier atoms.
//                `instantiate(id.chain, ctx)` at eval time grounds the
//                template into a per-firing fingerprint.
//
// `lexPos` is a 1-based counter incremented per Atom in pre-order. Subs do
// not occupy their own lexPos but their inner atoms continue the count.
// Walking the *expanded* rule list ensures synthesized atoms (`^ do-agg`,
// `do-agg` match, `agg-result` match) get stable lexPos values too.
//
// Because matches contribute their `_l_k` / `_r_k` slots to the chain, every
// subsequent atom's freshIdTerm / freshChooseId / freshMoment depends on
// the exact tuples this rule firing matched — not just on user-named
// variable bindings. That's what stops chooseIds from collapsing across
// distinct turns when the only thing distinguishing the firings is which
// `turn` row was matched.
function assignIds(rule: Rule): void {
  const ruleName = rule.name;
  let lexPos = 0;
  const chain: Term[] = [];
  const seen = new Set<string>();

  function pushVar(name: string): void {
    if (name === "_") return;
    if (seen.has(name)) return;
    seen.add(name);
    chain.push({ tag: "Variable", name });
  }

  function collectVars(t: Term): void {
    if (t.tag === "Variable") { pushVar(t.name); return; }
    if (t.tag === "Atom" || t.tag === "Id") {
      for (const x of t.atom.terms) collectVars(x);
    }
  }

  function walk(body: RuleAtom[]): void {
    for (const a of body) {
      if (a.tag === "Sub") {
        walk(a.body);
        continue;
      }
      if (a.tag === "Equal") {
        // No lexPos / id slot for Equal — but its lhs/rhs may introduce
        // user variables that subsequent atoms' id.chain templates need to
        // see. Collect them into the running chain so downstream *id /
        // *choose / *mom fingerprints depend on those bindings.
        collectVars(a.lhs);
        collectVars(a.rhs);
        continue;
      }
      lexPos++;
      const lName = "_l_" + String(lexPos);
      const rName = "_r_" + String(lexPos);
      const lVar: Term = { tag: "Variable", name: lName };
      const rVar: Term = { tag: "Variable", name: rName };
      // Snapshot chain *before* this atom contributes its own slots/vars.
      const chainTerms: Term[] = [
        { tag: "Symbol", name: "*id" },
        { tag: "Symbol", name: ruleName },
        { tag: "Symbol", name: String(lexPos) },
        ...chain,
      ];
      a.id = {
        l: lVar,
        r: rVar,
        // Id-tagged: the chain template names a fresh per-firing identity,
        // not data. See notes/v2-design.md (id-opacity invariant).
        chain: { tag: "Id", atom: { terms: chainTerms } },
      };
      // Atom contributes its l, r slots first, then any user vars.
      seen.add(lName);
      chain.push(lVar);
      seen.add(rName);
      chain.push(rVar);
      for (const t of a.atom.terms) collectVars(t);
      if (a.weight !== undefined) collectVars(a.weight);
      if (a.lLit !== undefined) collectVars(a.lLit);
      if (a.rLit !== undefined) collectVars(a.rLit);
    }
  }

  walk(rule.body);
}

function splitRule(rule: Rule): Rule[] {
  const path = findFirstWeightedMatch(rule.body);
  if (path === null) return [rule];
  const wm = atPath(rule.body, path);
  if (wm.tag !== "Atom") throw new Error("unreachable");
  if (wm.weight === undefined) throw new Error("unreachable");

  const aggVarName = `_aggId_${path.join("_")}`;
  const aggIdVar: Term = { tag: "Variable", name: aggVarName };

  // The wrapped pattern includes the weight position. Variables that the
  // prefix (everything lexically before the weighted match — including
  // surrounding sub-rule prefixes) doesn't bind become aggregation free
  // variables and are replaced by the reserved `_free` Symbol; the scheduler
  // treats those positions as wildcards and groups contributions by their
  // distinct values.
  const boundByPrefix = new Set<string>();
  collectBoundVarsBeforePath(rule.body, path, boundByPrefix);
  const freeSym: Term = { tag: "Symbol", name: "_free" };
  const freeify = (t: Term): Term => {
    if (t.tag === "Variable") {
      if (t.name !== "_" && boundByPrefix.has(t.name)) return t;
      return freeSym;
    }
    if (t.tag === "Wildcard") return freeSym;
    if (t.tag === "Atom" || t.tag === "Id") {
      return { tag: t.tag, atom: { terms: t.atom.terms.map(freeify) } };
    }
    return t;
  };
  // Weight position is the *output* of aggregation, not a filter on
  // contributions. Always leave it free in the do-agg pattern; the consumer's
  // agg-result match (originalPatternAtom) enforces equality against any
  // user-written literal weight.
  const wrappedFreeTerms: Term[] = [...wm.atom.terms.map(freeify), freeSym];
  const wrappedFreeAtom: Term = { tag: "Atom", atom: { terms: wrappedFreeTerms } };
  // Consumer's agg-result match keeps the original variable names so they
  // bind from each emitted agg-result row.
  const originalPatternAtom: Term = {
    tag: "Atom",
    atom: { terms: [...wm.atom.terms, wm.weight] },
  };

  const symDoAgg: Term = { tag: "Symbol", name: "_do-agg" };
  const symAggResult: Term = { tag: "Symbol", name: "_agg-result" };

  const producerEmit: RuleAtom = {
    tag: "Atom",
    marker: "anchor",
    atom: { terms: [symDoAgg, aggIdVar, wrappedFreeAtom] },
    span: wm.span,
  };

  const consumerDoAgg: RuleAtom = {
    tag: "Atom",
    marker: "match",
    atom: { terms: [symDoAgg, aggIdVar, wrappedFreeAtom] },
    span: wm.span,
  };

  const consumerAggResult: RuleAtom = {
    tag: "Atom",
    marker: "match",
    atom: { terms: [symAggResult, aggIdVar, originalPatternAtom] },
    span: wm.span,
  };

  const producerBody = buildProducerBody(rule.body, path, producerEmit);
  const consumerBody = buildConsumerBody(rule.body, path, consumerDoAgg, consumerAggResult);

  const producerRule: Rule = {
    name: rule.name,
    body: producerBody,
    span: rule.span,
  };

  const consumerRule: Rule = {
    name: rule.name,
    body: consumerBody,
    span: rule.span,
  };

  return [producerRule, ...splitRule(consumerRule)];
}

// Path of indices into nested Sub bodies locating the first weighted match,
// or null if none. `[i]` is a top-level position; `[i, j, ...]` walks into
// `body[i]` (a Sub), then its body[j], etc.
type WMPath = number[];

function findFirstWeightedMatch(body: RuleAtom[]): WMPath | null {
  for (let i = 0; i < body.length; i++) {
    const a = body[i]!;
    if (a.tag === "Atom" && a.marker === "match" && a.weight !== undefined) return [i];
    if (a.tag === "Sub") {
      const inner = findFirstWeightedMatch(a.body);
      if (inner !== null) return [i, ...inner];
    }
  }
  return null;
}

function atPath(body: RuleAtom[], path: WMPath): RuleAtom {
  const head = body[path[0]!]!;
  if (path.length === 1) return head;
  if (head.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  return atPath(head.body, path.slice(1));
}

// Producer rule body: everything lexically before the weighted match, plus
// the producer-emit at the weighted match's position. Anything after is
// dropped — the producer's job is just to emit the do-agg row.
function buildProducerBody(body: RuleAtom[], path: WMPath, emit: RuleAtom): RuleAtom[] {
  const i = path[0]!;
  if (path.length === 1) return [...body.slice(0, i), emit];
  const sub = body[i]!;
  if (sub.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  const innerProducer = buildProducerBody(sub.body, path.slice(1), emit);
  const newSub: RuleAtom = { ...sub, body: innerProducer };
  return [...body.slice(0, i), newSub];
}

// Consumer rule body: same shape as the original, with the weighted-match
// position replaced by [do-agg-match, agg-result-match]. Everything after
// (within the same Sub level and at outer levels) is preserved.
function buildConsumerBody(
  body: RuleAtom[],
  path: WMPath,
  doAgg: RuleAtom,
  aggResult: RuleAtom,
): RuleAtom[] {
  const i = path[0]!;
  if (path.length === 1) {
    return [...body.slice(0, i), doAgg, aggResult, ...body.slice(i + 1)];
  }
  const sub = body[i]!;
  if (sub.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  const innerConsumer = buildConsumerBody(sub.body, path.slice(1), doAgg, aggResult);
  const newSub: RuleAtom = { ...sub, body: innerConsumer };
  return [...body.slice(0, i), newSub, ...body.slice(i + 1)];
}

// Variables bound by the rule body at any position lexically *before* `path`,
// including matches in surrounding sub-rule prefixes.
function collectBoundVarsBeforePath(body: RuleAtom[], path: WMPath, out: Set<string>): void {
  const i = path[0]!;
  // Everything strictly before index i at this level contributes.
  collectBoundVarsInBody(body.slice(0, i), out);
  if (path.length === 1) return;
  const sub = body[i]!;
  if (sub.tag !== "Sub") throw new Error("unreachable: path expected Sub");
  collectBoundVarsBeforePath(sub.body, path.slice(1), out);
}

// Variables introduced anywhere in `body` (including nested sub-rules and
// equality atoms). Used by splitRule to decide which positions in a weighted
// match's pattern are the aggregation's free variables.
function collectBoundVarsInBody(body: RuleAtom[], out: Set<string>): void {
  function visitTerm(t: Term): void {
    if (t.tag === "Variable") { if (t.name !== "_") out.add(t.name); return; }
    if (t.tag === "Atom" || t.tag === "Id") for (const x of t.atom.terms) visitTerm(x);
  }
  for (const a of body) {
    if (a.tag === "Sub") { collectBoundVarsInBody(a.body, out); continue; }
    if (a.tag === "Equal") { visitTerm(a.lhs); visitTerm(a.rhs); continue; }
    for (const t of a.atom.terms) visitTerm(t);
    if (a.weight !== undefined) visitTerm(a.weight);
    if (a.lLit !== undefined) visitTerm(a.lLit);
    if (a.rLit !== undefined) visitTerm(a.rLit);
  }
}


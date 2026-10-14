// `#js` functions and `#js-def` relations over interned terms. Same value
// mapping as v2 (js-values.ts): compounds ⇄ arrays, integer symbols →
// numbers, string literals → their value, other symbols → strings, fresh and
// choice ids → their printed name.

import type { Program } from "../v2/types.js";
import { compileJsRels, type CompiledJsRel } from "../v2/js-rel.js";
import { encodeTerm } from "../v2/js-values.js";
import { stringValue, type Term } from "../v2/term.js";
import { SYM, type Id, type Terms } from "./terms.js";

export function decode(id: Id, terms: Terms): unknown {
  const a = terms.args[id];
  if (a !== null && a !== undefined) return a.map((x) => decode(x, terms));
  const name = terms.name[id]!;
  if (terms.kind[id] !== SYM) return name;
  return stringValue({ tag: "Symbol", name }) ?? (/^-?\d+$/.test(name) ? Number(name) : name);
}

export function termToId(t: Term, terms: Terms): Id {
  if (t.tag === "Symbol") return terms.sym(t.name);
  if (t.tag === "Atom") return terms.app(t.atom.terms.map((x) => termToId(x, terms)));
  throw new Error(`v3: cannot intern a ${t.tag} term`);
}

export function encode(v: unknown, terms: Terms): Id {
  return termToId(encodeTerm(v), terms);
}

export interface JsEnv {
  call(fn: string, args: Id[]): Id;
  rels: Map<string, CompiledJsRel[]>;
}

export function compileJs(program: Program, terms: Terms): JsEnv {
  const fns = new Map<string, (...xs: unknown[]) => unknown>();
  for (const [name, d] of program.jsDefs) {
    try {
      fns.set(name, new Function(...d.params, d.body) as (...xs: unknown[]) => unknown);
    } catch (e) {
      throw new Error(`#js ${name}: ${(e as Error).message}`);
    }
  }
  return {
    call(fn, args) {
      const f = fns.get(fn);
      if (f === undefined) throw new Error(`v3: unknown #js function '${fn}'`);
      return encode(f(...args.map((a) => decode(a, terms))), terms);
    },
    rels: compileJsRels(program.jsRels),
  };
}

// Run a js relation: pick the first clause whose `+` positions are all
// bound (`bound[i]`), and yield the full argument vectors it produces (a
// bound `-` position is checked by the caller's match).
export function* runJsRel(
  name: string, clauses: CompiledJsRel[], args: (Id | null)[], terms: Terms,
): Generator<Id[]> {
  const clause = clauses.find((c) => c.modes.every((m, i) => m === "-" || args[i] !== null));
  if (clause === undefined) {
    const modes = args.map((a) => (a === null ? "-" : "+")).join("");
    throw new Error(`v3: js relation '${name}' has no clause for modes ${modes}`);
  }
  const plus: unknown[] = [];
  clause.modes.forEach((m, i) => { if (m === "+") plus.push(decode(args[i]!, terms)); });
  let n = 0;
  for (const y of clause.gen(...plus)) {
    if (++n > 100000) throw new Error(`v3: js relation '${name}' yielded too many rows`);
    const out: Id[] = [];
    let yi = 0;
    for (let i = 0; i < clause.modes.length; i++) {
      out.push(clause.modes[i] === "+" ? args[i]! : encode((y as unknown[])[yi++], terms));
    }
    yield out;
  }
}

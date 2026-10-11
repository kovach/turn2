// Built-in relations, available to every program without a declaration.
//
// The numeric comparisons `lt` / `gt` / `le` / `ge` are js relations
// (plans/v2-js-relations.md) with a single `+A +B` clause: both arguments
// must be bound at the call site (the mode pass rejects an unbound one with
// its usual error), and the atom succeeds — yielding once, binding nothing —
// iff the comparison holds. Being js relations gives them exactly the
// semantics a comparison wants: timeless (no anchor effect), re-checked per
// firing, legal inside `!(...)` as an option filter, and rejected as an emit
// head, an exception LHS, or a `[ ... ]` query item.
//
// Numbers are the language's numeric Symbols (`3`, `-7`), which decodeTerm
// (js-values.ts) hands the body as JS numbers; anything else — a name, a
// compound, a Peano nat — is a runtime error naming the relation.
//
// `parseProgram` seeds `Program.jsRels` from `builtinJsRels()` and rejects a
// user declaration of the same name (`#js-def`, `#js`, `#acc`).

import type { JsRelDef } from "./types.js";

const COMPARISONS: ReadonlyArray<readonly [name: string, op: string]> = [
  ["lt", "<"],
  ["gt", ">"],
  ["le", "<="],
  ["ge", ">="],
];

const BUILTIN_REL_NAMES: ReadonlySet<string> = new Set(COMPARISONS.map(([n]) => n));

export function isBuiltinRel(name: string): boolean {
  return BUILTIN_REL_NAMES.has(name);
}

function comparisonBody(op: string): string {
  return (
    `if (typeof A !== "number" || typeof B !== "number") ` +
    `throw new Error("arguments must be numbers (got " + JSON.stringify(A) + " and " + JSON.stringify(B) + ")");\n` +
    `if (A ${op} B) yield [];`
  );
}

// A fresh map per program: `parseProgram` pushes user clauses into the arrays
// it holds, so they must not be shared.
export function builtinJsRels(): Map<string, JsRelDef[]> {
  const m = new Map<string, JsRelDef[]>();
  for (const [name, op] of COMPARISONS) {
    m.set(name, [{
      name,
      params: [{ mode: "+", name: "A" }, { mode: "+", name: "B" }],
      body: comparisonBody(op),
      span: { line: 0 },
      builtin: true,
    }]);
  }
  return m;
}

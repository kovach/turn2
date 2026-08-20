// Dead-choice resolution: an earliest-tier choice component with zero
// option tuples is complete (temporal monotonicity) — its active terms
// are marked `_dead-choice`, the owning asks stop blocking, and their
// continuations never fire.

import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Term } from "../v2/term.js";
import { expandTerm } from "../v2/hashcons.js";
import type { Store } from "../v2/store.js";
import type { Program } from "../v2/types.js";

function ok(input: string): Program {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function renderTerm(store: Store, term: Term): string {
  const t = term.tag === "Ref" ? expandTerm(term, store.hash) : term;
  switch (t.tag) {
    case "Symbol": return t.name;
    case "Variable": return `?${t.name}`;
    case "Wildcard": return "_";
    case "Ref": return `*${t.id}`;
    case "Atom":
    case "Id":
      return `(${t.atom.terms.map((x) => renderTerm(store, x)).join(" ")})`;
  }
}

function heads(store: Store): string[] {
  return store.tuples.map((t) => {
    const h = t.atom.terms[0];
    return h !== undefined && h.tag === "Symbol" ? h.name : "?";
  });
}

// 1) A `you` choice constrained by a relation with no facts: zero options,
//    the choice dies, the run completes, and no `is` row ever appears —
//    so `.is`-gated follow-up rules never fire.
{
  const src = `
+ turn

turn
  ? X
  !nope X
  ~chose X

chose.is V, ~acted V
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  const hs = heads(store);
  assert(hs.includes("_dead-choice"), "expected a _dead-choice marker row");
  assert(!hs.includes("is"), "a dead choice must not get an is row");
  assert(!hs.includes("acted"), ".is-gated follow-up must not fire for a dead choice");
  console.log("PASS: zero-option choice dies; run completes; .is follow-up never fires");
}

// 2) Control: the same shape with a satisfiable constraint still surfaces.
{
  const src = `
+ opt a, + turn

turn
  ? X
  !opt X
  ~chose X
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  console.log("PASS: satisfiable choice still surfaces");
}

// 3) Entangled empty component: two asks joined by one unsatisfiable
//    constrain block die together.
{
  const src = `
+ turn

turn
  ? A
  ? B
  !(nope A B)
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  assert.equal(heads(store).filter((h) => h === "_dead-choice").length, 2,
    "both entangled terms must be marked dead");
  console.log("PASS: entangled zero-option component dies together");
}

// 4) Mixed: the empty component dies, an independent live choice still
//    surfaces with its options.
{
  const src = `
+ opt a, + turn

turn
  ? X
  !nope X

turn
  ? Y
  !opt Y
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.components.length, 1, "only the live component surfaces");
  const opts = status.components[0]!.options.map((o) => o.map((t) => renderTerm(store, t)).join(","));
  assert.deepEqual(opts, ["a"], `got: ${opts.join(" | ")}`);
  console.log("PASS: dead component doesn't block an independent live choice");
}

// 5) The program keeps running past a dead choice: a sibling rule on the
//    same trigger still completes its work.
{
  const src = `
+ turn

turn
  ? X
  !nope X

turn, ~after
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  assert(heads(store).includes("after"), "sibling rule must still run");
  console.log("PASS: run proceeds past a dead choice");
}

// 6) An empty rng component dies too (previously it surfaced as an
//    unresolvable active choice).
{
  const src = `
+ turn

turn
  ?[rng] C
  !nope C
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  console.log("PASS: empty rng component dies instead of surfacing");
}

// 7) Interplay with js relations in `!(...)`: a generator that yields
//    nothing produces a zero-option component, which dies.
{
  const src = `#js-def range +Lo +Hi -I {
  for (let i = Lo; i < Hi; i++) yield [i];
}
+ turn

turn
  ? N
  !(range 1 1 N)
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "done", `status: ${status.kind}`);
  assert(heads(store).includes("_dead-choice"), "expected a _dead-choice marker row");
  console.log("PASS: empty js-relation enumeration dies cleanly");
}

// 8) Empty-fringe is still an error, not a death: an unconstrained `?`
//    (no constrain rows at all) reports empty-fringe-error.
{
  const src = `
+ turn

turn
  ? X
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "empty-fringe-error", `status: ${status.kind}`);
  console.log("PASS: unconstrained ask still reports empty-fringe-error");
}

console.log("v2_dead_choice: all tests passed");

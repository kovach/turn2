import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Atom, Term } from "../types.js";
import type { Store } from "../v2/store.js";
import { expandTerm } from "../hashcons.js";

function ok(input: string) {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function renderAtom(store: Store, atom: Atom): string {
  return atom.terms.map((t) => renderTerm(store, t)).join(" ");
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

function listTuples(store: Store): string[] {
  return store.tuples.map((t) => renderAtom(store, t.atom));
}

// 1) `?` lowers to a choose row; reaching it produces exactly one row.
{
  const src = `
+ turn

turn
? C
+ cell-choice C
`;
  const { store, status } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  const chooseRows = tuples.filter((t) => t.startsWith("_choose "));
  assert.equal(chooseRows.length, 1, `expected 1 _choose row, got: ${chooseRows.join(" | ")}`);
  // Without a constrain row this fails the empty-fringe check; the
  // cell-choice row is still emitted by the inner loop before the scheduler
  // surfaces the error.
  const cc = tuples.filter((t) => t.startsWith("cell-choice"));
  assert.equal(cc.length, 1, `expected 1 cell-choice, got: ${cc.join(" | ")}`);
  assert.equal(status.kind, "empty-fringe-error", `status: ${status.kind}`);
  console.log("PASS: ? without ! reports empty-fringe-error");
}

// 2) `!` lowers to a constrain row.
{
  const src = `
+ a
a
! foo bar
`;
  const { store } = runFixpoint(ok(src));
  const tuples = listTuples(store);
  const cs = tuples.filter((t) => t.startsWith("_constrain"));
  assert.equal(cs.length, 1, `expected 1 _constrain row, got: ${cs.join(" | ")}`);
  // Shape: "_constrain (foo bar)"
  assert(cs[0]!.includes("(foo bar)"), `expected wrapped (foo bar), got: ${cs[0]}`);
  console.log("PASS: ! emits one _constrain row");
}

// 3) Choice + constraint surfaces an active-choices status.
{
  const src = `
+ cell c1
+ cell c2
+ turn

turn
? C
! cell C
`;
  const { status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices");
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.choices.length, 1, "expected 1 active choose");
  console.log("PASS: ? + ! surfaces active-choices");
}

// 4) Resolution: a downstream rule that explicitly matches `is C V` blocks
//    until the harness writes `+ is <freshId> <value>`, then unblocks and
//    produces a tuple containing the resolved value.
{
  // Phase 1: run once to discover the active fresh-id for C.
  const phase1 = `
+ cell c1
+ turn

turn
? C
! cell C
+ cell-choice C

cell-choice C
is C V
+ resolved V
`;
  const r1 = runFixpoint(ok(phase1));
  assert.equal(r1.status.kind, "active-choices");
  if (r1.status.kind !== "active-choices") throw new Error("unreachable");
  const choice = r1.status.choices[0]!;
  assert.equal(choice.activeTerms.length, 1);
  // Pre-resolution: cell-choice exists with the fresh-id as its arg, but
  // `resolved` does not yet exist (the second rule is blocked at `is C V`).
  const r1tuples = listTuples(r1.store);
  assert(
    r1tuples.some((t) => t.startsWith("cell-choice ")),
    `expected cell-choice <freshId>, got: ${r1tuples.join(" | ")}`,
  );
  assert(
    !r1tuples.some((t) => t === "resolved c1"),
    "did not expect 'resolved c1' before is-row",
  );

  // Phase 2: append the harness's resolution row and re-run. The `^` marker
  // makes the row's interval = the rule's initial anchor (bot, top), so it
  // is moment-comparable to every other tuple — `is` is conceptually a
  // timeless meta-relation.
  const activeText = renderTerm(r1.store, choice.activeTerms[0]!);
  const phase2 = phase1 + `\n^ is ${activeText} c1\n`;
  const r2 = runFixpoint(ok(phase2));
  assert.equal(r2.status.kind, "done", `phase2 status: ${r2.status.kind}`);
  const tuples = listTuples(r2.store);
  assert(
    tuples.some((t) => t === "resolved c1"),
    `expected 'resolved c1', got: ${tuples.filter((t) => t.startsWith("resolved")).join(" | ")}`,
  );
  console.log("PASS: is-resolution unblocks downstream rule");
}

console.log("ALL v2 choice tests passed");

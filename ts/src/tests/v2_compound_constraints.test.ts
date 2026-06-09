import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { expand } from "../v2/expand.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Atom, Term } from "../v2/term.js";
import type { Store } from "../v2/store.js";
import { expandTerm } from "../v2/hashcons.js";

function ok(input: string) {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function expectParseError(input: string): { line: number; message: string } {
  const p = parse(input);
  if (!("message" in p)) throw new Error("expected parse error, got program");
  return p;
}

function renderAtom(store: Store, atom: Atom): string {
  const ts = atom.terms.length > 0 ? atom.terms.slice(0, -1) : atom.terms;
  return ts.map((t) => renderTerm(store, t)).join(" ");
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

function optionSet(store: Store, options: Term[][]): Set<string> {
  return new Set(options.map((opt) => opt.map((t) => renderTerm(store, t)).join(",")));
}

// 1) Shared existential joins two sub-atoms. With `prop` and `link` facts
//    laid down, only pairs (A, B) for which there exists an X with
//    `prop A X` and `link X B` should appear as options. (Kept small —
//    many sibling facts at the root run into the moment-ordering
//    limitation that's orthogonal to this feature.)
{
  const src = `
+ prop a 10
+ prop b 20
+ link 10 x
+ link 20 y
+ turn

turn
? A
? B
!(prop A X, link X B)
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.components.length, 1, "expected one component");
  const opts = optionSet(store, status.components[0]!.options);
  assert.deepEqual([...opts].sort(), ["a,x", "b,y"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: shared existential joins two sub-atoms");
}

// 2) Two rules that each name `Y` inside their own `!(...)` block bind to
//    the same `?X` active term. The existential `Y`s must NOT capture each
//    other: each block is independent. We construct a case where capture
//    would forbid all options but block-scoping yields one.
{
  // All `+` facts go in ONE rule (no blank lines) so AssertLt orders
  // them; separate rules at the root have incomparable moments (see
  // v2_store test 4). The two `!(...)` rules below come *after* the
  // fact block.
  //
  // Item 'a' has p1 a 1 / p2 1 (first rule's Y=1) AND p3 a 2 / p4 2
  // (second rule's Y=2). If Ys captured each other across rules, no
  // single Y would satisfy both blocks — options would be empty.
  // Block-scoping keeps them independent so 'a' qualifies. Item 'b'
  // has p1 b 9 / p3 b 8 but no matching p2 9 or p4 8, so it never
  // qualifies.
  const src = `
+ item a, + item b, + p1 a 1, + p2 1, + p3 a 2, + p4 2, + p1 b 9, + p3 b 8, + turn

turn
? X
~ it X

it A, !(p1 A Y, p2 Y)
it B, !(p3 B Y, p4 Y)
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  assert.equal(status.components.length, 1, "expected one component");
  const opts = optionSet(store, status.components[0]!.options);
  // 'a' has p1 a 1 / p2 1 (first rule's Y=1) AND p3 a 2 / p4 2 (second
  // rule's Y=2). If Ys were shared we'd need a single value satisfying
  // both — none exists — so options would be empty. Block-scoping keeps
  // them independent and 'a' qualifies.
  assert.deepEqual([...opts].sort(), ["a"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: cross-rule existential Y does not capture across `!(...)` blocks");
}

// 3) Reject outer weight on a `!(...)` block.
{
  const err = expectParseError(`
+ turn
turn, ? X, !(foo X) -> bar
`);
  assert.match(err.message, /outer '-> weight'/);
  console.log("PASS: `!(...) -> w` rejected at parse");
}

// 4) Empty `!()` rejected.
{
  const err = expectParseError(`
+ turn
turn, ? X, !()
`);
  assert.match(err.message, /must contain at least one sub-atom/);
  console.log("PASS: `!()` rejected at parse");
}

// 5) Sub-atom with a marker rejected.
{
  const err = expectParseError(`
+ turn
turn, ? X, !(foo X, ?Y)
`);
  assert.match(err.message, /cannot carry a marker/);
  console.log("PASS: marker inside `!(...)` rejected at parse");
}

// 6) Variable first introduced inside `!(...)` and then mentioned outside
//    the block is an expand-time error.
{
  const program = parse(`
+ turn
turn, ? A, !(foo A Y), bar Y
`);
  if ("message" in program) throw new Error(`parse error: ${program.message}`);
  let threw = false;
  try {
    expand(program);
  } catch (e) {
    threw = true;
    assert.match(
      String((e as Error).message),
      /existential/i,
      `expected existential error, got: ${(e as Error).message}`,
    );
  }
  assert.ok(threw, "expected expand to throw on existential used outside block");
  console.log("PASS: var first introduced inside `!(...)` cannot be referenced outside");
}

// 7) Shorthand `!foo` produces identical IR to `!(foo)` — same row count
//    and shape (single `(*conj (*c-plain ...))` wrapper).
{
  const longSrc = `
+ item a
+ turn

turn, ? C, !(item C)
`;
  const shortSrc = `
+ item a
+ turn

turn, ? C, !item C
`;
  const { store: storeLong } = runFixpoint(ok(longSrc));
  const { store: storeShort } = runFixpoint(ok(shortSrc));
  const long = listTuples(storeLong).filter((t) => t.startsWith("_constrain "));
  const short = listTuples(storeShort).filter((t) => t.startsWith("_constrain "));
  assert.equal(long.length, 1);
  assert.equal(short.length, 1);
  // Both should contain (*conj (*c-plain ...)) at the same nesting.
  assert.ok(long[0]!.includes("(*c-plain"), `long: ${long[0]}`);
  assert.ok(short[0]!.includes("(*c-plain"), `short: ${short[0]}`);
  console.log("PASS: `!foo` and `!(foo)` produce equivalent compound IR");
}

// 8) Mixed plain + aggregate sub-atoms: `!(foo X, score X -> W)`. The
//    existential X is shared between the plain match and the aggregate
//    sub. Options surface bindings for both ?A and ?W.
{
  const src = `
#agg score key -> sum

+ foo a, + score a 5, + score a 7, + foo b, + score b 3, + turn

turn
? A
? W
!(foo A, score A -> W)
`;
  const { store, status } = runFixpoint(ok(src));
  assert.equal(status.kind, "active-choices", `status: ${status.kind}`);
  if (status.kind !== "active-choices") throw new Error("unreachable");
  const opts = optionSet(store, status.components[0]!.options);
  // foo a, score a sum = 12; foo b, score b sum = 3.
  assert.deepEqual([...opts].sort(), ["a,12", "b,3"], `got: ${[...opts].join(" | ")}`);
  console.log("PASS: mixed plain + aggregate sub-atoms with shared existential");
}

console.log("ALL v2 compound-constraint tests passed");

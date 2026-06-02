import assert from "node:assert/strict";
import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import type { Atom, Term } from "../types.js";
import { expandTerm } from "../hashcons.js";
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

function renderAtom(store: Store, atom: Atom): string {
  const ts = atom.terms.length > 0 ? atom.terms.slice(0, -1) : atom.terms;
  return ts.map((t) => renderTerm(store, t)).join(" ");
}

function listTuples(store: Store): string[] {
  return store.tuples.map((t) => renderAtom(store, t.atom));
}

// 1) #js parses into Program.jsDefs (body indented, `}` at column 0).
{
  const p = ok(`
#js (div x y) {
  return Math.round(x / y);
}
#js (inc x) {
  return x + 1;
}
`);
  assert(p.jsDefs.has("div"), "div not registered");
  assert.deepEqual(p.jsDefs.get("div")!.params, ["x", "y"]);
  assert.match(p.jsDefs.get("div")!.body, /Math\.round/);
  assert.deepEqual(p.jsDefs.get("inc")!.params, ["x"]);
  console.log("PASS: #js parses into jsDefs");
}

// 2) @js(...) parses to Atom([*js, name, ...args]).
{
  const p = ok(`
#js (div x y) {
  return x;
}

n X
+ foo @js(div X 4)
`);
  const fact = p.rules[0]!.body.find(
    (a) => a.tag === "Atom" && a.marker === "fact",
  );
  assert(fact !== undefined && fact.tag === "Atom", "no fact atom");
  const arg = fact.atom.terms[1]!;
  assert(arg.tag === "Atom", "arg not an Atom");
  const head = arg.atom.terms[0]!;
  assert(head.tag === "Symbol" && head.name === "*js", "missing *js head");
  const name = arg.atom.terms[1]!;
  assert(name.tag === "Symbol" && name.name === "div", "wrong fn name");
  console.log("PASS: @js parses to *js term");
}

// 3) End-to-end: div over a bound numeric symbol.
{
  const { store } = runFixpoint(ok(`
#js (div x y) {
  return Math.round(x / y);
}

+ n 8

n X
+ foo @js(div X 4)
`));
  assert(listTuples(store).includes("foo 2"), `expected 'foo 2': ${listTuples(store)}`);
  console.log("PASS: div end-to-end");
}

// 4) Same-atom binding: X bound by an earlier term of the same atom.
{
  const { store } = runFixpoint(ok(`
#js (inc x) {
  return x + 1;
}

+ n 5

n X
+ foo X @js(inc X)
`));
  assert(listTuples(store).includes("foo 5 6"), `expected 'foo 5 6': ${listTuples(store)}`);
  console.log("PASS: same-atom binding");
}

// 5) Nested calls.
{
  const { store } = runFixpoint(ok(`
#js (inc x) {
  return x + 1;
}
#js (dbl x) {
  return x * 2;
}

+ n 3

n X
+ foo @js(dbl @js(inc X))
`));
  assert(listTuples(store).includes("foo 8"), `expected 'foo 8': ${listTuples(store)}`);
  console.log("PASS: nested @js");
}

// 6) Compound round-trip (compound <-> array, symbols <-> strings).
{
  const { store } = runFixpoint(ok(`
#js (swap p) {
  return [p[0], p[2], p[1]];
}

+ data (pair a b)

data P
+ out @js(swap P)
`));
  assert(listTuples(store).includes("out (pair b a)"), `expected 'out (pair b a)': ${listTuples(store)}`);
  console.log("PASS: compound round-trip");
}

// 7) Ref argument decodes (arg bound to a hashconsed compound).
//    (Covered by test 6 — `P` binds to a hashconsed `(pair a b)` Ref.)
{
  console.log("PASS: Ref arg decode (via test 6)");
}

// 8) Boolean return encodes to 0 / 1.
{
  const { store } = runFixpoint(ok(`
#js (gt x y) {
  return x > y;
}

+ n 5

n X
+ b @js(gt X 3)
+ c @js(gt X 9)
`));
  const tuples = listTuples(store);
  assert(tuples.includes("b 1"), `expected 'b 1': ${tuples}`);
  assert(tuples.includes("c 0"), `expected 'c 0': ${tuples}`);
  console.log("PASS: boolean -> 0/1");
}

// 8b) Params may be any JS identifier (uppercase allowed).
{
  const { store } = runFixpoint(ok(`
#js (by4 X) {
  return Math.floor(X / 4);
}

+ n 9

n V
+ q @js(by4 V)
`));
  assert(listTuples(store).includes("q 2"), `expected 'q 2': ${listTuples(store)}`);
  console.log("PASS: uppercase param");
}

// 8c) Arbitrary braces in the body (strings, templates, nested) are fine —
//     we never count braces, only require the closing `}` at column 0.
{
  const { store } = runFixpoint(ok(`
#js (by4 x) {
  let y = "{";
  if (x > 0) {
    return Math.floor(x / 4);
  }
  return 0;
}

+ n 9

n V
+ q @js(by4 V)
`));
  assert(listTuples(store).includes("q 2"), `expected 'q 2' (braces in body): ${listTuples(store)}`);
}
{
  const { store } = runFixpoint(ok(`
#js (lbl x) {
  return \`<\${x}> }}}\`;
}

+ n a

n V
+ q @js(lbl V)
`));
  assert(listTuples(store).includes("q <a> }}}"), `expected template result: ${listTuples(store)}`);
  console.log("PASS: braces in string/template/nested body");
}

// 8d) One-liner form: `}` is the last char on the line.
{
  const { store } = runFixpoint(ok(`
#js (inc x) { return x + 1; }

+ n 7

n V
+ q @js(inc V)
`));
  assert(listTuples(store).includes("q 8"), `expected 'q 8' (one-liner): ${listTuples(store)}`);
}
{
  // `}` inside a string on a one-liner: body runs to the *last* `}`.
  const { store } = runFixpoint(ok(`
#js (rb x) { return "}"; }

+ n a

n V
+ q @js(rb V)
`));
  assert(listTuples(store).includes("q }"), `expected 'q }' (string brace one-liner): ${listTuples(store)}`);
  console.log("PASS: one-liner form");
}

// 9) Errors.
function fails(src: string, re: RegExp, label: string): void {
  assert.throws(() => runFixpoint(ok(src)), re, label);
  console.log(`PASS: error - ${label}`);
}

fails(
  `#js (div x y) {\n  return x;\n}\n\nn X\n+ foo @js(div X)`,
  /expects 2 argument/,
  "arity mismatch",
);
fails(
  `n X\n+ foo @js(nope X)`,
  /undefined #js function/,
  "unknown function",
);
fails(
  `#js (f x) {\n  return x;\n}\n\n+ foo @js(f X)`,
  /not bound before this use/,
  "unbound variable",
);
fails(
  `#js (bad x) {\n  return x +++ ;\n}\n\n+ foo @js(bad a)`,
  /#js bad/,
  "malformed body",
);
fails(
  `#js (boom x) {\n  throw new Error("kaboom");\n}\n\n+ foo @js(boom a)`,
  /threw: kaboom/,
  "body throws at runtime",
);
fails(
  `#js (obj x) {\n  return {a: 1};\n}\n\n+ foo @js(obj a)`,
  /cannot encode return value of type object/,
  "unsupported return type",
);

// 10) @js rejected outside positive emit atoms (e.g. in a match).
fails(
  `#js (f x) {\n  return x;\n}\n\n+ n a\n\nn @js(f a)\n+ ok`,
  /only allowed in/,
  "@js in match rejected",
);

// 11) Syntax errors specific to the body-form rules.
fails(
  `#js (f x) { return x;\n\n+ ok`,
  /close with '}' on the same line/,
  "open brace with trailing non-} content",
);
fails(
  `#js (f x) {\nreturn x;\n}\n\n+ ok`,
  /must be indented/,
  "unindented body rejected",
);
fails(
  `#js (f x) {\n  return x;`,
  /missing a closing/,
  "missing closing brace",
);

console.log("all v2_js tests passed");

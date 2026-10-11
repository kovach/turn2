import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../v2/parse.js";
import type { Program, Rule, RuleAtom } from "../v2/types.js";
import { exprTerms } from "../v2/types.js";
import type { Term } from "../v2/term.js";

// Alpha-equivalence over parser-output rule bodies: same structure
// up to a consistent bijection on Variable names. Symbols, Wildcards,
// markers, Sub sequence flags, and term shapes must
// match exactly; only Variable.name is allowed to differ (consistently).
function alphaEqualBody(a: RuleAtom[], b: RuleAtom[]): boolean {
  return walkBody(a, b, new Map(), new Map());
}

function walkBody(a: RuleAtom[], b: RuleAtom[], ab: Map<string, string>, ba: Map<string, string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!walkRA(a[i]!, b[i]!, ab, ba)) return false;
  return true;
}

function walkRA(a: RuleAtom, b: RuleAtom, ab: Map<string, string>, ba: Map<string, string>): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "Atom" && b.tag === "Atom") {
    if (a.marker !== b.marker) return false;
    if (!walkTerms(a.atom.terms, b.atom.terms, ab, ba)) return false;
    return a.negated === b.negated;
  }
  if (a.tag === "Sub" && b.tag === "Sub") {
    if (a.sequence !== b.sequence) return false;
    return walkBody(a.body, b.body, ab, ba);
  }
  if (a.tag === "Equal" && b.tag === "Equal") {
    const ra = exprTerms(a.rhs), rb = exprTerms(b.rhs);
    return a.rhs.tag === b.rhs.tag && ra.length === rb.length &&
      walkTerm(a.lhs, b.lhs, ab, ba) && ra.every((t, i) => walkTerm(t, rb[i]!, ab, ba));
  }
  return false;
}

function walkTerms(a: Term[], b: Term[], ab: Map<string, string>, ba: Map<string, string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!walkTerm(a[i]!, b[i]!, ab, ba)) return false;
  return true;
}

function walkTerm(a: Term, b: Term, ab: Map<string, string>, ba: Map<string, string>): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "Symbol" && b.tag === "Symbol") return a.name === b.name;
  if (a.tag === "Wildcard" && b.tag === "Wildcard") return true;
  if (a.tag === "Variable" && b.tag === "Variable") {
    const mappedA = ab.get(a.name);
    const mappedB = ba.get(b.name);
    if (mappedA !== undefined && mappedA !== b.name) return false;
    if (mappedB !== undefined && mappedB !== a.name) return false;
    ab.set(a.name, b.name);
    ba.set(b.name, a.name);
    return true;
  }
  if ((a.tag === "Atom" || a.tag === "Id") && a.tag === b.tag) {
    return walkTerms(a.atom.terms, (b as typeof a).atom.terms, ab, ba);
  }
  return false;
}

// Parse two programs and assert their rule bodies are alpha-equivalent
// rule-for-rule. Fails loudly when the parser silently drops content
// (lengths mismatch) or produces a structurally different shape.
function assertAlpha(dotForm: string, refForm: string, label: string): void {
  const a = parse(dotForm);
  const b = parse(refForm);
  if ("message" in a) throw new Error(`${label}: dot-form parse error: ${a.message}`);
  if ("message" in b) throw new Error(`${label}: ref-form parse error: ${b.message}`);
  assert.equal(a.rules.length, b.rules.length, `${label}: rule count`);
  for (let i = 0; i < a.rules.length; i++) {
    const ok = alphaEqualBody(a.rules[i]!.body, b.rules[i]!.body);
    assert(
      ok,
      `${label}: rule ${i} not alpha-equivalent\n  dot:  ${JSON.stringify(a.rules[i]!.body)}\n  ref:  ${JSON.stringify(b.rules[i]!.body)}`,
    );
  }
}

const __dir = dirname(fileURLToPath(import.meta.url));

function ok(input: string): Program {
  const p = parse(input);
  assert(!("message" in p), `parse error: ${JSON.stringify(p)}`);
  return p;
}

function atom(a: RuleAtom): Extract<RuleAtom, { tag: "Atom" }> {
  if (a.tag !== "Atom") throw new Error(`expected Atom, got ${a.tag}`);
  return a;
}

function sub(a: RuleAtom): Extract<RuleAtom, { tag: "Sub" }> {
  if (a.tag !== "Sub") throw new Error(`expected Sub, got ${a.tag}`);
  return a;
}

// 1) basic match-only rule
{
  const p = ok("play-card E\n  it E Card\n  ~ move Card play-area\n");
  assert.equal(p.rules.length, 1);
  const r = p.rules[0]!;
  assert.equal(r.body.length, 3);
  assert.equal(atom(r.body[0]!).marker, "match");
  assert.deepEqual(atom(r.body[0]!).atom.terms, [
    { tag: "Symbol", name: "play-card" },
    { tag: "Variable", name: "E" },
  ]);
  assert.equal(atom(r.body[2]!).marker, "episode");
  console.log("PASS: basic match + episode rule");
}

// 2) comma-separated equivalence
{
  const a = ok("play-card E\n  it E Card\n  ~ move Card play-area\n");
  const b = ok("play-card E, it E Card, ~ move Card play-area\n");
  assert.equal(a.rules.length, b.rules.length);
  assert.equal(a.rules[0]!.body.length, b.rules[0]!.body.length);
  for (let i = 0; i < 3; i++) {
    assert.equal(atom(a.rules[0]!.body[i]!).marker, atom(b.rules[0]!.body[i]!).marker);
  }
  console.log("PASS: newline and comma are equivalent");
}

// 3) offside rule separation: column-0 starts a rule, indentation continues
{
  const p = ok("foo\n\nbar\n");
  assert.equal(p.rules.length, 2);
  const q = ok("foo\nbar\n");
  assert.equal(q.rules.length, 2);
  const r = ok("foo, x\n  y\n\n  z\n");
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0]!.body.length, 4);
  console.log("PASS: offside rule separation");
}

// 4) sub-rule with sequence
{
  const p = ok("foo\n  ( ~ e1 );\n  ~ e2\n");
  assert.equal(p.rules.length, 1);
  const r = p.rules[0]!;
  assert.equal(r.body.length, 3);
  const s = sub(r.body[1]!);
  assert.equal(s.sequence, true);
  assert.equal(s.body.length, 1);
  assert.equal(atom(s.body[0]!).marker, "episode");
  assert.equal(atom(r.body[2]!).marker, "episode");
  console.log("PASS: sub-rule with sequencing");
}

// 5) sub-rule plain
{
  const p = ok("foo\n  ( bar X )\n  + baz X\n");
  const r = p.rules[0]!;
  const s = sub(r.body[1]!);
  assert.equal(s.sequence, false);
  assert.equal(s.body.length, 1);
  console.log("PASS: plain sub-rule");
}

// 6–8) Removed aggregation forms (plans/v2-caret-fresh-left.md §5.4):
// `-> weight` (assert, match, `!`), `#agg`, `#reactive`, `#macro` and bracket
// aggregation are parse errors pointing at `#acc`.
{
  const removed = (src: string, what: RegExp, line = 1): void => {
    const e = err(src);
    assert.match(e.message, what, src);
    assert.match(e.message, /was removed: aggregation is '#acc'/, src);
    assert.equal(e.line, line, src);
  };
  removed("+ points -> 3\n", /'-> weight'/);
  removed("points -> N\n", /'-> weight'/);
  removed("foo X, !(bar X -> W)\n", /'-> weight'/);
  removed("#agg points -> sum\n", /'#agg'/);
  removed("#reactive points -> sum\n", /'#reactive'/);
  removed("#macro m X := [p X | count X]\n", /'#macro'/);
  removed("foo X, [ p X Y | count Y ]\n", /bracket aggregation/);
  console.log("PASS: removed aggregation forms are migration errors");
}

// 8b) `not` prefixes a plain read; it is reserved otherwise.
{
  const p = ok("foo X, not bar X\n");
  const a = atom(p.rules[0]!.body[1]!);
  assert.equal(a.marker, "match");
  assert.equal(a.negated, true);
  assert.deepEqual(a.atom.terms[0], { tag: "Symbol", name: "bar" });
  assert.match(err("foo, +not bar\n").message, /'not' only prefixes a plain read/);
  assert.match(err("foo, not\n").message, /'not' is reserved/);
  console.log("PASS: not read");
}

// 9) compound term
{
  const p = ok("foo (bar X) Y\n");
  const a = atom(p.rules[0]!.body[0]!);
  assert.equal(a.atom.terms.length, 3);
  const inner = a.atom.terms[1]!;
  assert(inner.tag === "Atom");
  assert.deepEqual(inner.atom.terms, [
    { tag: "Symbol", name: "bar" },
    { tag: "Variable", name: "X" },
  ]);
  console.log("PASS: compound term in atom");
}

// 9b) #def names a rule
{
  const p = ok("#def activate\nfoo X\n  + bar X\n");
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0]!.name, "activate");
  assert.equal(p.rules[0]!.explicitName, "activate");
  console.log("PASS: #def names a rule");
}

// 9b2) #def allows rule body to begin on the same line
{
  const p = ok("#def a ~a\n");
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0]!.name, "a");
  assert.equal(p.rules[0]!.body.length, 1);
  console.log("PASS: #def same-line body");
}

// 9c) unnamed rules keep r{N} by source position; named coexist
{
  const p = ok("foo\n\n#def named\nbar\n\nbaz\n");
  assert.equal(p.rules.length, 3);
  assert.equal(p.rules[0]!.name, "r1");
  assert.equal(p.rules[1]!.name, "named");
  assert.equal(p.rules[2]!.name, "r3");
  console.log("PASS: #def positional auto-names");
}

// 9d) duplicate #def names → parse error
{
  const e = err("#def foo\nbar\n\n#def foo\nbaz\n");
  assert.match(e.message, /duplicate rule name 'foo'/);
  console.log("PASS: duplicate #def rejected");
}

// 9e) reserved-shape #def names
{
  assert.match(err("#def r3\nbar\n").message, /reserved for auto-naming/);
  assert.match(err("#def _foo\nbar\n").message, /lowercase symbol/);
  assert.match(err("#def Foo\nbar\n").message, /lowercase symbol/);
  assert.match(err("#def\nbar\n").message, /requires a rule name/);
  console.log("PASS: #def name shape checks");
}

// 9f) #def with no following rule → error
{
  assert.match(err("#def foo\n").message, /must precede a rule/);
  console.log("PASS: dangling #def rejected");
}

// 9g) unknown command
{
  assert.match(err("#xyz blah\nfoo\n").message, /unknown command '#xyz'/);
  console.log("PASS: unknown # command rejected");
}

// 10) wildcard and underscore variable
{
  const p = ok("foo _ _bar\n");
  const a = atom(p.rules[0]!.body[0]!);
  assert.deepEqual(a.atom.terms, [
    { tag: "Symbol", name: "foo" },
    { tag: "Wildcard" },
    { tag: "Variable", name: "_bar" },
  ]);
  console.log("PASS: wildcard and underscore variable");
}

// 11) the activate example with sub-rules — one rule
{
  const src = `
activate A
  it A call-to-guard
  target A T

  ( ~ gather G
    it G X
    to G To
    ! dahan X
    + is To T )

  ( at D T
    dahan D
    ~ defend D1
    it D1 I
    amount D1 A
    + is I T
    + is A 1 )
`;
  const p = ok(src);
  assert.equal(p.rules.length, 1, `expected 1 rule, got ${p.rules.length}`);
  const r = p.rules[0]!;
  assert.equal(r.body.length, 5);
  assert.equal(sub(r.body[3]!).body.length, 5);
  assert.equal(sub(r.body[4]!).body.length, 7);
  console.log("PASS: activate example as one rule");
}

// 12) tutorial program: the historical notes file still uses `#agg` (line
// 138), now a migration error; everything before that parses.
{
  const src = readFileSync(join(__dir, "..", "..", "..", "notes", "turn-program-1.t"), "utf8");
  const p = parse(src);
  assert("message" in p, "notes/turn-program-1.t still uses '#agg'; expected the migration error");
  assert.equal(p.line, 138);
  assert.match(p.message, /'#agg' was removed/);
  const head = parse(src.split("\n").slice(0, 137).join("\n"));
  if ("message" in head) {
    throw new Error(`tutorial parse error at line ${head.line}: ${head.message}`);
  }
  assert(head.rules.length > 0);
  console.log(`PASS: tutorial program parses up to its '#agg' section (${head.rules.length} rules)`);
}

// ---- dot-notation desugaring (plans/v2-dot-notation.md) ----
//
// Each test parses both a dot-form program and a hand-written reference
// (comma-form) program, then asserts their rule bodies are
// alpha-equivalent. Markers, weights, Sub structure, and term shapes
// must match exactly; only Variable names may differ (consistently).
// Caveat: if the parser silently dropped *all* dot content from both
// sides equally, these would still pass. Length checks below guard
// against that for the main examples.

function err(input: string): { line: number; message: string } {
  const p = parse(input);
  assert("message" in p, `expected parse error for ${JSON.stringify(input)}, got program`);
  return p as { line: number; message: string };
}

// Spaced dot, basic
assertAlpha(
  "foo X . bar y Z\n",
  "foo X T, bar T y Z\n",
  "dot — spaced basic",
);

// Negated read on the right
assertAlpha(
  "player . not score S\n",
  "player T, not score T S\n",
  "dot — not on right",
);

// Leading-dot chain
assertAlpha(
  "player .hand .top-card C\n",
  "player T1, hand T1 T2, top-card T2 C\n",
  "dot — leading-dot chain",
);
// And a body-length sanity check (alpha-eq alone wouldn't catch a
// silently-empty-on-both-sides parser).
assert.equal(ok("player .hand .top-card C\n").rules[0]!.body.length, 3);

// Glued vs spaced
assertAlpha(
  "player.hand.top-card C\n",
  "player .hand .top-card C\n",
  "dot — glued matches spaced",
);

// Counter resets across rules
assertAlpha(
  "foo X . bar Y\n\nbaz . qux\n",
  "foo X T, bar T Y\n\nbaz U, qux U\n",
  "dot — counter resets across rules",
);

// Sibling-sub sharing — single outer fresh var threaded into both subs
assertAlpha(
  "turn .(actor A) .(index I)\n",
  "turn T, (actor T A), (index T I)\n",
  "dot — sibling subs share fresh var",
);

// Nested dot inside sub, then continue
assertAlpha(
  "turn .(actor.name N) .foo F\n",
  "turn T, (actor T A, name A N), foo T F\n",
  "dot — nested sub then continue",
);

// Name-collision avoidance: user wrote _dot1 already, so the fresh
// var must be a *different* name. Alpha-eq lets us write the ref
// with a clean name; the important guard is that the dot-form's two
// occurrences of the fresh var are bound to the same name.
assertAlpha(
  "foo X _dot1 . bar Y\n",
  "foo X _dot1 T, bar T Y\n",
  "dot — fresh names avoid user-written _dotN",
);
// Also: the generated name must not equal the user's _dot1.
{
  const p = ok("foo X _dot1 . bar Y\n");
  const t0 = atom(p.rules[0]!.body[0]!).atom.terms;
  const last = t0[t0.length - 1]!;
  assert(last.tag === "Variable" && last.name !== "_dot1", "generated var collided with _dot1");
}

// Dot inside Sub body
assertAlpha(
  "(player . score)\n",
  "(player T, score T)\n",
  "dot — desugar inside Sub",
);

// Markers must survive desugaring — only term lists change.
assertAlpha(
  "~foo . bar Y\n",
  "~foo T, bar T Y\n",
  "dot — episode marker on left",
);
assertAlpha(
  "foo . + bar Y\n",
  "foo T, + bar T Y\n",
  "dot — fact marker on right",
);
assertAlpha(
  "~foo.bar.~baz\n",
  "~foo T1, bar T1 T2, ~baz T2\n",
  "dot — glued mixed-marker chain ~foo.bar.~baz",
);
// Ask atoms are excluded here: `?` accepts only fresh variables
// (plans/v2-choice-actors.md), so a symbol-headed `? baz X` no longer
// parses and dotting into an ask is meaningless.
assertAlpha(
  "^foo . ! bar . baz X\n",
  "^foo T1, ! bar T1 T2, baz T2 X\n",
  "dot — anchor/constrain markers preserved",
);
assertAlpha(
  "turn .(~ actor A) .(+ index I)\n",
  "turn T, (~ actor T A), (+ index T I)\n",
  "dot — marker-tagged atoms inside sibling subs share fresh var",
);

// A lone variable on the left of a dot is the value to thread, not an atom
// to match, whatever marker the right side carries.
assertAlpha(
  "x A, A.a:b.b:c C\n",
  "x A, a:b A T, b:c T C\n",
  "dot — lone variable on left",
);
assertAlpha(
  "A.a:b.b:c C\n",
  "a:b A T, b:c T C\n",
  "dot — lone unbound variable on left binds through the right atom",
);
assertAlpha(
  "x A, A.^p k, A.~q k, A.!r, A.+s k\n",
  "x A, ^p A k, ~q A k, !r A, +s A k\n",
  "dot — lone variable on left, every right-side marker",
);
assertAlpha(
  "x A, A.(a:b B).(a:b B2).b:c C\n",
  "x A, (a:b A B), (a:b A B2), b:c A C\n",
  "dot — lone variable into sibling subs",
);
assertAlpha(
  "T X . p\n",
  "T X V, p V\n",
  "dot — variable head with arguments is still an atom",
);

// Errors — kept as direct ParseError checks.
{
  assert.match(err(". bar\n").message, /dot must follow an atom/);
  assert.match(err("x A, A . . bar\n").message, /consecutive/);
  assert.match(err("x A, A .\n").message, /trailing '\.'/);
  assert.match(err("foo X . = a b\n").message, /right of '\.'/);
  assert.match(err("foo X . . bar\n").message, /consecutive/);
  assert.match(err("foo -> W . bar\n").message, /'-> weight' was removed/);
  assert.match(err("foo X .\n").message, /trailing '\.'/);
  assert.match(err("foo . ()\n").message, /empty sub-block/);
  assert.match(err("(. bar)\n").message, /dot must follow an atom/);
  console.log("PASS: dot — errors");
}

// Sanity: alpha-equivalence rejects a real structural mismatch (so
// the helper itself isn't trivially passing everything).
{
  const a = ok("foo X . bar Y\n");
  const b = ok("foo X, bar Y\n"); // missing the threaded var
  assert(!alphaEqualBody(a.rules[0]!.body, b.rules[0]!.body), "alphaEqualBody false-positive");
  console.log("PASS: dot — alpha-equivalence helper rejects mismatches");
}

// Bare-semicolon syntax: `a; b` wraps the left into a sequence sub.
assertAlpha(
  "a; b\n",
  "(a); b\n",
  "semi — single",
);
assertAlpha(
  "a; b; c\n",
  "((a); b); c\n",
  "semi — chained left-associative",
);
// Line-local scoping: first-line content stays outside the wrap.
assertAlpha(
  "foo\n  b; c\n",
  "foo, (b); c\n",
  "semi — local to current line",
);
assertAlpha(
  "(a; b)\n",
  "((a); b)\n",
  "semi — inside parens",
);
assertAlpha(
  "a, b; c\n",
  "(a, b); c\n",
  "semi — comma does not reset wrap",
);
// Spot-check the produced shape: outer body should have one
// sequence sub followed by one plain atom.
{
  const r = ok("a; b\n").rules[0]!;
  assert.equal(r.body.length, 2, "semi — body length");
  assert.equal(r.body[0]!.tag, "Sub");
  assert.equal((r.body[0] as Extract<RuleAtom, { tag: "Sub" }>).sequence, true);
  assert.equal(r.body[1]!.tag, "Atom");
  console.log("PASS: semi — sequence flag set on wrap");
}

// Errors.
{
  assert.match(err("; a\n").message, /no content on this line/);
  assert.match(err("a; ;\n").message, /no content on this line/);
  assert.match(err("foo.;\n").message, /';' after '\.'/);
  assert.match(err("(;)\n").message, /no content on this line/);
  console.log("PASS: semi — errors");
}

console.log("ALL v2 parse tests passed");

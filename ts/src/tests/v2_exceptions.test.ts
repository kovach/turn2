// Tests for the exceptions transform (plans/v2-exceptions.md, amended by
// plans/v2-exception-watchers.md): `{p t1..tn => e}` desugars, before
// expansion, into a p→p' rename plus watcher/exception/default rules gated
// by a bool flag relation. The host rule only broadcasts its context
// (`anchor p_ctx U..`) — it never matches p', so exceptions don't gate
// `;` progression and their LHS vars are local.
//
// Tests 12–14 are characterization tests for the temporal questions
// recorded in the plan ("maybe issues" item 3): they assert the hard
// per-tuple mutual-exclusion invariant and LOG the actual behavior
// (CHAR: lines) for later iteration.

import assert from "node:assert/strict";
import { parse, type ParseError } from "../v2/parse.js";
import { applyExceptions } from "../v2/expand.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { renderRuleAtom } from "../v2/print-ir.js";
import type { Atom, Term } from "../v2/term.js";
import { expandTerm } from "../v2/hashcons.js";
import type { Store } from "../v2/store.js";
import type { Program } from "../v2/types.js";

function ok(input: string): Program {
  const p = parse(input);
  if ("message" in p) throw new Error(`parse error line ${p.line}: ${p.message}`);
  return p;
}

function parseErr(input: string): ParseError {
  const p = parse(input);
  if (!("message" in p)) throw new Error(`expected parse error, got a program`);
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

function run(src: string): string[] {
  const { store } = runFixpoint(ok(src));
  return listTuples(store);
}

// The hard invariant: an intercepted tuple never surfaces as both the
// exception result and the real relation.
function assertExclusive(tuples: string[], a: string, b: string): void {
  assert(
    !(tuples.includes(a) && tuples.includes(b)),
    `exclusion violated: both '${a}' and '${b}' present`,
  );
}

// 1) Basic override (m=0): a producer inside the exception context runs
// `e`; one in a disjoint moment range stays `p`.
{
  const tuples = run(`
~phase1; ~phase2

phase1, ^p a

phase2, ^p b

#def r
  phase1
  {p X => ^e X}
`);
  assert(tuples.includes("e a"), `missing 'e a': ${tuples.join(" | ")}`);
  assert(!tuples.includes("p a"), `'p a' should be intercepted: ${tuples.join(" | ")}`);
  assert(tuples.includes("p b"), `missing 'p b': ${tuples.join(" | ")}`);
  assert(!tuples.includes("e b"), `'e b' should not fire: ${tuples.join(" | ")}`);
  console.log("PASS: basic override");
}

// 2) Context-variable transport (m>0): `e` references a var bound earlier
// in R; the var reaches `e` via the flag payload.
{
  const tuples = run(`
+bind c1 y1
~ctx

ctx, ^p a

#def r
  ctx
  bind c1 Y
  {p X => ^e X Y}
`);
  assert(tuples.includes("e a y1"), `missing 'e a y1': ${tuples.join(" | ")}`);
  assert(!tuples.includes("p a"), `'p a' should be intercepted: ${tuples.join(" | ")}`);
  console.log("PASS: context-variable transport");
}

// 3) Multi-atom RHS.
{
  const tuples = run(`
~ctx

ctx, ^p a

#def r
  ctx
  {p X => ~foo X, +bar X}
`);
  assert(tuples.includes("foo a"), `missing 'foo a': ${tuples.join(" | ")}`);
  assert(tuples.includes("bar a"), `missing 'bar a': ${tuples.join(" | ")}`);
  assert(!tuples.includes("p a"), `'p a' should be intercepted: ${tuples.join(" | ")}`);
  console.log("PASS: multi-atom RHS");
}

// 4) V-scoping (intra-rule, different predicates) — structural. Watcher
// shape: R broadcasts `anchor p_ctx U..`; the watcher joins ctx with p'
// and sets the flag. Prefix-bound LHS vars (X) ride the ctx payload;
// e2's context var (Y) rides both ctx and flag. (The original plan's
// cross-exception V-scoping — e2 reading exc1's X — is retired by
// plans/v2-exception-watchers.md: LHS vars are exception-local now.)
{
  const prog = ok(`
#def r
  is1 _X X
  {p X => ^e1 X}
  is2 _Y Y
  {q Z => ^e2 Y Z}
`);
  const out = applyExceptions(prog);
  const byName = new Map(out.rules.map((r) => [r.name, r]));
  assert.deepEqual(
    [...byName.keys()].sort(),
    ["r", "r_default1", "r_default2", "r_exn1", "r_exn2", "r_watch1", "r_watch2"],
    `rule set: ${[...byName.keys()].join(", ")}`,
  );
  const render = (name: string): string[] =>
    byName.get(name)!.body.map(renderRuleAtom);
  assert.deepEqual(render("r"), [
    "Atom[match] is1 ?_X ?X",
    "Atom[anchor] _p_ctx1 ?X",
    "Atom[match] is2 ?_Y ?Y",
    "Atom[anchor] _q_ctx1 ?Y",
  ], `r body:\n${render("r").join("\n")}`);
  assert.deepEqual(render("r_watch1"), [
    "Atom[match] _p_ctx1 ?X",
    "Atom[match] _p_prime1 ?X",
    "Atom[anchor] _p_exn1 -> 1",
  ]);
  assert.deepEqual(render("r_exn1"), [
    "Atom[match] _p_prime1 ?X",
    "Atom[aggregate] _p_exn1 -> 1",
    "Atom[anchor] e1 ?X",
  ]);
  assert.deepEqual(render("r_default1"), [
    "Atom[match] _p_prime1 ?_w1",
    "Atom[aggregate] _p_exn1 -> 0",
    "Atom[anchor] p ?_w1",
  ]);
  assert.deepEqual(render("r_watch2"), [
    "Atom[match] _q_ctx1 ?Y",
    "Atom[match] _q_prime1 ?Z",
    "Atom[anchor] _q_exn1 ?Y -> 1",
  ]);
  assert.deepEqual(render("r_exn2"), [
    "Atom[match] _q_prime1 ?Z",
    "Atom[aggregate] _q_exn1 ?Y -> 1",
    "Atom[anchor] e2 ?Y ?Z",
  ]);
  assert.deepEqual(render("r_default2"), [
    "Atom[match] _q_prime1 ?_w1",
    "Atom[aggregate] _q_exn1 _ -> 0",
    "Atom[anchor] q ?_w1",
  ]);
  assert.equal(out.schema.get("_p_exn1"), "bool");
  assert.equal(out.schema.get("_q_exn1"), "bool");
  console.log("PASS: watcher structural (worked example 1)");
}

// 4b) V-scoping end-to-end: Y (a genuine prefix var) is transported to
// e2 via ctx payload and flag; prefix-bound X filters exc1's LHS.
{
  const tuples = run(`
+is1 s1 xv
+is2 s2 yv
~ctx

ctx, ^p xv

ctx, ^q zv

#def r
  ctx
  is1 _X X
  {p X => ^e1 X}
  is2 _Y Y
  {q Z => ^e2 Y Z}
`);
  assert(tuples.includes("e1 xv"), `missing 'e1 xv': ${tuples.join(" | ")}`);
  assert(tuples.includes("e2 yv zv"), `missing 'e2 yv zv': ${tuples.join(" | ")}`);
  assert(!tuples.includes("p xv"), `'p xv' should be intercepted: ${tuples.join(" | ")}`);
  assert(!tuples.includes("q zv"), `'q zv' should be intercepted: ${tuples.join(" | ")}`);
  console.log("PASS: V-scoping end-to-end");
}

// 5) Same predicate, two exceptions in one rule — structural. The
// load-bearing intra-rule rewrite: exc2's step-3 walks S and mutates
// r_default1's tail from `anchor move` to `anchor _move_prime2`.
{
  const prog = ok(`
#def r
  is1 _X X
  {move X _ => ^nope}
  is2 _Y Y
  {move Y _ => ^boom}
`);
  const out = applyExceptions(prog);
  const byName = new Map(out.rules.map((r) => [r.name, r]));
  const render = (name: string): string[] =>
    byName.get(name)!.body.map(renderRuleAtom);
  assert.deepEqual(render("r"), [
    "Atom[match] is1 ?_X ?X",
    "Atom[anchor] _move_ctx1 ?X",
    "Atom[match] is2 ?_Y ?Y",
    "Atom[anchor] _move_ctx2 ?Y",
  ], `r body:\n${render("r").join("\n")}`);
  assert.deepEqual(render("r_watch1"), [
    "Atom[match] _move_ctx1 ?X",
    "Atom[match] _move_prime1 ?X _",
    "Atom[anchor] _move_exn1 -> 1",
  ]);
  assert.deepEqual(render("r_default1"), [
    "Atom[match] _move_prime1 ?_w1 ?_w2",
    "Atom[aggregate] _move_exn1 -> 0",
    "Atom[anchor] _move_prime2 ?_w1 ?_w2", // rewritten by exc2's step 3
  ], `r_default1:\n${render("r_default1").join("\n")}`);
  assert.deepEqual(render("r_default2"), [
    "Atom[match] _move_prime2 ?_w1 ?_w2",
    "Atom[aggregate] _move_exn2 -> 0",
    "Atom[anchor] move ?_w1 ?_w2",
  ]);
  console.log("PASS: same-predicate structural (worked example 2)");
}

// 5b) Same predicate behavioral: source-order priority (first exception
// wins when both would match), and full two-hop fall-through when
// neither context holds.
{
  // First exception's context holds: nope fires, boom never does.
  const t1 = run(`
+first a
~ctx

ctx, ^move a b

#def r
  ctx
  first X
  {move X _ => ^nope}
  second Y
  {move Y _ => ^boom}
`);
  assert(t1.includes("nope"), `missing 'nope': ${t1.join(" | ")}`);
  assert(!t1.includes("boom"), `'boom' should not fire: ${t1.join(" | ")}`);
  assert(!t1.includes("move a b"), `'move a b' should be intercepted: ${t1.join(" | ")}`);

  // Neither context holds: the tuple falls through both defaults
  // (p → p1' → p2' → p) and the real move survives.
  const t2 = run(`
~ctx

ctx, ^move a b

#def r
  ctx
  first X
  {move X _ => ^nope}
  second Y
  {move Y _ => ^boom}
`);
  assert(t2.includes("move a b"), `missing 'move a b': ${t2.join(" | ")}`);
  assert(!t2.includes("nope"), `'nope' should not fire: ${t2.join(" | ")}`);
  assert(!t2.includes("boom"), `'boom' should not fire: ${t2.join(" | ")}`);
  console.log("PASS: same-predicate behavioral (priority + fall-through)");
}

// 6) Cross-rule chaining: two exceptions on the same `p` in distinct
// rules each intercept their own context; a producer in neither stays `p`.
{
  const tuples = run(`
~ca; ~cb; ~cc

ca, ^p x

cb, ^p y

cc, ^p z

#def ra
  ca
  {p X => ^ea X}

#def rb
  cb
  {p X => ^eb X}
`);
  assert(tuples.includes("ea x"), `missing 'ea x': ${tuples.join(" | ")}`);
  assert(tuples.includes("eb y"), `missing 'eb y': ${tuples.join(" | ")}`);
  assert(tuples.includes("p z"), `missing 'p z': ${tuples.join(" | ")}`);
  assert(!tuples.includes("p x"), `'p x' should be intercepted: ${tuples.join(" | ")}`);
  assert(!tuples.includes("p y"), `'p y' should be intercepted: ${tuples.join(" | ")}`);
  assert(!tuples.includes("ea y") && !tuples.includes("eb x"),
    `cross-context interception: ${tuples.join(" | ")}`);
  console.log("PASS: cross-rule chaining");
}

// 7) Wildcard t_i: override fires regardless of the wildcard arg.
{
  const tuples = run(`
~ctx

ctx, ^p a b

ctx, ^p a c

#def r
  ctx
  {p X _ => ^e X}
`);
  assert(tuples.includes("e a"), `missing 'e a': ${tuples.join(" | ")}`);
  assert(!tuples.includes("p a b"), `'p a b' should be intercepted: ${tuples.join(" | ")}`);
  assert(!tuples.includes("p a c"), `'p a c' should be intercepted: ${tuples.join(" | ")}`);
  console.log("PASS: wildcard LHS arg");
}

// 7b) Arity split: each arity of `p` is a distinct predicate for this
// feature. An arity-0 exception intercepts only arity-0 emits; `p x`
// passes through untouched (previously it was renamed and orphaned).
{
  const tuples = run(`
~ctx

ctx, ~p

ctx, ~p x

#def r
  ctx
  {p => ~q}
`);
  assert(tuples.includes("q"), `missing 'q': ${tuples.join(" | ")}`);
  assert(!tuples.includes("p"), `arity-0 'p' should be intercepted: ${tuples.join(" | ")}`);
  assert(tuples.includes("p x"), `'p x' (arity 1) should pass through: ${tuples.join(" | ")}`);
  console.log("PASS: arity split");
}

// 8) Naming: `#def f` with two exceptions yields f plus per-exception
// watch/exn/default triples.
{
  const prog = ok(`
#def f
  ctx
  {p => ^e1}
  ctx2
  {q => ^e2}
`);
  const out = applyExceptions(prog);
  assert.deepEqual(
    out.rules.map((r) => r.name).sort(),
    ["f", "f_default1", "f_default2", "f_exn1", "f_exn2", "f_watch1", "f_watch2"],
  );
  console.log("PASS: naming");
}

// 9) Reduced misfits: exception as a plain body item in a dot-chain rule.
// NOTE (characterization finding): the flag only intercepts a p' tuple when
// the flag's interval CONTAINS the tuple's interval (aggregate candidates
// are selected by containment, scheduler.ts aggregateOver). Seeding `tag`
// *inside* ctx narrows R's anchor to [tag_m, ctx_r], the flag no longer
// contains the p' interval, and the move leaks through the default. `tag`
// is seeded before ctx so the flag spans the whole context.
{
  const tuples = run(`
+tag c1 misfits
~ctx

ctx, ^play-card c1

ctx, ^move c1 supply

#def r
  ctx
  play-card.tag misfits
  {move X _ => ^nope}
`);
  assert(tuples.includes("nope"), `missing 'nope': ${tuples.join(" | ")}`);
  assert(!tuples.includes("move c1 supply"), `'move c1 supply' should be intercepted: ${tuples.join(" | ")}`);
  assert(tuples.includes("play-card c1"), `missing 'play-card c1': ${tuples.join(" | ")}`);
  console.log("PASS: reduced misfits (dot-chain rule)");
}

// 10) Errors.
{
  const cases: [string, string][] = [
    ["ctx {p X => {q => ^r}}", "exception RHS may not contain an exception"],
    ["ctx {p a -> X => ^q}", "exception LHS cannot be an aggregate ('-> weight')"],
    ["ctx {X a => ^q}", "exception LHS head must be a symbol"],
    ["ctx {+p a => ^q}", "exception LHS cannot carry a marker"],
    ["ctx {p q}", "exception block requires '=>'"],
    ["ctx { => ^q}", "exception LHS is empty"],
    ["foo . {p => ^q}", "'.' cannot be adjacent to an exception block"],
    ["foo {p => ^q} . bar", "'.' cannot be adjacent to an exception block"],
    ["ctx {p => ^q", "unterminated '{' (exception block must close on the same line)"],
    ["ctx p} q", "stray '}'"],
  ];
  for (const [src, msg] of cases) {
    const err = parseErr(src);
    assert.equal(err.message, msg, `for source: ${src}`);
  }
  console.log("PASS: errors");
}

// 10b) Empty RHS = bare suppression: the tuple is intercepted in-context
// (no exception result is emitted either), and the default rule still
// re-emits the real relation out-of-context. No `_exn` rule is generated.
{
  const tuples = run(`
complete-set X, ~score X 1

late Y, ~score Y 2

( ~complete-set x, {score X _ =>} )
+late q
`);
  assert(!tuples.includes("score x 1"), `'score x 1' should be suppressed: ${tuples.join(" | ")}`);
  assert(tuples.includes("score q 2"), `missing 'score q 2': ${tuples.join(" | ")}`);

  const out = applyExceptions(ok("( ~ctx, {p =>} )"));
  const names = out.rules.map((r) => r.name);
  assert(names.some((n) => n.endsWith("_watch1")), `missing watcher: ${names.join(" | ")}`);
  assert(names.some((n) => n.endsWith("_default1")), `missing default: ${names.join(" | ")}`);
  assert(!names.some((n) => n.endsWith("_exn1")), `unexpected exn rule: ${names.join(" | ")}`);
  console.log("PASS: empty RHS suppression");
}

// 11) No-exception program passes through applyExceptions unchanged.
{
  const prog = ok(`
~ctx
ctx, ^p a
`);
  const out = applyExceptions(prog);
  assert.equal(out, prog);
  console.log("PASS: no-exception program unchanged");
}

// 15) Stall regression (plans/v2-exception-watchers.md): an exception is
// a listener, not a gate. With no `move` producer at all, both steps of
// the `;` rule still run.
{
  const t1 = run(`
play A

( ~play x, {move X => ~foo X} );
( ~play y, {move Y => ~bar Y} )
`);
  assert(t1.includes("play x"), `missing 'play x': ${t1.join(" | ")}`);
  assert(t1.includes("play y"), `stall: missing 'play y': ${t1.join(" | ")}`);
  assert(!t1.includes("foo x") && !t1.includes("bar y"),
    `no move producer, nothing to intercept: ${t1.join(" | ")}`);

  // With a producer, each step's exception intercepts its own move.
  const t2 = run(`
play A, ~move A

( ~play x, {move X => ~foo X} );
( ~play y, {move Y => ~bar Y} )
`);
  assert(t2.includes("foo x"), `missing 'foo x': ${t2.join(" | ")}`);
  assert(t2.includes("bar y"), `missing 'bar y': ${t2.join(" | ")}`);
  assert(!t2.includes("move x") && !t2.includes("move y"),
    `moves should be intercepted: ${t2.join(" | ")}`);
  console.log("PASS: stall regression (exceptions don't gate)");
}

// 16) LHS variable locality: two exceptions in one rule spelling their
// LHS var the same way no longer unify — X is local to each exception.
{
  const tuples = run(`
play A, ~move A

( ~play x, {move X => ~foo X} ); ( ~play y, {move X => ~bar X} )
`);
  assert(tuples.includes("foo x"), `missing 'foo x': ${tuples.join(" | ")}`);
  assert(tuples.includes("bar y"), `shared-X capture: missing 'bar y': ${tuples.join(" | ")}`);
  assert(!tuples.includes("move y"), `'move y' should be intercepted: ${tuples.join(" | ")}`);
  console.log("PASS: LHS variable locality");
}

// 17) Prefix-bound LHS var still filters: X bound by `first X` rides the
// ctx payload and re-unifies in the watcher, so the flag is only set when
// a *matching* tuple exists. (Interception itself stays temporal — two
// tuples sharing one moment share one flag, per the containment note on
// test 9 — so the sharp test is the flag NOT being set: without Vt
// transport the watcher's X would bind c and intercept.)
{
  const t1 = run(`
+first a
~ctx

ctx, ^move c d

#def r
  ctx
  first X
  {move X _ => ^nope}
`);
  assert(t1.includes("move c d"), `'move c d' should pass through: ${t1.join(" | ")}`);
  assert(!t1.includes("nope"), `'nope' must not fire for a non-matching move: ${t1.join(" | ")}`);

  // Positive companion: a matching move is intercepted.
  const t2 = run(`
+first a
~ctx

ctx, ^move a b

#def r
  ctx
  first X
  {move X _ => ^nope}
`);
  assert(t2.includes("nope"), `missing 'nope': ${t2.join(" | ")}`);
  assert(!t2.includes("move a b"), `'move a b' should be intercepted: ${t2.join(" | ")}`);
  console.log("PASS: prefix-bound LHS var filters");
}

// ---------------------------------------------------------------------
// Characterization tests (plan "maybe issues" item 3). Hard invariant:
// per-tuple mutual exclusion. Everything else is logged as CHAR: lines.
// ---------------------------------------------------------------------

// 12) Flag interval vs. exception placement: (a) top level after a match,
// (b) nested inside a sub, (c) after a `;` step.
{
  const producers = `
~world

world, ~phase1; ~phase2

phase1, ^p a

phase2, ^p b
`;
  const variants: [string, string][] = [
    ["a: top level", `
#def r
  phase1
  {p X => ^e X}
`],
    ["b: inside sub", `
#def r
  world
  (phase1, {p X => ^e X})
`],
    ["c: after ';'", `
#def r
  world
  (phase1); {p X => ^e X}
`],
  ];
  for (const [label, ruleSrc] of variants) {
    const tuples = run(producers + ruleSrc);
    assertExclusive(tuples, "e a", "p a");
    assertExclusive(tuples, "e b", "p b");
    const outcome = (x: string): string =>
      tuples.includes(`e ${x}`) ? "intercepted" : tuples.includes(`p ${x}`) ? "real" : "NEITHER";
    console.log(`CHAR 12 (${label}): p a in phase1 -> ${outcome("a")}; p b in phase2 -> ${outcome("b")}`);
  }
  console.log("PASS: placement characterization (exclusion holds)");
}

// 13) Marker round-trip through the default rule: never-firing exception;
// the tuple must survive with the same user-visible presence as the
// baseline without the exception rule. Intervals are logged for the record.
{
  const listWithIntervals = (src: string, head: string): string[] => {
    const { store } = runFixpoint(ok(src));
    return store.tuples
      .filter((t) => renderAtom(store, t.atom).startsWith(head))
      .map((t) => `${renderAtom(store, t.atom)} @ [${renderTerm(store, t.l)}, ${renderTerm(store, t.r)}]`);
  };
  for (const marker of ["+", "~", "^"]) {
    const producer = `
~ctx

ctx, ${marker}p a
`;
    const exn = `
#def r
  nonexistent-context
  {p X => ^e X}
`;
    const base = run(producer);
    const withExn = run(producer + exn);
    assert(base.includes("p a"), `baseline missing 'p a' (${marker})`);
    assert(withExn.includes("p a"), `'${marker}p a' lost through the default chain: ${withExn.join(" | ")}`);
    assert(!withExn.includes("e a"), `'e a' fired with never-true context (${marker})`);
    console.log(`CHAR 13 (${marker}p): baseline ${listWithIntervals(producer, "p ")}`);
    console.log(`CHAR 13 (${marker}p): with-exn ${listWithIntervals(producer + exn, "p ")}`);
  }
  console.log("PASS: marker round-trip (presence preserved)");
}

// 14) Flag scheduling: the flag-setter fires late (derivation chain /
// aggregate read before the exception). No transient real `p` may leak
// through the default.
{
  // Chain variant: r's context is three derivation steps away.
  const t1 = run(`
~ctx

ctx, ^p a

ctx, ^s1

s1, ^s2

s2, ^s3

#def r
  ctx
  s3
  {p X => ^e X}
`);
  assert(t1.includes("e a"), `late flag (chain): missing 'e a': ${t1.join(" | ")}`);
  assert(!t1.includes("p a"), `late flag (chain): premature default leaked 'p a': ${t1.join(" | ")}`);

  // Aggregate variant: an aggregate read gates the flag-setter, so the
  // flag emit is deferred to the aggregate tier — the same tier as the
  // p_exn reads themselves. Which closes first is a scheduler question
  // (the plan's `-> 0`-as-negation-over-time concern); record it.
  // Note the saw fact is set in an *earlier* episode: aggregate
  // candidates are selected by interval containment, so a fact minted
  // inside the reading anchor would not be seen at all.
  const t2 = run(`
#agg saw -> bool

~ep1; ~ep2

ep1, +saw -> 1

ep2, ^p a

#def r
  ep2
  saw -> 1
  {p X => ^e X}
`);
  assertExclusive(t2, "e a", "p a");
  const aggOutcome = t2.includes("e a") ? "intercepted" : t2.includes("p a") ? "real (default won the tier race)" : "NEITHER";
  console.log(`CHAR 14 (agg-gated flag): ${aggOutcome}`);

  // Partial overlap: the flag's interval (mid, inside ctx) only partially
  // overlaps the p episode (all of ctx). Record which side fires.
  const t3 = run(`
~ctx

ctx, ~p a

ctx, ~mid

#def r
  mid
  {p X => ^e X}
`);
  assertExclusive(t3, "e a", "p a");
  const outcome = t3.includes("e a") ? "exception" : t3.includes("p a") ? "default" : "NEITHER";
  console.log(`CHAR 14 (partial overlap): ${outcome} fired`);
  console.log("PASS: flag scheduling (no premature default; exclusion holds)");
}

console.log("v2_exceptions: all tests passed");

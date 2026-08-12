# v2 js relations (`#js-def`)

## Summary

Today `#js (inc x) { return x + 1; }` defines a *term-level* JS function,
callable as `@js(inc X)` inside emit atoms (lowered to a `JsCall` IR atom).
This change adds *relation-level* JS definitions: generator bodies that
enumerate tuples, usable only as match atoms.

```
-- `+` / `-` mark the parameter *mode*: + = bound at call, - = enumerated
#js-def range +Lo +Hi -I {
  for (let i = Lo; i < Hi; i++) {
    yield [i]; // yield an array of just the `-` (unbound) arguments, in order
  }
}

range 0 8 I, range 0 8 J, ^foo I J
```

- Allowed **only as match atoms** (default marker, no weight). Any other use
  of a js-relation head is a static error.
- A relation may have several `#js-def`s with different mode vectors (same
  arity). Modes are ordered `- < +`, lifted pointwise (product order). At
  compilation we pick the **earliest declared** def whose mode vector is
  `≤` the call site's modes, where a call position is `+` iff the argument
  is ground / all its variables are bound by the atoms to its left.
- The selection needs a simple left-to-right binding analysis over rule
  bodies, run as a **late pipeline stage** — after decomposition and
  splitting, when bodies are flat post-expand IR (so variables recovered
  across a split via idTpl chains are visible as bound).

A js relation is *timeless*: matching it does not constrain or update the
running anchor (no overlap check, no Max/Min intersection). It behaves as a
pure enumerator/filter interleaved into the join.

A `-` def can always serve a `+` call position: the generator yields a value
and unification against the already-bound argument filters. A `+` def can
never serve a `-` position (the JS body needs the value). Hence "earliest
def ≤ call modes".

## Data model (types.ts)

```ts
// One `#js-def name ±p1 .. ±pn { body }` clause.
export interface JsRelDef {
  name: string;
  params: { mode: "+" | "-"; name: string }[];
  body: string;      // raw JS generator body between the braces
  span: Span;
}
```

`Program` gains:

```ts
// `name -> clauses in declaration order` for `#js-def` relations.
jsRels: Map<string, JsRelDef[]>;
```

New `RuleAtom` variant (post-expand only; produced by decomposition,
resolved by the mode pass, consumed by the evaluator):

```ts
// Enumerate a `#js-def` relation. `args` are the user argument terms
// (no head, no trailing id slot — js relations have no stored rows).
// `defIndex` selects the clause; set by `resolveJsModes`, an internal
// error if still undefined at eval.
| {
    tag: "JsIterate";
    func: string;
    args: Term[];
    defIndex?: number;
    span: Span;
  }
```

## Parser (parse.ts)

- **Tokenizer**: extend the `name === "js"` branch to also accept
  `name === "js-def"`, reusing the exact same body-collection logic
  (one-liner `{ ... }` with `}` last on the line, or `{` last + indented
  body + column-0 `}`). Emit `{ tag: "command", name: "js-def", argText: sig,
  body, line }`. The signature is *not* parenthesized (unlike `#js`):
  everything between `#js-def` and the first `{`.
- **`parseJsRelCommand(sig, body, line)`**: split `sig` on whitespace.
  - First token: relation name — `isSymToken`, not reserved `r\d+`.
  - Remaining tokens: each must match `^[+-][A-Za-z_$][A-Za-z0-9_$]*$`.
    `+` param names become the generator's JS parameters, so they must be
    valid JS identifiers; validate `-` names the same way for uniformity.
    Param names must be distinct within one clause.
  - Zero params and zero `-` params are both legal (a `-`-less def is a
    pure test: yield `[]` once for success).
- **`parseProgram`** accumulates `jsRels` (append to the name's list):
  - a name in both `jsDefs` and `jsRels` → error (one symbol namespace);
  - a name in both `jsRels` and `macros` → error (checked after the full
    pass, since a `#macro` may lexically precede or follow the `#js-def`);
  - clauses of one name must agree on arity → error otherwise;
  - two clauses with identical mode vectors → error (`duplicate '#js-def'
    mode signature for 'range'`);
  - a `#agg`/`#reactive` declaration for a `jsRels` name → error (checked
    after the full pass, since order is free).
- Thread `jsRels` through the `Program` literal at the end of
  `parseProgram`, and through `expand()`'s returned Program in expand.ts.

## Decomposition (expand.ts)

In `decomposeBody`'s `a.tag === "Atom"` arm, before the existing marker
dispatch, detect a js-relation head (`a.atom.terms[0]` is a Symbol in
`jsRels`; `DecState` gains a `jsRels: Map<string, JsRelDef[]>` field,
threaded from `decomposeRule` — plumb through `expandStages`, which gets
`program.jsRels`):

- marker must be `"match"` and `weight === undefined`, else error:
  `js relation 'range' can only be used as a plain match atom`. (A weighted
  match would otherwise route to `decomposeAggregate`; other markers would
  emit into it.)
- arity check against the clauses' shared arity.
- Push `{ tag: "JsIterate", func, args: a.atom.terms.slice(1), span }`.
  No `_l_/_r_` slots, no Le/Max/Min, no trailing-wildcard append; return
  `{ XL, XR }` unchanged.
- Then `collectVarsTerm` over the args (as `decomposeMatch` does): new
  variables enter the chain and are marked essential, so downstream
  fresh-id templates fingerprint the enumerated bindings and two distinct
  yields don't collide in dedup. `collectVarsTerm` already rejects
  `@js(...)` inside these terms.

Reject js-relation heads in the other structural positions, mirroring the
macro-pass errors:

- exception LHS (`applyExceptions`: head lookup where the LHS Symbol is
  read) → error;
- `!(...)` sub-atoms (`buildConstrainRowAtom` or a check in `decomposeEmit`)
  → error;
- bracket-aggregation query items (`aggCompOutCols` walks items — check
  item heads there, where `state` gives the rule name) → error, noted as a
  possible follow-up (comp-aggregate evaluates queries itself and would
  need its own enumerator support);
- emit heads at any arity (`decomposeEmit` head check) → error.

`collectProgramSymbols` adds `jsRels` keys (fresh-name minting).

Other passes need no logic changes, only the new tag in switches:

- **expand-liveness.ts**: `rewriteAtom` rewrites `args`; `addUses` collects
  `args` vars. (`definedVar` stays null — a JsIterate is never dead code to
  drop; it can filter.)
- **splitRule / generateDeltaVariants**: JsIterate is neither Emit nor
  Match, so it rides along in whichever slice it lands in and takes no
  delta tag. A rule whose only "reads" are js relations gets no delta
  variant and runs every inner-loop iteration; dedup absorbs re-emits
  (same behavior as today's matchless rules).

## Mode selection pass (new file: js-rel.ts)

`resolveJsModes(rules: Rule[], jsRels: Map<string, JsRelDef[]>): Rule[]` —
run in `expandStages` after `filtered`, before `generateDeltaVariants`
(variant tagging only flips Match constraints, so resolving once before
cloning is equivalent and cheaper; this is still "after expansion/
splitting"). Add the stage to `ExpandStages` (e.g. `resolved`) so
`v2-cli --stage` can dump it; update the CLI's stage list.

Per rule, walk the body left to right with a `bound: Set<string>`:

| atom | effect on `bound` |
|---|---|
| `Match` | all Variables in `atom`, `l`, `r` (unification binds everything, including chain vars inside idTpl — this is what makes consumer slices work) |
| `Emit` | all Variables in `atom`, `l`, `r` (they are ground at emit time by invariant) |
| `Equal` | if all vars of one side are already bound (or it's ground), the other side's vars become bound; if both sides have unbound vars, bind nothing (conservative) |
| `JsCall` | `out`'s vars (args were already checked bound at lowering) |
| `Max` / `Min` | `out`'s vars |
| `Le` / `AssertLt` | nothing |
| `JsIterate` | see below; afterwards all arg vars |

At a `JsIterate`, compute the call-mode vector: position i is `+` iff
`args[i]` is ground or all its Variables are in `bound`, else `-`.
Select the first clause (declaration order) with `mode[i] ≤ callMode[i]`
for all i (`- ≤ -`, `- ≤ +`, `+ ≤ +`). Set `defIndex`. If none matches,
throw naming the rule, relation, and the call modes, e.g.:

```
rule 'r3': no '#js-def range' clause matches modes (+ + -)
  (a '+' parameter requires the argument to be bound by earlier atoms)
```

A compound argument with a mix of bound vars is `-` (the generator can't
receive a partial term); unification with the yielded value still checks
the bound parts.

## Compilation + evaluation

**Compilation** (js-rel.ts, mirroring `compileJsDefs`):

```ts
export interface CompiledJsRel {
  modes: ("+" | "-")[];
  // bound decoded args in `+`-position order -> iterator of yield arrays
  gen: (...bound: unknown[]) => Iterable<unknown[]>;
}
export function compileJsRels(jsRels: Map<string, JsRelDef[]>): Map<string, CompiledJsRel[]>
```

Bodies compile once via the generator-function constructor
(`Object.getPrototypeOf(function* () {}).constructor`), with the `+`
param names as JS parameters. Syntax errors surface with the relation
name, like `compileJsDefs`.

**Evaluation** (eval.ts): `Ctx` gains `jsRels: Map<string, CompiledJsRel[]>`;
`evaluateRule` takes it as a parameter (fixpoint.ts is the only production
caller); `evalSeq` dispatches `case "JsIterate"`.

`evalJsIterate`:
1. `defIndex` undefined → internal error (mode pass missing).
2. Substitute each arg via the trail. For `+` positions, `decodeTerm`
   (js-values.ts); a non-ground `+` arg is an internal error — the mode
   pass guaranteed groundness.
3. Invoke the generator with the decoded `+` args. Iterate:
   - each yield must be an array whose length equals the number of `-`
     positions, else error naming the relation;
   - `encodeTerm` each element; `unifyTerms` against the corresponding
     `-`-position arg term (mark/unwind around each yield, like
     `evalMatch`'s candidate loop). Failure = filtered, continue.
   - on success, `next()`, then unwind and continue enumerating
     (backtracking choice point).
4. Wrap body exceptions: `#js-def range threw: ...`.
5. Safety cap: throw after 1,000,000 yields from one call (`#js-def range:
   yield limit exceeded (possible infinite generator)`) — a runaway
   generator would otherwise hang the browser editor with no gas check in
   between.

**fixpoint.ts**: `const jsRelFuncs = compileJsRels(expanded.jsRels)` next to
`compileJsDefs`, passed through `runLoop`/`innerLoop` to `evaluateRule`.

## Printing / tooling

- **print-ir.ts**: program header line per clause
  (`#js-def range +Lo +Hi -I { ... }`); `renderRuleAtom` case for
  `JsIterate` showing func, resolved modes (or `?` when unresolved), args.
- **v2-cli.ts**: new `--stage` name if one is added.
- **autocomplete.ts**: nothing — symbols are lexer-derived, so `range`
  already completes.

## Tests

New `ts/src/tests/v2_js_rel.test.ts`:

- parse: one-liner + multi-line bodies; bad mode token; duplicate mode
  vector; arity mismatch across clauses; name clash with `#js`; `#agg` on a
  js relation.
- mode selection: earliest-clause-wins with two clauses (`+ + -` before
  `- - -`); ground-literal args count as `+`; args bound by an earlier
  match; args bound across an emit split (js atom after `~`/`+` emits in
  the same source rule); no-clause error.
- eval: enumerate (`range 0 3 I` produces 3 firings); filter (`+` call
  into a `-` clause position unifies/filters); pure-test clause (no `-`
  params); yield-shape error; thrown body error; two js atoms joining
  (`range 0 8 I, range 0 8 J`).
- rejection: emit marker, weight, exception LHS, `!(...)`, bracket query.

Extend `v2_overview.test.ts`'s file list if it enumerates files (new
`js-rel.ts`).

## Docs

- Update `ts/src/v2/overview.md`: **new `js-rel.ts` section** (mode
  selection + compilation), plus touched sections: types.ts (`JsRelDef`,
  `JsIterate`, `Program.jsRels`), parse.ts (`#js-def`), expand.ts
  (decompose branch, new stage), eval.ts (`evalJsIterate`), fixpoint.ts
  (compile step), expand-liveness.ts (JsIterate arms).
- `discussions/turn-tutorial.md`: short `#js-def` section with the `range`
  example.

## Out of scope / follow-ups

- js relations inside bracket-aggregation queries and `!(...)` constrain
  blocks (rejected for now; comp-aggregate.ts / constraint-query.ts would
  need their own enumeration support).
- Reordering atoms to satisfy modes (we take source order as given).
- Incremental/semi-naive treatment (js relations are re-enumerated per
  firing; they are pure, so this is only a perf concern).

---
Plan author: Claude Fable 5 (claude-fable-5)

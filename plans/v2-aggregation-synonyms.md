# v2 aggregation synonyms (macros)

Source note: `# aggregation synonyms` at the top of notes/overview.md.

**Depends on plans/v2-agg-output-var.md** — do that refactor first. It is what
makes this plan a plain substitution instead of a pile of special cases.

A top-level definition binds a *name + parameters* to a bracket-aggregation
expression; uses of the name in rule bodies are replaced by that expression
with the arguments substituted for the parameters and every other variable
freshened.

```
land:count B A := [[at A B | last B] | count A]

activate push, target L, land:count L X, ~something X
```

The body after parsing is already

```
[[at A_1 B_1 | B = last B_1] | A = count A_1]
```

— the output-variable refactor's bare-form desugar renames each level's
query-side reduction variable to a compiler-fresh name (`A_1`, `B_1`) at
parse time, so no freshening of reduction variables is needed here.

so the parameters `B` and `A` are exactly the expression's output patterns,
and the use expands by substituting them:

```
[[at A_1 B_1 | L = last B_1] | X = count A_1]
```

Purely a source-to-source rewrite over the pre-expand IR: no new evaluator
concepts, no new store rows, nothing downstream of `expandMacros` changes.

## Semantics (decisions)

- A macro definition is `head P1 .. Pn := [ Q | ... ]`. The RHS is exactly one
  bracket-aggregation expression (parse error otherwise); arbitrary rule
  expressions on the RHS are out of scope.
- `head` must be a Symbol; `P1..Pn` must be **distinct named Variables**
  (not `_`, not compounds). `n` must equal `head`'s lexical arity
  (`colonCount(head) + 1`, plans/v2-arity-auto-wildcard.md) so `saturateArity`
  pads uses to exactly the parameter count.
- Definitions are file-scoped and order-independent — a use may precede its
  definition. Duplicate macro name: error.
- A *use* is a match-marker atom, without `-> weight`, whose head Symbol is a
  macro name. Any other occurrence of that head (a marker other than `match`,
  a weight, an exception LHS, an atom inside a `!(...)` constrain block) is an
  error: a macro name is not a relation.

- **Expansion.** Classify each variable of the body:
  - *outward* — the variables of the body's **top-level output columns**
    (`outCols` of the whole expression, per plans/v2-agg-output-var.md).
  - *internal* — everything else: reduction variables at every level, and any
    inner-level `Out` variable that a further-out level reduces away (in
    `[[p X Y | S = sum Y] | N = count S]`, `S` is internal). "An `Out`
    variable at some level" is *not* sufficient for outward.

  Then: freshen every internal variable unconditionally; for outward
  variables, substitute the argument if the variable is a parameter, and
  freshen it otherwise. No trailing `=` atoms, no equality splicing.

  A single name-keyed renaming/substitution map over the whole body is sound
  because every name has exactly one classification: outward is defined by
  top-level `outCols` membership, and the output-var plan's disjointness rule
  (an `Out` variable may not occur unbound anywhere in its query subtree)
  plus the desugar's compiler-fresh reduction names rule out a name playing
  both roles. No occurrence-level bookkeeping is needed.

  Every parameter must be an outward variable of the body (error otherwise —
  e.g. a parameter naming only a reduction variable, which has no outward
  meaning).

- This is sound precisely because of the refactor. An outward variable is
  either a group column or an `Out` pattern:
  - substituting into a **group column** restricts the query where it would
    otherwise have filtered the grouped result — the same answer on nonempty
    input, since filtering a group column after the fold selects exactly the
    group that restricting before the fold would have produced (the
    empty-input case can diverge — see "Deferred: empty groups" below);
  - substituting into an **`Out` pattern** is already unification by
    construction, and `Out` tolerates a bound variable or a ground term.

  So the awkward cases fall out with no special handling:
  - `land:count X X` → `[[at A_1 B_1 | X = last B_1] | X = count A_1]`, which
    reads "the location equals the count" — the two query positions stay
    distinct and the relationship is imposed by unification, not by collapsing
    them into one variable.
  - `land:count foo X` → `foo = last B_1`, a filter.
  - `land:count L _` → `_ = last B_1`, unconstrained.
- **No recursion**, direct or mutual: static error naming the cycle.
- Macro bodies may use other macros. Because expansion produces a single
  `AggComp` and no loose `Equal` atoms, a nested use inside another macro's
  body — or inside any bracket query — needs no restriction.

### Deferred: empty groups

Substituting arguments into group columns changes which columns remain in the
group key, and `reduceRows`'s empty-input branch keys on exactly that
(`keyCols.length`, comp-aggregate.ts): with every group column substituted
away, an empty query yields one zero row for count/sum, where the
filter-after-fold reading would yield none. Whether that divergence is
desirable (e.g. `land:count L X` firing with `X = 0` at an empty location
when `L` is bound) is deliberately **not decided here** — it is a property of
the empty-group policy in plans/v2-bracket-aggregation.md and can be settled
there later. This plan only substitutes; it adds no empty-group rules of its
own.

## Pipeline changes

### 1. parse.ts

**Tokenizer.** *(Amended during implementation: the definition is introduced
by a `#macro` command rather than being recognized positionally.)* In the `#`
command branch, `#macro` scans the rest of the line for a top-level `:=`
(depth counted over `(` `)` `[` `]`) and emits
`{ tag: "macroDef", headText, line }`, where `headText` is the text between
the command name and the `:=`; `pos` moves past the `:=` and the RHS then
tokenizes with the existing machinery, so the multi-line `[` handling (and
its comment stripping / blank-line tolerance) is reused unchanged.

The original design keyed detection off "first token of a rule", which had
two costs the command form removes: `:=` became quasi-reserved at the start
of any rule, and — because rules are blank-line delimited — two adjacent
definitions read as one rule, so every definition needed a blank line after
it. With `#macro`, `:` and `=` keep their current meanings everywhere, and a
definition is self-delimiting: it ends at its body's closing `]` (tracked by
the `aggcomp` token's `endLine`), so the next definition or rule may start on
the very next line. Only trailing content on the body's own line is an
error.

**parseProgram.** New case for `macroDef`:
- Parse `headText` with `tokenizeTermText`/`parseTerms`; require a Symbol head
  (rejecting `*`-prefixed and the `_do-agg*` / `_agg-result*` / `_choose` /
  `_constrain` reserved names) and distinct Variable parameters; check the
  arity rule above.
- Skip any intervening `ruleEnd` tokens (mirroring the `#def` handling in
  `parseProgram`), so the RHS may start on the line after `:=`. The next
  token must then be the `aggcomp` produced from the RHS; anything else →
  "macro body must be a '[ ... ]' aggregate expression". Reuse
  `parseAggCompText`'s result directly.
- Run `saturateArity` on the body so its atoms are padded like any other query
  atom.
- Record into `macros` and `continue` (no rule is produced; the definition
  must not fall through to `desugarBody` or `resolveRuleNames`).

Errors to cover: duplicate macro name; non-Symbol head; `_`/duplicate/
non-Variable parameter; parameter count ≠ lexical arity; missing or non-bracket
RHS; trailing tokens after the RHS on the same rule.

**types.ts.**

```ts
export interface MacroDef {
  name: string;
  params: string[];                      // variable names, arity-many
  body: Extract<RuleAtom, { tag: "AggComp" }>;
  span: Span;
}
```

and `Program` gains `macros: Map<string, MacroDef>`. Thread the new field
through every `Program` construction/spread (grep for `jsDefs:` — `expand`,
`applyExceptions`, and the test helpers all rebuild `Program` literals).

### 2. expand.ts — `expandMacros(program): Program`

New pass, run **before `applyExceptions`** (macro bodies only *read*
relations, and exception rewriting must see those reads to rename them).
Called at the top of `expandStages`, and in `runFixpoint` before its own
`applyExceptions` call, mirroring how `applyExceptions` is already invoked in
both places. A macro-free program is a no-op, so double invocation is safe.

1. **Cycle check.** Build the call graph: for each macro, the set of macro
   names appearing as atom heads anywhere in its body (recursing into nested
   `AggComp`s). Any cycle (including a self-edge) → error naming the cycle,
   anchored at one member's span.
2. **Classify.** For each macro, compute its internal (reduction) and outward
   variable sets by walking the body levels — the same `outCols` recursion
   the refactor adds to expand.ts, so factor that traversal so both callers
   share it. Validate that every parameter is outward.
3. **Normalize bodies.** In topological order, rewrite each macro's body so it
   is macro-free, using the same expansion as step 4.
4. **Rewrite rules.** Walk every rule body, recursing into `Sub.body`,
   `AggComp.body`, and `Exception.right`. Replace each qualifying use with a
   deep copy of the body under the renaming/substitution map from the
   classification. Non-qualifying occurrences (marker ≠ `match`, weight
   present, `Exception.left` head, an atom inside a constrain block's
   `subAtoms`) error.
   - Fresh names come from a per-rule counter seeded past the rule's used
     names (`collectUsedNames` in parse.ts already does this; export it or
     re-derive the used set in expand.ts). Every non-substituted body variable
     is renamed, so no name in a macro definition can capture or be captured
     by a host-rule name.
   - Arity: after `saturateArity` a well-formed use has exactly
     `params.length` arguments; an over-arity use (arity checking is
     non-strict) is a use-site error.
5. Return `{ ...program, rules: rewritten, macros: new Map() }`.

Add `macroExpanded: Rule[]` to `ExpandStages` and a `macros` case to
`v2-cli.ts`'s `--stage` switch, so the rewrite is inspectable (the v2-debug
skill's diff workflow depends on stages being dumpable).

### 3. Other pre-expand walkers

`computeAggStrata` (scheduler.ts) and the exception passes run on pre-expand
rules, but always *after* `expandMacros`, so they never see a macro use and
need no changes. Verify this holds for every entry point that consumes
`Program.rules` before expansion — grep for `program.rules` / `p.rules` in
fixpoint.ts, scheduler.ts, v2-cli.ts, autocomplete.ts, and the pres/web
entries; any that analyze pre-expand bodies must be fed the macro-expanded
program.

### 4. Tests — `ts/src/tests/v2_macros.test.ts`

Model on `ts/src/tests/v2_bracket_agg.test.ts` (drive `runFixpoint`, assert on
the store with `renderAtomDebug`); for rewrite-shape assertions use
`expandStages(...).macroExpanded` with print-ir.

- The note's example end to end: `land:count B A := [[at A B | last B] | count A]`
  used in a rule agrees with the hand-written expansion.
- **Repeated argument**: `land:count X X` — the two body positions stay
  distinct and the constraint is imposed by unification. Construct data where
  the collapsing reading and the unifying reading differ.
- **Non-Variable argument**: `land:count foo X` filters by location `foo`.
- `_` argument leaves the parameter unconstrained.
- Use before definition; a macro used twice in one rule (fresh names do not
  collide); two macros in one rule.
- Capture: a macro body variable sharing a name with a host-rule variable
  stays distinct; likewise an argument variable sharing a name with an
  internal body variable.
- Macro calling a macro; macro used inside another bracket expression's query.
- A macro whose parameters are plain group columns rather than output
  patterns (`f X Y := [p X Y Z | sum Z]`), including `f W W`.
- Errors: recursive macro (direct + mutual); duplicate definition; parameter
  count ≠ arity; non-Variable parameter; `_` parameter; parameter that is a
  reduction variable with no outward meaning; non-bracket RHS; `:=` with no
  RHS; use with a non-match marker (`~land:count L X`); use with `-> weight`;
  use on an exception LHS; use inside a `!(...)` constrain block; over-arity
  use.
- Tokenizer: a multi-line macro definition (bracket spanning lines, with a
  comment and a blank line inside) parses identically to the one-line form;
  RHS beginning on the line after `:=`; `:=` inside a rule body is not
  treated as a definition.

Run with `./run-tests.sh v2_macros` (sandbox: `node --import tsx`).

### 5. Docs

- **Update `ts/src/v2/overview.md`**: the parse section (new `macroDef` token,
  `MacroDef`, `Program.macros`), the expand section (`expandMacros` as the
  first pipeline pass, new `macroExpanded` stage), and the types key-terms
  list. No new file is added, so no new overview section is needed.
- Note the `:=` syntax alongside the bracket-aggregation syntax wherever that
  is documented.

## Out of scope (recorded for later)

- RHS forms other than a single `[ ... ]` (arbitrary rule expressions, plain
  atom conjunctions).
- Macros with zero parameters, or over/under-applied uses with partial
  application semantics.
- Exporting/importing macros across files.
- Empty-group behavior of substituted brackets (see "Deferred: empty groups"
  above) — no tests pinned here.
- Macro-aware autocomplete or source-output linking (a macro's expansion
  reports spans at the definition line; use-site span mapping is not
  attempted).

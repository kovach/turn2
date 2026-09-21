Summaries of each `.ts` file under `ts/src/v2/`, roughly following the compilation pipeline: **parse → expand → fixpoint eval (store) → render**. The first four files (`term.ts`, `hashcons.ts`, `unify.ts`, `aggregators.ts`) are the core term layer, duplicated from v1 so v2 is free-standing (see `plans/v1-cleanup.md`); the deprecated v1 originals live under `ts/src/v1/`.

# term.ts

The core term layer: the `Term`/`Atom` data types shared by every phase, source `Span`s, the `NodeId` token key space, and the substitution `Trail` (two parallel mutable arrays; bind = push, backtrack = truncate). Duplicated from the v1 `types.ts`, minus the v1-only `Tree`/`Constraint`/`TurnExpr` IRs.

**Key terms:**
- `Term` — the term algebra: `Symbol` | `Variable` | `Atom` | `Id` | `Wildcard` | `Ref`
- `Atom` / `Span` — a term list; a source position: 1-indexed line plus 0-indexed `startCol`/`endCol` covering one atom's text (marker included)
- `spanKey` — `"line:startCol-endCol"` DOM key for `data-source-span` linking; `undefined` for a column-less span
- `NodeId` — integer key space for hashconsed terms (disjoint ranges per tag)
- `Trail` — substitution trail: `newTrail`/`trailPush`/`trailLength`/`trailUnwind`/`trailLookup`
- constructors — `sym`, `vari`, `ref`, `atom`, `idTerm`, `isId`

# hashcons.ts

The hashcons engine (duplicated from v1): a trie keyed by `NodeId` tokens interns `Atom`/`Id` bodies to integer-`Ref` terms, with disjoint sub-tries per tag so structurally identical `Atom` and `Id` bodies never collide. `store.ts` owns one `HashconsState` per `Store`.

**Key terms:**
- `HashconsState` / `createHashcons` — the trie + ref/sym/var id tables; factory reserves the `*atom*`/`*id*` sentinel tag tokens
- `hashconsTerm` / `hashconsAtom` — intern a term (bottom-up) to a `Ref`; map an atom's terms
- `tokenOfId` — `Term` → integer token (Ref +N, Wildcard 0, Symbol odd-negative, Variable even-negative)
- `refTagOf` — whether a Ref's stored body was an `Atom` or an `Id`
- `expandTerm` — inverse: unfold a `Ref` back to a structural term

# unify.ts

Trail-based term unification and substitution (the v1 `unify.ts` trimmed to its term layer — the TurnExpr/RefStore-driven `unifyConstraints`/`unifyTree` machinery stays in v1). Primitives never unwind the trail on failure; choice-point callers mark/unwind. Variables are never bound to raw atoms: bindings are substituted, groundness-checked, and hashconsed to `Ref`s first.

**Key terms:**
- `resolveVar` — chase variable bindings to the first non-Variable term (no descent into atoms)
- `substTerm` / `substAtom` — full recursive substitution for materializing concrete terms
- `unifyTerms` / `unifyAtoms` — structural unification over the trail; `Atom` vs `Id` never unify; `Ref`s unify by token or by stored body against a structural term
- `unifyStats` / `resetUnifyStats` — cheap call counter used by perf experiments

# aggregators.ts

The aggregator registry (duplicated from v1): named fold definitions used by schema declarations (`#agg rel -> agg`). Each aggregator is a `zero` term plus a binary `fold`, with a commutativity flag consulted by the scheduler.

**Key terms:**
- `Aggregator` — `{ zero, fold, commutative }`
- `aggregators` / `getAggregator` — the registry (`count`, `sum`, `last`, `bool`) and its throwing lookup

# types.ts

Defines the v2 intermediate representation (IR): the `RuleAtom` algebra spanning both pre-expand (parser output) and post-expand (evaluator input) phases, the `Rule`/`Program` containers, stored `Tuple`s, and the result types for a fixpoint run including blocked-choice reporting. It documents the compilation pipeline (parse → expand → fixpoint eval → Store) and how source markers desugar into explicit anchor IR.

**Key terms:**
- `RuleAtom` — the core tagged-union IR node: pre-expand (`Atom`, `Sub`, `AggComp`, `Exception`), both-phase (`Equal`, `JsCall`), post-expand (`Match`, `Emit`, `Le`, `AssertLt`, `Max`, `Min`, `JsIterate`), and the acc-rule-only `AccMatch` / `AccContribute` (a read of a local acc row while a moment's rows are being computed; the head of an acc rule as one contribution — plans/v2-acc-relations.md)
- `Marker` — pre-expand source marker (`match`/`episode`/`fact`/`anchor`/`ask`/`constrain`/`aggregate`) driving desugaring
- `MatchConstraint` — semi-naive eval tag (`"any" | "delta" | "old"`) on `Match` atoms
- `Rule` / `Program` — named rule (body + delta fields) and the top-level container (`rules`, `schema`, `jsDefs`, `jsRels`, `macros`, `accDecls`, `accRules`)
- `AccColumn` / `AccDecl` / `AccRule` — one column of an `#acc` declaration (a key column with a documentary type, or the single agg column naming a registry op); the declaration (`columns`, `aggIndex` — null for a boolean relation); an acc rule `body / head` (pre-expand body of matches and `=`, head atom with the agg column already unwrapped to the bare contribution term). See acc-ops.ts / acc.ts
- `MacroDef` — an aggregation synonym `#macro head P1..Pn := [ ... ]`: a name, arity-many distinct parameter variable names, and one `AggComp` body. Eliminated by `expandMacros` (plans/v2-aggregation-synonyms.md)
- `AggComp.reduce` — `{ op, varName, out, bare }`: the reduction op, the query-side column `varName` being folded (internal to the query, invisible outward), and the pattern `out` unified against the folded value (binds its unbound variables outward, or filters). `bare` flags the sugar `[ Q | op V ]`, which the parser desugars by freshening `V` on the query side (plans/v2-agg-output-var.md). The existence ops `some`/`none` (`[ Q | some V ]`, plans/v2-bracket-some.md) have no folded value: `out` is a `Wildcard` (encoded as `*cq-any`), so they bind nothing and contribute no output column — `V` is eliminated from scope and `some` acts as a guard binding only `joinCols − {V}`. `none` is the negation (succeeds iff the query is empty) and requires `joinCols − {V}` be empty (it binds nothing at all)
- `Tuple` — stored datum: `atom` plus interval endpoints `l`/`r`
- `SchemaDecl` / `JsDef` / `JsRelDef` — relation→aggregator declaration; user-defined `#js` function; one `#js-def` js-relation clause (mode-marked params + generator body, plans/v2-js-relations.md). `RuleAtom` gains the post-expand `JsIterate` variant: a js-relation match lowered to a generator enumeration (arg terms only — no head, no trailing id slot, no anchor effect), with `defIndex` naming the clause picked by `resolveJsModes`
- `FixpointStatus` — run outcome (`done`/`gas`/`active-choices`/`empty-fringe-error`)
- `Actor` / `ACTOR_PRIORITY` / `maxActor` / `isActor` — the finite choice-actor set (`you` > `rng`, plans/v2-choice-actors.md); `you` is the human default, `rng` resolves uniformly at random in the scheduler
- `ComponentOptions` / `BlockedChoose` — per-component choice enumeration (with a per-active-term `actors` array); a blocked choose row (with its ask atom's `actor`)

# parse.ts

The v2 parser for the flat-syntax language: it tokenizes input line-by-line (comment- and indentation-aware) then turns the token stream into a `Program` (rules + schema), without applying hashconsing. Rule boundaries follow the offside rule: a line whose first character is at column 0 starts a new definition, indented lines continue the enclosing one, and blank lines carry no meaning (inside an open `(`-group the boundary is ignored, so a multi-line sub may return to column 0). It handles markers, `=` equality, `#def`/`#agg`/`#acc` commands, parenthesized/sequence sub-rules, dot-notation desugaring, `!(...)` compound constrain blocks, acc rules `body / head`, and bool-weight validation.

**Key terms:**
- `parse` — top-level entry (tokenize → `parseProgram`); returns a `Program` or a `ParseError` (`{ line, message }`)
- marker chars — `-~+^!?` map to a `Marker`
- dot-notation desugaring — threads fresh anchor vars across atoms/subs
- arity saturation — `saturateArity` pads each Symbol-headed atom with trailing wildcards up to its lexical arity (`:`-count + 1), run after dot-desugaring; over-arity atoms are left as-is (plans/v2-arity-auto-wildcard.md)
- ask atoms `?[actor] V1 .. Vn` — an optional `[actor]` group glued directly after the `?` marker (tokenizer consumes it into the atom text; a spaced `[` stays bracket aggregation) selects the resolving actor (`you` default, `rng` random — plans/v2-choice-actors.md); the ask shape is validated to one-or-more distinct Variables (no symbols/compounds/`_`/duplicates/weight)
- `!(...)` constrain blocks — parsed into compound `subAtoms`
- `[ Q | Out = op V ]` bracket aggregation — tokenized as a (possibly multi-line) `aggcomp` token, mini-parsed into a pre-expand `AggComp` atom (query items = plain match atoms or nested `[...]`, chainable with `.` dot notation via the shared `desugarBody` pass; reduction op ∈ count/sum/last/some/none). The output pattern left of a top-level `=` is optional: the bare form `[ Q | op V ]` desugars in `desugarBody` (where the rule's used-name set lives) by renaming `V`'s query-side occurrences to a fresh `V_k`, leaving `out` as the Variable `V` — today's behavior as a special case (plans/v2-agg-output-var.md, plans/v2-bracket-aggregation.md). The existence ops `some`/`none` (plans/v2-bracket-some.md) forbid the `Out =` form and set `out` to a `Wildcard`, so they produce no value and drop `V` from scope; `none` is the negation of `some` and additionally forbids any leftover group column (it binds nothing)
- `{p t1..tn => e}` exception blocks — tokenized on `{`/`}`, split on top-level `=>`; LHS a single unmarked Symbol-headed atom, RHS a body fragment (no nested exception, no dot adjacency; may be empty = bare suppression); becomes a pre-expand `Exception` atom (plans/v2-exceptions.md)
- bool-weight validation — enforces `-> bool` weight restrictions
- `#macro head P1..Pn := [ ... ]` macro definitions — the `#macro` command consumes its header through the `:=` and emits a `macroDef` token; the RHS tokenizes normally and arrives as the following `aggcomp` token, which reuses the multi-line `[` handling. Because the command marks the definition, `:=` keeps no special meaning anywhere else. `parseMacroDef` checks a Symbol head, distinct non-`_` Variable parameters, and `params.length === lexical arity`, then records a `MacroDef` in `Program.macros`. A definition is self-delimiting (it ends at its body's `]`, tracked by the `aggcomp` token's `endLine`), so no blank line is needed before the next definition or rule; only trailing content on the body's own line is an error (plans/v2-aggregation-synonyms.md)
- `#def`/`#agg` commands — rule naming and schema declarations
- `#acc name : col…` and `body / head` rules (plans/v2-acc-relations.md) — `parseAccDeclText` reads the columns (a Symbol is a key column's type; a bare `@op` or a group `(@op base)` is the one allowed agg column, validated against the acc-ops.ts registry; the `:` must be a standalone token). A standalone `/` (whitespace on both sides — `do/rest` stays a Symbol) tokenizes to a `slash` token, which `parseBodyItems` stops at (an error inside a group or an exception block); `parseProgram` then parses the head as a second body and `buildAccRule` assembles the `AccRule` — body restricted to matches and `=` after dot-desugaring, head exactly one unmarked, unweighted atom. `validateAccRule` runs after the loop (declaration order is free): head declared and of the declared arity, the agg column unwrapped from `(@op T)` / `()` to the contribution (checked against the op's `arity`), body weighted reads allowed only on `#reactive` relations. `#acc` names are disjoint from schema, js, js-def and macro names; auto-naming shares one counter with ordinary rules
- `#js-def name ±p1 .. ±pn { body }` — one js-relation clause (plans/v2-js-relations.md): unparenthesized signature with `+` (bound) / `-` (enumerated) mode marks, generator body collected with the `#js` one-liner/multi-line rules. Clauses accumulate per name in `Program.jsRels` (declaration order = selection priority); parse enforces same arity across a name's clauses, distinct mode vectors, and that js-relation names are disjoint from `#js` functions, macros, and schema (`#agg`/`#reactive`) declarations — a js relation claims its name exclusively, since match sites never read the store

# expand.ts

The expansion pipeline that lowers parsed pre-expand rules into the flat post-expand IR: it runs anchor decomposition (`decomposeRule` + `pruneChains`), universal rule-splitting on every `Emit`, dead-slice filtering, and semi-naive delta-variant generation. The core anchor-decomposition pass threads SSA running-anchor variables and a `*chain` fingerprint, lowering each marker (match/episode/fact/anchor/ask/constrain/aggregate) into the right combination of `Match`/`Emit`/`Le`/`AssertLt`/`Max`/`Min`/`Equal`. `Max`/`Min` appear only at matches (the anchor intersection with a stored tuple's endpoints); emit and sequence-sub anchor updates are statically determined by the running-anchor invariant and emit no atoms.

**Key terms:**
- `expand` — top-level pipeline: macros → exceptions → decompose → prune → split → filter → js-mode-resolve → delta-variants
- `expandStages` — same pipeline returning each named intermediate rule-list (`macroExpanded`/`decomposed`/`split`/`filtered`/`resolved`/`variants`); `expand` is its `variants`. Used by the `v2-cli.ts` `--stage` dumps
- `decomposeJsRel` — js relations (plans/v2-js-relations.md): a plain match atom whose head names a `#js-def` relation pushes a `JsIterate` (args enter the chain as essential, like a match's user vars) and leaves the running anchor untouched — js relations are timeless, so no `Le`/`Max`/`Min` and no `_l_/_r_` slots. Every other appearance of a js-relation name throws: non-match markers and weights here, `[ ... ]` query items in `aggCompOutCols`, exception LHS in `applyExceptions` — those all read tuples through paths a js relation never populates. Exception: a `!(...)` sub-atom naming a js relation is legal (plans/v2-js-rel-in-constrain.md) — `buildConstrainRowAtom` validates it (no `-> weight`, arity checked eagerly) and wraps it `*c-js` instead of `*c-plain`, so constraint-query enumerates the generator instead of reading the store. The `resolved` stage then runs `resolveJsModes` (js-rel.ts) on the post-split bodies, before delta variants (which only re-tag Match constraints)
- `expandMacros` — the pipeline's **first** pass: source-to-source elimination of aggregation-synonym uses, run before `applyExceptions` so exception rewriting sees the relation reads a macro body performs. Rejects recursion (direct or mutual), normalizes each macro body to be macro-free in topological order, checks that every parameter names an *outward* variable of its body (a top-level output column), then replaces each qualifying use — a `match`-marker atom with no weight whose head is a macro name — with a deep copy of the body under a name-keyed map: arguments for parameters, fresh names for everything else. Non-qualifying occurrences (other markers, `-> weight`, an exception LHS, an atom inside `!(...)`) are errors: a macro name is not a relation. Leaves `Program.macros` empty, so a second invocation is a no-op — `runFixpoint` also calls it directly, mirroring `applyExceptions` (plans/v2-aggregation-synonyms.md)
- `applyExceptions` — source-to-source elimination of `{p t1..tn => e}` `Exception` atoms before any other pass: renames emitting `p` occurrences to a fresh `_<p>_prime<k>` across the working set, has the host rule broadcast its context via a plain `_<p>_ctx<k>` anchor emit (exceptions never gate `;` progression; LHS vars are exception-local, with prefix-bound ones re-unified via the ctx payload), and generates `<rule>_watch<j>` / `<rule>_exn<j>` / `<rule>_default<j>` rules around a `bool` flag relation `_<p>_exn<k>` (the `_exn` rule is skipped for an empty RHS — bare suppression). The flag is keyed by the intercepted tuple — the LHS terms with each wildcard freshened to `_t<i>` — never by transported context: the watcher raises `_<p>_exn<k> t°` for the matched tuple, the `_exn` rule reads that flag and re-joins the ctx tuple to recover the prefix vars its RHS uses, and the default rule reads the flag for its own tuple (`aggregate _<p>_exn<k> W̄ -> 0`), so two `p'` tuples in one moment are intercepted independently and the default read always has every key bound (a free key column with no contributions yields no zero row) (plans/v2-exceptions.md, amended by plans/v2-exception-watchers.md and plans/v2-exception-tuple-keyed-flags.md). Also invoked directly by `runFixpoint` so `computeAggStrata` sees exception-free rules. Sets `Program.provLinks`: one `{head, prime, arity}` record per default rule, derived from the *final* default-rule bodies (a later exception on the same relation renames an earlier default's emit head), consumed by `resolveExceptionProvenance` in fixpoint.ts (plans/v2-exception-default-provenance.md)
- `decomposeReactiveRead` — a `#reactive head pat -> weight` read lowers to `Match [_aggval, head, pat…, weight, _]` with both endpoints pinned to the running anchor's left `XL` and the anchor left unchanged (plans/v2-moment-walk.md): it samples the value at the anchor's start and fires only once the walk has materialized that moment's row. No `_l_/_r_` slots, `Le`, `Max`, or `Min` — threading the point row's interval would collapse the anchor to a point
- `decomposeAccRead` — a plain match of an `#acc` relation in an ordinary rule lowers to `Match [name, pat…, _]` at `(XL, XL)` with the anchor unchanged (plans/v2-acc-relations.md §4.3): the same shape as a reactive read, sampling the relation at the anchor's start and blocked until the walk has resolved that moment. Any other appearance of an acc relation throws — a non-match marker or `-> weight` here, a `[ ... ]` query item in `aggCompOutCols`, a `!(...)` sub-atom in `buildConstrainRowAtom`, an exception LHS in `applyExceptions`
- `decomposeAccRule` — exported for acc.ts: lowers an `AccRule` to a flat body evaluated at one moment (plans/v2-acc-relations.md §4.1). The anchor is the Variable `_acc_m` (`ACC_MOMENT_VAR`, eval.ts); a stored-relation match becomes `Match [head, pat…, _id_k] at (_l_k, _r_k)` plus `Le _l_k _acc_m` / `Le _acc_m _r_k` (point containment, no Max/Min — the anchor never moves; the trailing `_id_k` binds the tuple's id for the firing identity); a read of another acc relation becomes `AccMatch` with a fresh moment Variable `_am_k`; a `#reactive` read goes through `decomposeReactiveRead` pinned to `_acc_m`; js relations and `=` as usual. The head becomes one `AccContribute` (`accHeadTerm` enforces range restriction — every head Variable bound by the body, no `_` — and lowers `@js(...)`; an arity-0 op's column is the unit atom). No split, pruning or delta variants
- `decomposeRule` — anchor-decomposition pass; threads SSA anchor vars and a `*chain` fingerprint, lowering each `Marker` to post-expand atoms. The ask case emits `_choose chooseId (atom) actor` (actor Symbol from the ask atom, default `you`) and statically rejects asking an already-bound variable (`state.seen` is the bound-so-far set) — an ask introduces only fresh choice variables (plans/v2-choice-actors.md)
- `splitRule` — slices a rule at every `Emit` into producer/consumer halves
- delta-variants — semi-naive cloning; tags one `Match` as `delta` and sets `deltaHead`/`deltaSafeSkip`
- fresh Id templates — per-firing fingerprint templates `*id`/`*var`/`*choose`/`*mom`
- `aggCompOutCols` — the **output columns** of a bracket-aggregation level in first-occurrence order (`joinCols − {V} ++ unbound vars of out`, where `joinCols` is the union of the items' output columns); also validates each level (`V` is a query column and not prefix-bound; `out`'s variables are disjoint from the query subtree's *genuine query positions* — atom columns and reduction variables at any level, but deliberately **not** a nested level's `out` variables, where sharing a name means "check the fold against that column" and is what makes `land:count X X` expressible). Must stay in step with `compOutCols` in comp-aggregate.ts, which reads the layout back (plans/v2-agg-output-var.md)
- `decomposeAggComp` — lowers a bracket aggregation `[ Q | Out = op V ]` into a paired `Emit (_do-aggc (*cq ...) (*cq-cols ...) idTpl)` / `Match (_agg-resultc (row V1..Vm) idTpl)`, following the `decomposeAggregate` pattern (plans/v2-bracket-aggregation.md; closed by comp-aggregate.ts)
- reserved symbols — `*chain`, `*conj`, `*c-plain`/`*c-agg`/`*c-js`, `_do-agg`, `_agg-result`, `_constrain`, `_dead-choice`, `*agg-empty`, plus the bracket-aggregation set `_do-aggc`, `_agg-resultc`, `*cq`, `*cq-atom`, `*cq-red`, `*cq-cols`, `*cq-any`, `*fv` (consumed downstream by scheduler/constraint-query/comp-aggregate)

# expand-liveness.ts

A backward-pass chain-liveness optimization run between `decomposeRule` and `splitRule`: it prunes non-essential, dead chain Variables out of `(*chain ...)` fingerprint templates and removes dead `Max`/`Min` anchor-SSA definitions. Pruning preserves correctness because producer/consumer split halves share the same (smaller) `idTpl` objects, so structural unification still recovers the surviving chain vars; essential identity-bearing vars are always kept to avoid dedup collisions.

**Key terms:**
- `pruneChains` — backward liveness pass; drops dead chain Variables from `*chain` templates and dead `Max`/`Min` anchor defs
- `live` / `essential` — downstream-referenced names vs. identity-bearing names that must be retained

# eval.ts

The single-rule evaluator: a CPS-style backtracking interpreter over the flat post-expand `RuleAtom` primitives, mutating a `Store` by matching stored tuples and emitting new ones. All anchor manipulation is now explicit IR, so this is a flat dispatch over `Match`/`Emit`/`Le`/`AssertLt`/`Max`/`Min`/`Equal`/`JsCall`/`JsIterate` (plus `AccMatch`/`AccContribute` inside acc rules) with a binding trail for backtracking; pre-expand atoms reaching it throw.

**Key terms:**
- `evaluateRule` — public entry; runs the CPS backtracking interpreter, mutating the `Store`. Takes an optional `AccEvalCtx` for lowered acc rules
- `AccEvalCtx` / `AccRow` / `ACC_MOMENT_VAR` — what an acc rule needs from acc.ts (plans/v2-acc-relations.md §5.3): `rows(relation)` (the local rows of the relations it reads: key/value terms plus the row's moment) and `contribute(relation, terms, moment, firing)`. `evalAccMatch` unifies the pattern against `[relation, ...row.terms]` and the moment Variable against the row's moment as a backtracking choice point; `evalAccContribute` substitutes the head terms, takes the lub of the matched tuples' lefts and matched acc rows' moments (the moment being resolved, bound to `_acc_m`, if no lub exists), joins the matched tuple ids into the firing identity, and calls `contribute`. Both throw outside an acc rule
- `evalSeq` — dispatches on atom tag and chains continuations over a binding trail (unwound on backtrack)
- `evalJsIterate` — enumerate a `#js-def` relation (plans/v2-js-relations.md): decode the resolved clause's `+`-position args, run its generator, unify each yielded array against the `-`-position arg terms as a backtracking choice point (a bound `-` arg filters). Steps the iterator manually so continuation errors (GasError) propagate unwrapped while user-body errors surface with the relation name; `JS_REL_YIELD_CAP` guards runaway generators
- consulted-moment recording — a `Match` whose head is in `store.accRelations` records its (bound) left endpoint in `store.accConsulted` before scanning candidates, so a read that matches nothing is recorded too. Display-only (acc-view.ts); acc rules read through `AccMatch` and never record
- semi-naive gen filter — a `Match`'s `delta`/`old` `MatchConstraint` filters candidates by generation

# js-values.ts

The single Term ↔ JS value boundary for user-defined `#js` functions (see `plans/v2-user-js-functions.md`): `decodeTerm` lowers a ground Term to a plain JS value for a `JsCall` argument, and `encodeTerm` lifts the return value back to a raw (un-hashconsed) Term. Compounds map to arrays, symbols to strings, numeric symbols to numbers, and booleans encode to the symbols `1`/`0`.

**Key terms:**
- `decodeTerm` / `encodeTerm` — ground `Term` → JS value (expanding `Ref`s) and JS value → raw `Term`
- term↔value mapping — compound ⇄ array, non-numeric Symbol ⇄ string, numeric Symbol → number, boolean → Symbol (encode-only)

# js-rel.ts

js relations (`#js-def`, plans/v2-js-relations.md): mode selection and clause compilation. A js relation is a set of generator clauses over one name/arity, each with a mode vector (`+` = bound at call, a JS parameter; `-` = enumerated, yielded). Modes are ordered `- < +` pointwise; `resolveJsModes` — run in `expandStages` between `filtered` and the delta variants, on the post-split flat bodies — does a left-to-right binding analysis per rule and stamps each `JsIterate` with the earliest declared clause ≤ the call site's modes (a `-` clause position serves a bound argument by yield-then-filter; no clause → compile error naming the rule and modes). Post-split is what makes cross-slice bindings visible: a consumer slice's leading Match unifies the stored row's trailing idTpl, so recovered chain variables count as bound.

**Key terms:**
- `resolveJsModes` — per-rule left-to-right binding analysis (Match/Emit bind everything they mention; Equal binds one side when the other is fully bound; JsCall/Max/Min bind `out`) + earliest-clause selection; sets `JsIterate.defIndex`
- `compileJsRels` / `CompiledJsRel` — compile each clause's body once via the generator-function constructor with the `+` params as JS parameters; consumed by `evalJsIterate`
- `JS_REL_YIELD_CAP` — per-call yield limit (no tuple is emitted between yields, so gas can't interrupt an infinite generator)

# store.ts

The v2 store: interval-bearing hashconsed tuples, head indexing, and the moment-order (partial-order) relation. It provides tuple insertion with dedup/gas/semi-naive bookkeeping, order-edge assertion (two strategies, lazy "old" vs "eager" forward-closure), reachability/comparability queries over moments, interval overlap/containment tests, and least-upper-bound (join) computation.

**Key terms:**
- `Store` / `createStore` — central state (hashcons table, tuples, head index, moment partial-order, gas, semi-naive generations, stats); factory seeds `bot`/`top`
- `intern` / `tokenOf` — hashcons wrappers; token = integer `Ref` id
- `addTuple` — interns and inserts a tuple with dedup, gas check, head bucketing, generation tracking
- `addOrder` — asserts a moment-order edge `lt < gt`; records the immediate predecessor in `orderBwd` under both strategies (moment-walk.ts computes its frontier from it)
- `resolved` — moment tokens the moment walk has resolved (a down-set of the order; in-memory, every run starts from a fresh store)
- `accRelations` / `accConsulted` — `#acc` display bookkeeping, never consulted by evaluation (plans/v2-acc-timeline-display.md): the declared acc relations with a static `readByRules` flag (set by `runFixpoint`: some expanded ordinary rule has a `Match` on the head), and per relation the moment tokens at which an ordinary rule's point read was attempted, matched or not (recorded by `evalMatch`)
- `lessThan` / `lessEq` / `comparable` — strict/non-strict order and comparability over moments (`bot`/`top` sentinels)
- `intervalsOverlap` / `intervalContains` — interval overlap and containment tests
- `candidatesByHead` — head-symbol-indexed tuple lookup (the match index)
- `leastUpperBound` — join over the moment lattice (`null` when ≥2 incomparable minimal upper bounds)
- `GasError` / `ORDER_STRATEGY` — tuple-budget exhaustion sentinel; lazy-`"old"` vs eager order-maintenance switch

# moment-walk.ts

The scheduler's interface for calculating things along the moment order (plans/v2-moment-walk.md). A Turn program has a monotone part (the rules, run to quiescence by fixpoint.ts's inner loop) and a non-monotone part (aggregate folds, choice resolution) that must observe a *complete* state at a moment. The walk stratifies the non-monotone part by the temporal order the monotone part computed: after each monotone fixpoint it takes the **frontier** — the minimal unresolved moments — and runs every registered `MomentHandler` at each of them. A handler may add tuples (`progress`), may be waiting on the outside world (`blocked`, a `you` choice), or may have nothing to do. A moment is marked **resolved** once a round makes no progress anywhere and no handler is blocked at it. The walk knows nothing about aggregates or choices; those are the handlers in scheduler.ts.

The moment set is every endpoint the store has seen (`store.momentTerms`) except `top`; `bot` is a moment (rule-initial `^` emits live at `(bot, top)`, and a rule-initial reactive read samples there). `store.resolved` is kept as a **down-set** of the order, which is what lets the frontier be computed from asserted predecessor edges alone: a moment is minimal iff every immediate predecessor in `store.orderBwd` (plus the implicit `bot`) is resolved. That edge test only ever *excludes*, and it excludes cycle members forever (the `"old"` order strategy never rejects a cycle; `a, (+p); +q` asserts one through a point anchor), so an empty edge-based frontier with moments still pending falls back to quadratic minimality under the strict order, which resolves a cycle as a unit.

**Key terms:**
- `MomentHandler` — `{ name, run(store, m) → { progress, blocked }, demanded?(store), resolve?(store, m) → boolean }`; `run` must be idempotent. `resolve` is called by `resolveMoments` once for each moment the walk marks resolved, after marking, so it sees the final state at `m`; it may add tuples at `m` (returns true iff it did). The acc handler (acc.ts) is its one user: acc rows are a snapshot of the state at `m` as of resolution, and what readers then emit at `m` does not re-open `m`. `demanded` lists moment tokens with pending work regardless of the frontier — used by demand-style handlers for rows whose left endpoint is *already resolved* (late work through a same-moment `^` chain); those moments are run alongside the frontier without being re-opened, since everything below them is settled
- `unresolvedMoments` / `frontier` / `markResolved` — the moment set minus `resolved` and `top`; its minimal elements (edge test, strict-order fallback); marking
- `runWalkRound` — one round: frontier ∪ late demanded moments, every handler at each, returns a `WalkRound` (`frontier`, `late`, `progress`, `blocked`, `exhausted`). Marks nothing — fixpoint.ts decides
- `resolveMoments` — run every handler's `resolve` at each just-marked moment; true iff any added a tuple (fixpoint.ts then re-enters the inner loop so readers of the new rows fire)

# acc-ops.ts

The `#acc` op registry (plans/v2-acc-relations.md §2.2, §5.5). Every aggregation op is a commutative monoid `(M, ⊕, e)` with two maps — η (`inject`: one contribution → monoid element, the unit of the free commutative monoid on values, which is why contributions form a *bag*) and ρ (`readout`: monoid element → zero or more value terms, the one coercion from "a value per key" to "rows of a relation"):

| stage | `@sum` | `@count` | `@min` | `@last` | `@arg-min` | boolean |
|---|---|---|---|---|---|---|
| η inject | a | 1 | a | {(t, a)} | {(a, n)} | true |
| ⊕ combine | + | + | min | ∪, keep temporal maxima | ∪, keep minimal n | ∨ |
| e identity | 0 | 0 | ∞ | ∅ | ∅ | false |
| ρ readout | {s} | {n} | {v}; ∞ ↦ ∅ | the set | the set | true ↦ {()}; false ↦ ∅ |
| idempotent | no | no | yes | yes | yes | yes |

Single- vs multi-valued is a property of ρ, not of the op; identities without a term read out as ∅; a keyless relation's zero row is `ρ(e)`; recursion through an op has a least fixpoint iff ⊕ is idempotent. One term representation per op: `@sum` reads numeric Symbols (the `sum` aggregator), `@count`/`@min`/`@arg-min` are Peano (`z` / `(s X)`, via `natValue`); η rejects the other spelling. **Adding an op**: (1) fill in a column of the table — if ⊕ is not commutative and associative it is a relation computed by an acc rule, not an op; pick one term representation; (2) add the entry to `ACC_OPS` — `AccOp` widens automatically and parse.ts/expand.ts read `arity` and `column`, so no parser change; `inject` throws on out-of-domain terms naming the term, `combine` keeps a canonical representative if the carrier admits several spellings, `readout` must not depend on combination order, `idempotent` must be truthful; (3) add samples to the law harness in `v2_acc.test.ts` (an entry without samples fails it); (4) add the op to the tutorial.

**Key terms:**
- `AccOpDef<M>` — `{ name, arity (0 | 1: does η take the head term?), column (rows carry a value column; false only for boolean), inject, identity, combine, readout, idempotent, internal? }`
- `ACC_OPS` / `AccOp` / `accOp` — the registry (`sum`, `count`, `min`, `last`, `arg-min`, and the internal `bool` that a declaration without an agg column uses), its key type, and the lookup (internal entries hidden unless asked for)
- `natValue` / `UNIT` — Peano reader (null for anything else, numeric Symbols included); the unit atom `()` an arity-0 head writes and boolean's ρ yields

# acc.ts

`#acc` relations, computed at moment resolution (plans/v2-acc-relations.md). An acc relation's rows are a function of the state alive at a moment: `body / head` rules derive contributions from the stored tuples alive at `m` (interval contains `[m, m]`) and from other acc relations' rows at `m`, the declared op folds them per key (`ρ(⊕ᵢ η(cᵢ))`, generic over the acc-ops.ts registry — no op-specific code here), and the result is written as point rows `name k… v <id>` at `[m, m]` with a deterministic `(*acc name k… v m)` id when the moment walk marks `m` resolved. Ordinary rules read them with a point match at their anchor's left endpoint (expand.ts `decomposeAccRead`). Evaluation stratifies the acc relations over their read dependencies (edge r → s when a rule with head s has an `AccMatch` on r; Tarjan's SCCs in dependency order), evaluates each stratum's lowered rules with `evaluateRule` under an `AccEvalCtx` (the body prefixed with `Equal _acc_m m`), and iterates a recursive stratum to a fixpoint with accumulating contributions — deduplicated by (key tokens, value token, moment token, firing identity), so two `hit x 3` facts both reach `@sum` while idempotent ops are unaffected. When every op in the SCC is idempotent that is a least fixpoint; otherwise the program is assumed well-defined and `ACC_ROUND_CAP` turns divergence into an error naming the stratum and moment. A keyless relation folds its single group even when empty (the zero row); a keyed relation has no row for absent keys. Each row records a moment (the readout's, or the group's lub) for downstream `@last` folds.

**Timing.** The handler does nothing in `run` rounds; its `resolve` hook fires once per marked moment, after every `#agg` / `#reactive` / bracket fold and same-moment `^` chain at `m` has settled. The rows it writes are progress, so the inner loop runs and readers at `m` fire — but `m` is already resolved, so what they emit at `m` is a snapshot boundary: not folded into `m`'s acc rows, only into later moments'.

**Key terms:**
- `compileAcc` — lower every acc rule (`decomposeAccRule`), resolve js modes, build the dependency graph and strata (`CompiledAcc`: `decls`, `strata` of `{ relations, rules, recursive }`)
- `computeAccAt` — the rows of every acc relation at a point `m` (`Map<relation, AccRow[]>`), stratum by stratum
- `accHandler` — the `MomentHandler`; `resolve` computes and writes the rows
- `ACC_ROUND_CAP` — rounds a recursive stratum may take at one moment before the run fails

# acc-view.ts

Display-side views of `#acc` rows (plans/v2-acc-timeline-display.md). DOM-free. The engine stores every acc relation's rows as point tuples at every resolved moment, so a value that holds for a while is stored once per moment; nothing here changes that — these functions fold the repetition back up for display.

`accRuns` merges each distinct row content (the row's user terms; the trailing id names the moment and is left out) into bars. It computes the Hasse covers of the asserted moment order (`bot` included, `top` excluded, non-cover asserted edges dropped via `lessThan`, cycles tolerated), and per content covers the moments it holds at greedily with chains along a linear extension: a moment extends a chain whose last moment it covers, otherwise it starts a new one. A chain's bar runs from its first moment — or from the fork moment, when it branches off another bar of the same content — to where it stops: the successor at which the content merges into another bar, else the first resolved successor (the value ended there; a closed edge), else the first unresolved successor or `top` (`open`: not "ended" but "not computed past here", e.g. blocked behind a choice). On a linear timeline that is one bar per stretch a value holds; on a branching one, a bar per branch. A bar over-approximates in one way: it runs through every column between its endpoints, including side-branch moments where the content does not hold — the ambiguity any episode bar has against incomparable moments.

**Key terms:**
- `accRuns` / `AccRun` — the merged bars: relation, `tupleIndex` of the row at the first moment, `lTok`/`rTok`, `open`, the `moments` held at, and `consulted` (the subset where `store.accConsulted` records a read)
- `accRelationVisible` — a per-relation override wins; otherwise a relation shows iff some ordinary rule reads it (pure intermediates start hidden)
- `isAccRow` — a point tuple of a declared acc relation
- `accSnapshot` / `AccSnapshot` — the moment inspector's data: every relation's rows at one moment, each `new` when some immediate (resolved) predecessor lacks it, plus the `gone` rows a predecessor has and this moment lacks, the `consulted` flag, and whether the moment is resolved. Ignores timeline visibility

# fixpoint.ts

The top-level evaluation driver. It expands a program, runs an inner loop firing all rules to quiescence (semi-naive), then runs the moment walk (moment-walk.ts): rounds of handlers at the frontier. A round that adds tuples hands back to the inner loop (`iteration++`, so the new rows are the next delta). A round that adds nothing resolves its unblocked frontier moments, runs the handlers' `resolve` hooks at them (`resolveMoments`; the acc handler writes its rows here — if any were added the loop hands back to the inner loop so readers fire), and otherwise the walk continues *without* re-running the rules — nothing changed — so a program with no pending work at a moment crosses it for the cost of a frontier computation. Only when every frontier moment is blocked on a choice does the loop surface the choices there: `computeComponents` seeded by the chooses at the blocked moments, the empty-fringe error, dead-choice marking, and rng auto-resolution, unchanged. `exhausted` (every moment resolved, nothing demanded) is `done`. Gas exhaustion is caught and surfaced as a `gas` status. The old `!progressed → done` safety net is gone: no progress simply means the moment resolves, which is the correct reading of an aggregate with an empty fold.

**Key terms:**
- `runFixpoint` — public entry; expands the program, compiles `#js`/`#js-def` bodies (`compileJsDefs`/`compileJsRels`), builds the handler list (`reactiveHandler`, `demandAggHandler`, `choiceHandler`, `accHandler`), seeds `store.accRelations` (each declared acc relation, `readByRules` iff an expanded rule matches on it), runs the loop, returns a `FixpointResult` (`{ store, iterations, status, rules }` — `rules` are the expanded rules the loop ran, used by `print.ts:tupleBindings`); catches `GasError` → `gas`
- `resolveExceptionProvenance` — post-fixpoint `tupleSource` fixup on every return path (including `gas`): an exception default rule re-emits a matched `_<p>_prime<k>` tuple with identical args and endpoints (only head + trailing id slot differ) but its Emit's static span is the exception's line; this pass re-attributes each tuple of a `Program.provLinks` head to the span of its structurally matching prime tuple, following links transitively for chained exceptions, keeping the tuple's own span when no match exists (emits that escaped renaming: weighted or off-arity). So `tupleSource` is not always the firing Emit's span (plans/v2-exception-default-provenance.md)
- inner loop / outer loop — fire all rules to quiescence, then walk the moment order (above) until a handler adds tuples (re-enter) or the frontier is fully blocked (surface choices). A component with **zero option tuples** never surfaces: under the temporal-monotonicity assumption (the component is evaluated at its quiescent moment `M`, and no later emission's interval can contain `M`) it can never gain options, so every active term is marked dead via a `_dead-choice <term>` row (`markDeadChoice`) and the loop re-enters — the owning asks stop blocking, no `is` row ever appears, and their `.is` continuations simply never fire (Ceptre's "transition not applicable"). Applies to `you` and `rng` components alike. Components whose controlling (highest) actor is `rng` don't surface: `resolveRngChoice` commits them and the loop re-enters; mixed components surface for the user's `you` terms first (plans/v2-choice-actors.md). `runFixpoint` accepts `options.random` (seedable) and reports every roll in `FixpointResult.rngCommits` so the harness persists them as `^ is` rows (web-v2 appends them, gated on the source being unchanged since the run started). The stream is latched at the first roll: an explicit `options.random` wins, else a program seed (`+ rng-seed n` via `programSeededRandom`), else `Math.random`; later `rng-seed` tuples have no effect
- delta-safe skip — skips rules with empty deltas via `deltaSafeSkip`/`deltaHead`/`prevHeads`

# scheduler.ts

The non-monotone part of a program, packaged as moment handlers for the moment walk (moment-walk.ts, plans/v2-moment-walk.md). Three handlers: **demand aggregates** close blocked `_do-agg` / `_do-aggc` rows whose left endpoint is the moment being walked (today's fold semantics — containment of the producer's `[l, r]`, `*agg-empty` sentinel — untouched; rows at an already-resolved moment are `demanded` and closed on the next round), **choices** report a moment blocked while an unresolved `_choose` row starts there (surfacing itself stays in fixpoint.ts), and **reactive aggregates** below. It also exports `aggregateOver`, the generic grouped-aggregation engine (shared with constraint-query and default-display). `#acc` (acc.ts) is the successor to `#reactive`: same point-read semantics, but the value is computed by `/` rules at resolution rather than folded from asserted contributions; `#reactive` stays until the corpus has migrated (plans/v2-acc-relations.md §10).

**Reactive aggregates** (`#reactive rel -> agg`; declaration from plans/v2-reactive-aggregates.md, scheduling from plans/v2-moment-walk.md): a reactive relation's value is a function of moments, and the handler simply recomputes it at every moment the walk visits — `aggregateOver` over the contributors alive at the point `m`, one **point row** `_aggval head key… value` at `[m, m]` per group, with a deterministic id so re-folding dedups. No breakpoints, join-closure, or residual detection. A reactive read (`decomposeReactiveRead`, expand.ts) matches the row at exactly its anchor's left endpoint, so it *samples* the value there and is blocked — has no candidate — until the walk resolves that moment; the semi-naive delta on `_aggval` wakes it. Same-moment ordering keeps the static strata (`computeAggStrata`, the `=`-edge analysis of plans/v2-stratification-analysis.md), applied inside the handler: it folds the lowest stratum first and returns as soon as a stratum adds rows, so a consumer (`count` of a same-moment transitive closure) is folded only once every lower stratum has settled at `m`. Zero rows follow `aggregateOver`: a keyless `sum`/`count`/`bool` gets its zero row at every moment (a relation with no contributors at all is folded keyless), a keyed relation yields nothing for absent groups — so negation through a keyed reactive read is not available; use `#agg`.

**Key terms:**
- `aggregateOver` — generic grouped aggregation: matches a `[head, keys…, weight]` pattern with `_free` wildcards and folds via the schema aggregator (`sum`/`count`/`last`); shared with constraint-query and default-display
- `demandAggHandler` / `choiceHandler` / `reactiveHandler` — the three `MomentHandler` factories consumed by `runFixpoint`
- `foldReactiveAt` — fold every group of a reactive relation alive at a point (contributors bucketed by stored width, since `SchemaDecl` records no arity) and emit the `_aggval` rows
- `collectBlockedDoAggs` / `collectBlockedChooses` — find `_do-agg` rows lacking an `_agg-result`, and `_choose` rows with unresolved active terms (reading the actor column at terms[3], defaulting `you`); the demand handler also pulls in blocked bracket-aggregation rows (`collectBlockedDoAggCs`, from comp-aggregate.ts)
- `markDeadChoice` / `resolvedChoiceTokens` / `_dead-choice` — dead-choice resolution: the fixpoint loop marks each active term of a zero-option component with a `_dead-choice <term>` row at `(bot, top)`; `resolvedChoiceTokens` treats those markers as resolutions alongside `is` rows (constraint-query's `gatherChoiceContext` reads them the same way, with no substitution value — a constrain pattern still mentioning a dead term can never match, so entangled survivors die on a later round)
- `resolveRngChoice` / `RngCommit` — auto-resolve one all-`rng` component (plans/v2-choice-actors.md): pick one option tuple uniformly at random (uniform over joint assignments) and commit every active term via `is <term> <value>` rows at `(bot, top)` with a `(*rng <term>)` trailing id; returns null on zero options
- `programSeededRandom` / `mulberry32` — program-provided rng seed: the user relation `rng-seed` with one numeric argument (`+ rng-seed 42`, asserted once at startup) yields a deterministic mulberry32 stream; distinct values or a non-numeric argument are errors, duplicates of one value are fine
- `closeDoAgg` — computes a blocked aggregate and emits its `_agg-result` rows
- `computeAggStrata` — static same-moment dependency strata over the reactive relations (`=`-edges only); consumed by `reactiveHandler`
- `_free` — wildcard key position marking a group-by slot
- `_aggval` — materialized reactive aggregate value row (`_aggval head key… value`) at the point `[m, m]`

# comp-aggregate.ts

Close logic for bracket aggregation `[ Q | Out = op V ]` (plans/v2-bracket-aggregation.md, plans/v2-agg-output-var.md): at outer-loop quiescence it finds `_do-aggc` rows lacking a matching `_agg-resultc` row, decodes the wrapped `(*cq ...)` query, evaluates it as a backtracking conjunctive join restricted to tuples whose intervals contain the producer's anchor, reduces per group (`count`/`sum` on the deduped binding set; `last` selects maximal derivations by the lub of contributor left endpoints; `some` emits one row per non-empty group with no folded value; `none` emits a single empty row iff the query has no derivations), unifies each group's folded value against the `out` pattern (a group that fails to unify produces no row) to build the result row from the group key plus whatever `out` binds, and emits `_agg-resultc` result rows keyed by the copied trailing id. An aggregate that yields *no* rows (an empty `last`, or count/sum with a nonempty group key and no groups) still emits one `_agg-resultc *agg-empty <id>` sentinel: it resolves the producer so the outer loop keeps making progress, and being a Symbol it never unifies with the consumer `Match`'s Atom row pattern, so the consumer correctly does not fire. `closeDoAgg` (scheduler.ts) does the same for `_do-agg`/`_agg-result`. Without the sentinel a single empty aggregate at an early moment silently stalled every later aggregate, since the outer loop only works the earliest blocked tier. Nested `[...]` items are evaluated recursively inside one close and join like virtual relations.

**Key terms:**
- `collectBlockedDoAggCs` / `BlockedDoAggC` — `_do-aggc` rows whose trailing id has no `_agg-resultc` row yet
- `closeDoAggC` — decode + evaluate + reduce one blocked row; emits `_agg-resultc (row v1..vm) <id>` at the producer's endpoints
- `decodeComp` / `decodeCols` — decode the `(*cq (*cq-red op (*fv :V)) item...)` query and `(*cq-cols ...)` result-row layout
- `joinItems` / `matchTerm` — backtracking join; `(*fv :name)` positions bind/check a substitution, `*cq-any` matches anything, ground positions compare by token
- `reduceRows` — set-semantics dedup + group-by-key fold (`count`/`sum`), maximal-derivation selection by binding moment (`last`), one-row-per-non-empty-group existence (`some`, no fold, empty input → no rows), or its negation (`none`, one empty row iff the query is empty); zero-row policy mirrors `aggregateOver`
- binding moment — lub of the contributor tuples' left endpoints; `last`'s selection order

# constraint-query.ts

Per-component option enumeration for active choices (the `?`/`choose` mechanism). At outer-loop quiescence it gathers active terms from blocked `choose` rows, resolves any bound via `is` rows, builds connected components over the `_constrain` rows that mention them, then runs a backtracking conjunctive query per component (evaluated at a single "choice component moment") to produce deduped option tuples for each set of entangled active terms.

**Key terms:**
- `computeComponents` — main export; groups blocked chooses into connected components over shared `_constrain` rows, returning `ComponentOptions` per component (including per-active-term `actors`, from each term's owning choose row via `actorByTok`)
- `ConstrainRow` — a parsed `_constrain (*conj …)` row (`kind` plain/agg/js) touching active tokens
- `choiceComponentMoment` — the single moment a component is evaluated at (lub of its rows' left endpoints)
- `runComponent` — backtracking conjunctive query producing deduped option tuples; the component's sub-atoms are flattened into one list with `*c-js` subs scheduled last (a component is semantically one conjunction, so order only affects mode availability — js-last maximizes boundness and makes behavior independent of store discovery order)
- `runJsSub` — a `#js-def` relation inside `!(...)` (plans/v2-js-rel-in-constrain.md): mirrors `evalJsIterate` under the constraint-query substitution model — clause selection is *dynamic* (a position is `+` iff its pattern term is ground under the current substitution, per `containsSlot`; earliest declared clause ≤ the call's modes wins, as in `resolveJsModes`), `+` args are decoded for the generator, yielded rows are interned and matched against `-`-position patterns; timeless, so the component moment doesn't gate it; reuses `JS_REL_YIELD_CAP`
- active vs. existential terms — `*choose`/`*id` choice slots vs. `*var` existentials; `is` rows bind resolved values
- empty-fringe error — a component with active members but no constrain rows (an unconstrained `?`)

# stats.ts

Diagnostic counters for v2 fixpoint runs: per-rule, per-head, and per-iteration statistics plus a text report formatter. Counters are cheap unconditional integer adds; only wall-clock timing is gated by `enabled`.

**Key terms:**
- `StatsTracker` — per-rule / per-head / per-iteration counters; timing gated by `enabled`
- `createTracker` / `attachRules` / `getOrCreateHead` — construction and accessors (called from store/eval/fixpoint)
- `formatReport` — assembles the text report (top rules, top heads, per-iteration table, candidate funnel)

# print.ts

The surface-syntax printer for hashconsed v2 terms, producing text that `parse` can re-accept. It enforces an id-opacity invariant (ids render as opaque `*<id>` handles, never unfolded) and offers both shallow and full renderers plus two share-aware DAG dumpers that emit each `Ref` body exactly once to avoid exponential blowup.

**Key terms:**
- `renderTerm` / `renderAtom` — full surface render (re-parseable); stops at Id-backed `Ref`s
- `renderTermShallow` / `renderAtomShallow` — render that stops at any `Ref` boundary (`*<id>`); used by render-output/timeline
- `atomFingerprint` — 64-bit structural hash of a stored atom *including* its trailing id slot: identity for a tuple across re-evaluations, where hashcons tokens (allocation counters) shift. Hashes names and structure only, memoized per `Ref` on a per-`Store` `WeakMap`, so it costs one visit per distinct ref — the id bodies are DAGs whose expansion is exponential in derivation depth (a ttt atom expands to ~9.5M nodes) and must never be materialized. Used for the timeline's collapse keys
- id-opacity invariant — `Id`s always render as opaque `*<id>` handles, never unfolded
- `tokensEq` — token-level term equality via hashcons tokens
- `compressRefs` — share-aware DAG dump: each `Ref` body emitted once as `= V<i> (…)`
- `renderDebugDump` — flat hashcons + db dump (preferred ad-hoc debugging tool)
- `tupleBindings` — per-tuple binding environment decoded with no evaluator support (plans/v2-live-values-in-editor.md): zips the stored tuple's trailing `(*id rule lexPos (*chain …))` slot against the expanded rule's `Emit` template with the same `(head, rule, lexPos)`, keeping chain positions whose template term is a user `Variable` (names not `_`-prefixed). Returns `{ ruleName, bindings: [{name, term}] }` in first-occurrence order, or `undefined` for tuples without a decodable id slot; values are stored terms (render with `renderTermShallow` for `*id`)

# print-ir.ts

A DOM-free, Store-free debug renderer for the raw (un-hashconsed) IR — `Term` / `RuleAtom` / `Rule` / `Program` as produced by `parse` and the `expand` sub-stages (`print.ts` only handles hashconsed terms reached through a `Store`). Used by the `v2-cli.ts` `--stage` dumps. Output is debug-oriented (one tag-prefixed line per atom) and not guaranteed to round-trip through `parse`; it honors the same id-opacity invariant as `print.ts` (`Id`/`Ref` render as opaque handles).

**Key terms:**
- `renderTermRaw` — raw `Term` render; `Id` literals and stray `Ref`s stay opaque
- `renderRuleAtom` — one line per atom tag, showing `Match` semi-naive constraint and `Atom` marker/weight
- `renderRule` / `renderProgram` — `#def`/`#agg`/`#js` headers plus indented atom lines; `RenderOptions.lines` prefixes each atom with its source line (`Lnn`)

# render-output.ts

UI glue that renders a store into a DOM host as either a syntax-highlighted tuple listing (grouped by head symbol or ordered temporally) or a horizontal timeline. Tuples are rendered as HTML spans with source-line data attributes and aligned interval columns; the timeline path delegates to `timeline.ts`.

**Key terms:**
- `renderTuples` — tuple-listing renderer (grouped by head or temporally ordered) into HTML spans with source-line attributes; each row also carries `data-tl-tuple` (its store index, the same attribute the timeline stamps) so `source-link.ts` can decode live values for a clicked row
- `renderTimelineH` — horizontal timeline view (delegates to `timeline.ts`; `momentStyle` spine|edges variant, defaulting to edges). With `accControls` (web-v2; pres embeds get the bare timeline) and a program that declares acc relations, the host also gets a strip of per-relation checkboxes above the SVG (`data-acc-toggle`, checked per `accRelationVisible`) and, when `inspectKey` resolves to a moment, the **moment inspector** below it (`renderMomentInspector` over `accSnapshot`: `+` new rows, struck `−` gone rows, a `read here` badge; `data-acc-inspector-close`). The host owns the state and events: web-v2 keeps `accOverrides` by relation name and `inspectKey` by `momentKey`, toggled by clicking a moment dot (`data-tl-moment`)
- `momentKey` — a moment's identity across re-evaluations (`atomFingerprint` of the moment term), like `timelineCollapseKey` for episodes
- `timelineCollapseKey` / `resolveCollapsed` — collapse identity for an episode (`atomFingerprint`: token-free, so it survives edits and appended `is` rows) and its resolution against a store into `CollapsedInterval`s
- `temporalOrder` — orders tuples by longest-path depth via `lessThan`
- `hideInternal` / `temporal` — view options (hide `_`-prefixed internal rows; temporal vs. grouped)

# timeline.ts

Renders a v2 store as a timeline visualization (SVG or ASCII): moments are laid out along a time axis using a Hasse-reduced partial order, episode (`~`) tuples become labeled bars stacked in lanes, fact (`+`) tuples become lines + labels, and `is`/`constrain` rows are pulled into a sidebar. The layout pass is orientation-agnostic and is then mapped to pixels by a projector supporting horizontal and vertical orientations plus three lane-packing strategies. A horizontal-only `MomentStyle` "edges" variant (plans/v2-timeline-edge-moments.md) gives each moment its own column, but with two-tier spacing (plans/v2-timeline-fractional-columns.md): columns are ordered by (longest-path rank, token), and per-step gaps are floored to the full step (`minColWidth`) across a rank boundary but only to a small fractional width (`minFracWidth`) between same-rank — necessarily incomparable — moments, so comparable moments stay a step apart while incomparable ones cluster tightly. It draws each moment's dot on a canonical bar edge (dashed vertical ties to other bars sharing the moment), and replaces spine arrows with orthogonal dot-to-dot cover arrows (right/up/down only, routed around bars by fewest crossings then fewest turns), suppressing pairs a bar already shows as its own endpoints.

Episodes listed in `opts.collapsed` render collapsed: episodes contained in a collapsed interval `[l, r]`, and facts whose start moment lies in `[l, r)`, are dropped before ranking (so the interior moments vanish with them), and the interval is replaced by a single narrow `name...` bar (the collapsed episode's head symbol; width floored at `COLLAPSED_BAR_W` and never sized to what it hides) that keeps the collapsed episode's tuple index for source linking. Containment is judged against the uncollapsed reachability and includes the endpoints, so co-extensive episodes (`~a, ^b` puts two bars on one interval) collapse as a unit into one stand-in and expand together. The entry's `tupleIndex` names the owning episode: it decides the stand-in's label and click target, not what is hidden. Nested collapsed intervals are subsumed by their outermost container, and collapses over the same interval are one collapse. `web-v2.ts` toggles collapse by right-clicking a bar, keyed by `timelineCollapseKey` so it survives re-evaluation.

**Key terms:**
- `renderTimeline` — builds the SVG (Hasse arrows, moment dots, episode bars, fact stubs) + sidebar; used by render-output
- merged `#acc` bars (plans/v2-acc-timeline-display.md) — acc rows are never drawn one by one: `layoutTimeline` skips them (`isAccRow`) and adds one bar per `accRuns` entry of a visible relation (`opts.accOverrides`, `accRelationVisible`), carrying `Bar.acc` (`AccBarInfo`: relation, `open`, displayed `consulted` moments, moment count). Their endpoints and read moments join the displayed moment set (read moments strictly inside a collapsed interval do not resurrect it); a bar inside a collapsed interval folds away like an episode. They are packed apart from the episodes by `packAccBand`, in a band of lanes above them — most run to `top`, so in the containment forest they would adopt every later episode — one run of lanes per relation, first free lane within it, so a key's successive values read along one lane like a track. Moment dots anchor on episode edges before acc bars. Drawn square-cornered (`tl-bar-acc`, `data-tl-acc`), an `open` bar with a dashed later edge (a `stroke-dasharray` walking the rect outline), and a read marker (`tl-acc-read`) on the bar's outer corner at each consulted moment. Moment dots get a transparent hit disc with `data-tl-moment` (the inspector's click target) and `opts.selectedMoment` draws a ring
- `layoutTimeline` — orientation-agnostic layout: ranks moments by Hasse-reduced order, classifies tuples, packs lanes. A **point bar** (a tuple stored at `[m, m]`; `#acc` rows were the original source but are now merged, see above) has no extent, so the placers' non-strict "temporally disjoint" test alone would stack all the points at one moment, and the bars starting or ending there, on one lane; `isPointBar` / `barsTouch` make a point conflict with every bar it touches (`makePlacer.fits`, and a half-rank frontier in `placeBar`), and the width pass reserves the gap after a point's rank for its label, like a fact label
- `CollapsedInterval` / `opts.collapsed` — moment-token pair plus owning `tupleIndex`, drawn as one `name...` bar hiding everything the interval contains
- `Orientation` / `LaneMode` / `MomentStyle` — horizontal|vertical axis; compact|nested|tree bar-packing; spine|edges moment placement
- `momentAnchor` / `momentTies` / `orderPairs` — edges-variant layout outputs: canonical dot per moment, dashed ties, drawn cover pairs
- `renderTimelineAscii` — headless text rendering (no DOM/canvas)
- episode (`~`) bars / fact (`+`) lines — the two tuple classes laid out; `is`/`_constrain` rows go to a sidebar
- `data-source-span` — stamped (via `spanKey`) on bar rects/labels, fact labels, and sidebar rows from `store.tupleSource`, consumed by `source-link.ts`; every `Emit.span` carries columns, and span-less tuples (aggregate values) stamp nothing

# editor.ts

A self-contained code-editor wrapper around a `<textarea>` that adds a line-number gutter, smart editing keybindings (indent/dedent, auto-indent on Enter, smart Home/Delete), auto-grow, a freeze (read-only) mode, an optional symbol/variable completion overlay, a line-highlight overlay + caret helpers for source ↔ output linking, and debounced autosave to either a URL query param or a server endpoint. All edits go through `execCommand("insertText")` so native undo and input events keep working.

**Key terms:**
- `Editor` — textarea wrapper adding a line-number gutter, smart-edit keybindings, auto-grow, freeze mode, autocomplete, and autosave
- `SaveBackend` — autosave target: `none` | `server` | `url-param`
- `setFrozen` — read-only mode toggle
- smart editing — indent/dedent, auto-indent on Enter, smart Home/Delete, all via `execCommand` so native undo works
- `enableAutocomplete` — opt-in flag (on for index-v2, off for pres) for the completion overlay; logic lives in `autocomplete.ts`
- caret mirror — off-screen div replicating textarea metrics to position the completion box at the cursor
- `scheduleSave` — debounced (400ms) autosave to a URL param or server endpoint
- `highlightLine` / `highlightRange` / `clearHighlight` / `focusLine` / `caretLine` / `caretPos` — highlight overlay (full line, or a column range mapped col → px off a hidden monospace probe) and caret helpers used by `source-link.ts`
- `setLineNotes` / `clearLineNotes` / `LineNote` — live-value notes (plans/v2-live-values-in-editor.md): faint `X *17` name/value pairs drawn just right of each annotated line's text in an `.editor-notes` overlay (per-row `.editor-note`, positioned off the gutter row and the tab-expanded line length × char width; clipped to the text viewport; re-laid on scroll; cleared on input since line numbers go stale)

# source-link.ts

Bidirectional source-atom ↔ output linking shared by the v2 editor page (`web-v2.ts`) and presentation-mode code blocks (`pres/render.ts`); see plans/v2-source-timeline-link.md and plans/v2-atom-span-provenance.md. One linker binds one `Editor` to N output roots whose renderers stamp `data-source-span` (a `spanKey`; db rows from `render-output.ts`, timeline bars/facts/sidebar rows from `timeline.ts`). Forward: the caret sitting inside an emitting atom highlights that atom's elements across all outputs; a caret elsewhere on the line falls back to all of the line's emitting atoms (db rows scroll into view; the timeline never auto-scrolls). Reverse: hovering a linked element shows the editor's column-range overlay and lights up same-atom siblings; clicking moves the caret into that atom. `Ctrl-.` cycles through the active atom's timeline occurrences, centering each in its scroll container in turn and wrapping around.

**Key terms:**
- `attachSourceLink` — binds an `Editor` + output roots; installs delegated hover/click handlers, caret tracking, and the `Ctrl-.` binding
- `collectPositiveSpans` — emitting-atom spans indexed by line; the caret column picks the containing span
- `collectVarLines` / `lineNotesFor` — live values (plans/v2-live-values-in-editor.md): per rule name, each variable's first-occurrence `{line, col}` (walked over the pre-expand body: subs, `!(...)` sub-atoms, weights, `[...]` bodies); on click, the target's `data-tl-tuple` is decoded with `print.ts:tupleBindings` (store + expanded rules come from `opts.getRun`) and grouped per line into `LineNote`s for `Editor.setLineNotes` — a tuple with no decodable bindings clears the notes; `update()` also clears them
- `SourceLink` — handle: `update(rules)` after each run, `setCaretLine`, `destroy`
- `collectPositiveLines` — source lines with at least one emitting atom (assert `~`/`+`/`^`, ask `?`, constrain `!`); only these get forward highlights
- `source-highlight` / `hover-highlight` / `cycle-focus` — CSS classes applied to matched output elements (hosts style them)
- cycle state — `{ line, presses }`; press N scrolls to occurrence N mod count, reset on caret-line change or `update`

# autocomplete.ts

The DOM-free core of the editor's symbol/variable completion (`editor.ts` owns the overlay box and caret geometry; this module owns the data). Given the editor text and the partial token under the cursor, it returns ranked completions: symbols come from the whole program (lexer-derived, so they survive a parse failure), variables come from the rule containing the cursor (parse required — disabled when the program doesn't parse). See plans/v2-editor-autocomplete.md.

**Key terms:**
- `suggestionsFor` — top entry: dispatch on token class (symbol vs variable) and rank
- `completions` — ranking: exact match suppresses; strict-prefix matches first, then subsequence matches; capped at 5
- `collectProgramSymbols` — all Symbol tokens in the text (via the lexer; lenient fallback if even tokenizing fails); excludes `*`-headed internal symbols
- `collectRuleVariables` — Variables of the rule whose source span contains a given line; `null` on parse failure

# default-display.ts

The bundled fallback display module (used when a program declares no `-- display:` directive). It renders an interactive icon tree from `icon T` / `icon:name` / `at X -> L` relations filtered to the selected choice-component's moment, arranges each container's siblings per `left:right` / `above:below` constraints (via `icon-layout.ts`), shows clickable group/chip headers for active choice components, and commits choices via `DisplayApi.commit` when an icon matches a component slot (with a pending state for ambiguous multi-slot matches).

**Key terms:**
- `createDefaultDisplay` — factory for the fallback `DisplayModule` (used when no `-- display:` directive)
- `DisplayModule` / `DisplayApi` — the render interface and host callbacks (`peek`, `renderTerm`, `tokensEq`, `commit`, `addStyles`)
- icon tree — built from `icon` / `icon:name` / `at X -> L` rows within the selected component's moment
- `ClickIntent` / `commit` — clicking an icon matching a choice slot commits `{ activeTerms, optionTuple }`; rng-labeled slots are excluded from candidate matching and singleton-row commits bind only the `you` columns (plans/v2-choice-actors.md)
- `aggregateOver` — used to resolve `at` parent links when a schema is present
- `collectConstraints` / `scopeConstraints` — read `left:right` / `above:below` rows at the moment, then keep each one only in containers where both endpoints are siblings (`ROOT_KEY` is the top-level container); the rest are counted for a warning
- `renderContainer` — one container's icons: plain wrapping row when the layout is a single cell, otherwise a `.dd-grid` with one `.dd-grid-cell` per occupied position

# icon-layout.ts

Grid packing for the default display, store-free and DOM-free so it can be tested headless. Given one container's sibling icon keys plus `left:right` / `above:below` edges, it assigns each icon a `(row, col)` by longest-path layering: column = depth in the `left:right` DAG, row = depth in the `above:below` DAG, so every surviving edge is strictly satisfied and icons pack up-and-left. The two axes are independent — a cycle drops only its own axis's edges. With no constraints everything lands in cell `(0,0)`, which the caller renders as the historical wrapping row. See plans/v2-icon-layout.md.

**Key terms:**
- `layoutIcons` — top entry: members + edges → `IconLayout` (`placements`, `rows`, `cols`, `hCycle`, `vCycle`)
- `longestPathDepths` — memoized DFS over predecessors; on a cycle reports `cycle: true` and flat depths
- `siblingEdges` — drops self-edges and edges naming non-members, so callers may pass a superset
- `isTrivialLayout` — single-cell test; the caller's signal to skip the grid entirely

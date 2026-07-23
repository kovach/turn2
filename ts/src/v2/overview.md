Summaries of each `.ts` file under `ts/src/v2/`, roughly following the compilation pipeline: **parse → expand → fixpoint eval (store) → render**. The first four files (`term.ts`, `hashcons.ts`, `unify.ts`, `aggregators.ts`) are the core term layer, duplicated from v1 so v2 is free-standing (see `plans/v1-cleanup.md`); the deprecated v1 originals live under `ts/src/v1/`.

# term.ts

The core term layer: the `Term`/`Atom` data types shared by every phase, source `Span`s, the `NodeId` token key space, and the substitution `Trail` (two parallel mutable arrays; bind = push, backtrack = truncate). Duplicated from the v1 `types.ts`, minus the v1-only `Tree`/`Constraint`/`TurnExpr` IRs.

**Key terms:**
- `Term` — the term algebra: `Symbol` | `Variable` | `Atom` | `Id` | `Wildcard` | `Ref`
- `Atom` / `Span` — a term list; a 1-indexed source position
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
- `RuleAtom` — the core tagged-union IR node: pre-expand (`Atom`, `Sub`, `AggComp`, `Exception`), both-phase (`Equal`, `JsCall`), post-expand (`Match`, `Emit`, `Le`, `AssertLt`, `Max`, `Min`)
- `Marker` — pre-expand source marker (`match`/`episode`/`fact`/`anchor`/`ask`/`constrain`/`aggregate`) driving desugaring
- `MatchConstraint` — semi-naive eval tag (`"any" | "delta" | "old"`) on `Match` atoms
- `Rule` / `Program` — named rule (body + delta fields) and the top-level container (`rules`, `schema`, `jsDefs`, `macros`)
- `MacroDef` — an aggregation synonym `#macro head P1..Pn := [ ... ]`: a name, arity-many distinct parameter variable names, and one `AggComp` body. Eliminated by `expandMacros` (plans/v2-aggregation-synonyms.md)
- `AggComp.reduce` — `{ op, varName, out, bare }`: the reduction op, the query-side column `varName` being folded (internal to the query, invisible outward), and the pattern `out` unified against the folded value (binds its unbound variables outward, or filters). `bare` flags the sugar `[ Q | op V ]`, which the parser desugars by freshening `V` on the query side (plans/v2-agg-output-var.md). The existence ops `some`/`none` (`[ Q | some V ]`, plans/v2-bracket-some.md) have no folded value: `out` is a `Wildcard` (encoded as `*cq-any`), so they bind nothing and contribute no output column — `V` is eliminated from scope and `some` acts as a guard binding only `joinCols − {V}`. `none` is the negation (succeeds iff the query is empty) and requires `joinCols − {V}` be empty (it binds nothing at all)
- `Tuple` — stored datum: `atom` plus interval endpoints `l`/`r`
- `SchemaDecl` / `JsDef` — relation→aggregator declaration; user-defined `#js` function
- `FixpointStatus` — run outcome (`done`/`gas`/`active-choices`/`empty-fringe-error`)
- `ComponentOptions` / `BlockedChoose` — per-component choice enumeration; a blocked choose row

# parse.ts

The v2 parser for the flat-syntax language: it tokenizes input line-by-line (comment- and indentation-aware) then turns the token stream into a `Program` (rules + schema), without applying hashconsing. Rule boundaries follow the offside rule: a line whose first character is at column 0 starts a new definition, indented lines continue the enclosing one, and blank lines carry no meaning (inside an open `(`-group the boundary is ignored, so a multi-line sub may return to column 0). It handles markers, `=` equality, `#def`/`#agg` commands, parenthesized/sequence sub-rules, dot-notation desugaring, `!(...)` compound constrain blocks, and bool-weight validation.

**Key terms:**
- `parse` — top-level entry (tokenize → `parseProgram`); returns a `Program` or a `ParseError` (`{ line, message }`)
- marker chars — `-~+^!?` map to a `Marker`
- dot-notation desugaring — threads fresh anchor vars across atoms/subs
- arity saturation — `saturateArity` pads each Symbol-headed atom with trailing wildcards up to its lexical arity (`:`-count + 1), run after dot-desugaring; over-arity atoms are left as-is (plans/v2-arity-auto-wildcard.md)
- `!(...)` constrain blocks — parsed into compound `subAtoms`
- `[ Q | Out = op V ]` bracket aggregation — tokenized as a (possibly multi-line) `aggcomp` token, mini-parsed into a pre-expand `AggComp` atom (query items = plain match atoms or nested `[...]`, chainable with `.` dot notation via the shared `desugarBody` pass; reduction op ∈ count/sum/last/some/none). The output pattern left of a top-level `=` is optional: the bare form `[ Q | op V ]` desugars in `desugarBody` (where the rule's used-name set lives) by renaming `V`'s query-side occurrences to a fresh `V_k`, leaving `out` as the Variable `V` — today's behavior as a special case (plans/v2-agg-output-var.md, plans/v2-bracket-aggregation.md). The existence ops `some`/`none` (plans/v2-bracket-some.md) forbid the `Out =` form and set `out` to a `Wildcard`, so they produce no value and drop `V` from scope; `none` is the negation of `some` and additionally forbids any leftover group column (it binds nothing)
- `{p t1..tn => e}` exception blocks — tokenized on `{`/`}`, split on top-level `=>`; LHS a single unmarked Symbol-headed atom, RHS a body fragment (no nested exception, no dot adjacency; may be empty = bare suppression); becomes a pre-expand `Exception` atom (plans/v2-exceptions.md)
- bool-weight validation — enforces `-> bool` weight restrictions
- `#macro head P1..Pn := [ ... ]` macro definitions — the `#macro` command consumes its header through the `:=` and emits a `macroDef` token; the RHS tokenizes normally and arrives as the following `aggcomp` token, which reuses the multi-line `[` handling. Because the command marks the definition, `:=` keeps no special meaning anywhere else. `parseMacroDef` checks a Symbol head, distinct non-`_` Variable parameters, and `params.length === lexical arity`, then records a `MacroDef` in `Program.macros`. A definition is self-delimiting (it ends at its body's `]`, tracked by the `aggcomp` token's `endLine`), so no blank line is needed before the next definition or rule; only trailing content on the body's own line is an error (plans/v2-aggregation-synonyms.md)
- `#def`/`#agg` commands — rule naming and schema declarations

# expand.ts

The expansion pipeline that lowers parsed pre-expand rules into the flat post-expand IR: it runs anchor decomposition (`decomposeRule` + `pruneChains`), universal rule-splitting on every `Emit`, dead-slice filtering, and semi-naive delta-variant generation. The core anchor-decomposition pass threads SSA running-anchor variables and a `*chain` fingerprint, lowering each marker (match/episode/fact/anchor/ask/constrain/aggregate) into the right combination of `Match`/`Emit`/`Le`/`AssertLt`/`Max`/`Min`/`Equal`. `Max`/`Min` appear only at matches (the anchor intersection with a stored tuple's endpoints); emit and sequence-sub anchor updates are statically determined by the running-anchor invariant and emit no atoms.

**Key terms:**
- `expand` — top-level pipeline: macros → exceptions → decompose → prune → split → filter → delta-variants
- `expandStages` — same pipeline returning each named intermediate rule-list (`macroExpanded`/`decomposed`/`split`/`filtered`/`variants`); `expand` is its `variants`. Used by the `v2-cli.ts` `--stage` dumps
- `expandMacros` — the pipeline's **first** pass: source-to-source elimination of aggregation-synonym uses, run before `applyExceptions` so exception rewriting sees the relation reads a macro body performs. Rejects recursion (direct or mutual), normalizes each macro body to be macro-free in topological order, checks that every parameter names an *outward* variable of its body (a top-level output column), then replaces each qualifying use — a `match`-marker atom with no weight whose head is a macro name — with a deep copy of the body under a name-keyed map: arguments for parameters, fresh names for everything else. Non-qualifying occurrences (other markers, `-> weight`, an exception LHS, an atom inside `!(...)`) are errors: a macro name is not a relation. Leaves `Program.macros` empty, so a second invocation is a no-op — `runFixpoint` also calls it directly, mirroring `applyExceptions` (plans/v2-aggregation-synonyms.md)
- `applyExceptions` — source-to-source elimination of `{p t1..tn => e}` `Exception` atoms before any other pass: renames emitting `p` occurrences to a fresh `_<p>_prime<k>` across the working set, has the host rule broadcast its context via a plain `_<p>_ctx<k>` anchor emit (exceptions never gate `;` progression; LHS vars are exception-local, with prefix-bound ones re-unified via the ctx payload), and generates `<rule>_watch<j>` / `<rule>_exn<j>` / `<rule>_default<j>` rules around a `bool` flag relation `_<p>_exn<k>` (the `_exn` rule is skipped for an empty RHS — bare suppression) (plans/v2-exceptions.md, amended by plans/v2-exception-watchers.md). Also invoked directly by `runFixpoint` so `computeAggStrata` sees exception-free rules. Sets `Program.provLinks`: one `{head, prime, arity}` record per default rule, derived from the *final* default-rule bodies (a later exception on the same relation renames an earlier default's emit head), consumed by `resolveExceptionProvenance` in fixpoint.ts (plans/v2-exception-default-provenance.md)
- `decomposeRule` — anchor-decomposition pass; threads SSA anchor vars and a `*chain` fingerprint, lowering each `Marker` to post-expand atoms
- `splitRule` — slices a rule at every `Emit` into producer/consumer halves
- delta-variants — semi-naive cloning; tags one `Match` as `delta` and sets `deltaHead`/`deltaSafeSkip`
- fresh Id templates — per-firing fingerprint templates `*id`/`*var`/`*choose`/`*mom`
- `aggCompOutCols` — the **output columns** of a bracket-aggregation level in first-occurrence order (`joinCols − {V} ++ unbound vars of out`, where `joinCols` is the union of the items' output columns); also validates each level (`V` is a query column and not prefix-bound; `out`'s variables are disjoint from the query subtree's *genuine query positions* — atom columns and reduction variables at any level, but deliberately **not** a nested level's `out` variables, where sharing a name means "check the fold against that column" and is what makes `land:count X X` expressible). Must stay in step with `compOutCols` in comp-aggregate.ts, which reads the layout back (plans/v2-agg-output-var.md)
- `decomposeAggComp` — lowers a bracket aggregation `[ Q | Out = op V ]` into a paired `Emit (_do-aggc (*cq ...) (*cq-cols ...) idTpl)` / `Match (_agg-resultc (row V1..Vm) idTpl)`, following the `decomposeAggregate` pattern (plans/v2-bracket-aggregation.md; closed by comp-aggregate.ts)
- reserved symbols — `*chain`, `*conj`, `_do-agg`, `_agg-result`, `_constrain`, `*agg-empty`, plus the bracket-aggregation set `_do-aggc`, `_agg-resultc`, `*cq`, `*cq-atom`, `*cq-red`, `*cq-cols`, `*cq-any`, `*fv` (consumed downstream by scheduler/constraint-query/comp-aggregate)

# expand-liveness.ts

A backward-pass chain-liveness optimization run between `decomposeRule` and `splitRule`: it prunes non-essential, dead chain Variables out of `(*chain ...)` fingerprint templates and removes dead `Max`/`Min` anchor-SSA definitions. Pruning preserves correctness because producer/consumer split halves share the same (smaller) `idTpl` objects, so structural unification still recovers the surviving chain vars; essential identity-bearing vars are always kept to avoid dedup collisions.

**Key terms:**
- `pruneChains` — backward liveness pass; drops dead chain Variables from `*chain` templates and dead `Max`/`Min` anchor defs
- `live` / `essential` — downstream-referenced names vs. identity-bearing names that must be retained

# eval.ts

The single-rule evaluator: a CPS-style backtracking interpreter over the flat post-expand `RuleAtom` primitives, mutating a `Store` by matching stored tuples and emitting new ones. All anchor manipulation is now explicit IR, so this is a flat dispatch over `Match`/`Emit`/`Le`/`AssertLt`/`Max`/`Min`/`Equal` with a binding trail for backtracking; pre-expand atoms reaching it throw.

**Key terms:**
- `evaluateRule` — public entry; runs the CPS backtracking interpreter, mutating the `Store`
- `evalSeq` — dispatches on atom tag and chains continuations over a binding trail (unwound on backtrack)
- semi-naive gen filter — a `Match`'s `delta`/`old` `MatchConstraint` filters candidates by generation

# js-values.ts

The single Term ↔ JS value boundary for user-defined `#js` functions (see `plans/v2-user-js-functions.md`): `decodeTerm` lowers a ground Term to a plain JS value for a `JsCall` argument, and `encodeTerm` lifts the return value back to a raw (un-hashconsed) Term. Compounds map to arrays, symbols to strings, numeric symbols to numbers, and booleans encode to the symbols `1`/`0`.

**Key terms:**
- `decodeTerm` / `encodeTerm` — ground `Term` → JS value (expanding `Ref`s) and JS value → raw `Term`
- term↔value mapping — compound ⇄ array, non-numeric Symbol ⇄ string, numeric Symbol → number, boolean → Symbol (encode-only)

# store.ts

The v2 store: interval-bearing hashconsed tuples, head indexing, and the moment-order (partial-order) relation. It provides tuple insertion with dedup/gas/semi-naive bookkeeping, order-edge assertion (two strategies, lazy "old" vs "eager" forward-closure), reachability/comparability queries over moments, interval overlap/containment tests, and least-upper-bound (join) computation.

**Key terms:**
- `Store` / `createStore` — central state (hashcons table, tuples, head index, moment partial-order, gas, semi-naive generations, stats); factory seeds `bot`/`top`
- `intern` / `tokenOf` — hashcons wrappers; token = integer `Ref` id
- `addTuple` — interns and inserts a tuple with dedup, gas check, head bucketing, generation tracking
- `addOrder` — asserts a moment-order edge `lt < gt`
- `lessThan` / `lessEq` / `comparable` — strict/non-strict order and comparability over moments (`bot`/`top` sentinels)
- `intervalsOverlap` / `intervalContains` — interval overlap and containment tests
- `candidatesByHead` — head-symbol-indexed tuple lookup (the match index)
- `leastUpperBound` — join over the moment lattice (`null` when ≥2 incomparable minimal upper bounds)
- `GasError` / `ORDER_STRATEGY` — tuple-budget exhaustion sentinel; lazy-`"old"` vs eager order-maintenance switch

# fixpoint.ts

The top-level evaluation driver. It expands a program, runs an inner loop firing all rules to quiescence (semi-naive), then at quiescence collects blocked do-agg/choose rows; it closes the earliest tier of aggregates (re-entering the inner loop) or, if the earliest tier is all choices, halts with `active-choices` (or `empty-fringe-error`). Gas exhaustion is caught and surfaced as a `gas` status.

**Key terms:**
- `runFixpoint` — public entry; expands the program, runs the loop, returns a `FixpointResult` (`{ store, iterations, status }`); catches `GasError` → `gas`
- `resolveExceptionProvenance` — post-fixpoint `tupleSource` fixup on every return path (including `gas`): an exception default rule re-emits a matched `_<p>_prime<k>` tuple with identical args and endpoints (only head + trailing id slot differ) but its Emit's static span is the exception's line; this pass re-attributes each tuple of a `Program.provLinks` head to the span of its structurally matching prime tuple, following links transitively for chained exceptions, keeping the tuple's own span when no match exists (emits that escaped renaming: weighted or off-arity). So `tupleSource` is not always the firing Emit's span (plans/v2-exception-default-provenance.md)
- inner loop / outer loop — fire all rules to quiescence, then close the earliest aggregate tier or surface blocked choices
- delta-safe skip — skips rules with empty deltas via `deltaSafeSkip`/`deltaHead`/`prevHeads`

# scheduler.ts

The scheduler reads store contents at outer-loop quiescence to find blocked `_do-agg` and `_choose` rows, selects the earliest tier under the `prior` (interval-start) order, and closes earliest aggregates by computing aggregate values and emitting `_agg-result` rows. It also exports `aggregateOver`, the generic grouped-aggregation engine (shared with constraint-query).

It additionally drives **reactive aggregates** (`#reactive rel -> agg`, see plans/v2-reactive-aggregates.md): instead of the demand-driven `_do-agg`/`_agg-result` path, a reactive relation's value is materialized eagerly into `_aggval` rows at the breakpoints where its step function can change. Materialization is **per group** (plans/v2-per-group-breakpoints.md): the source tuples are partitioned by group key, and each group's breakpoints are the join-closure of *that group's own* contributor left endpoints — so a sibling group's breakpoint never re-stamps an unchanged value. Each breakpoint folds the single group at the point `[bp, bp]` (key columns bound) and emits one `_aggval` row over `[bp, top]`; the value is resolved at read time by a `last`-by-left-endpoint selection. Breakpoints are processed earliest-first by the outer loop, which both stratifies non-monotone aggregation by moment and keeps an already-materialized breakpoint from going stale when an earlier contributor is added.

**Key terms:**
- `aggregateOver` — generic grouped aggregation: matches a `[head, keys…, weight]` pattern with `_free` wildcards and folds via the schema aggregator (`sum`/`count`/`last`); shared with constraint-query and default-display
- `collectBlockedDoAggs` / `collectBlockedChooses` — find `_do-agg` rows lacking an `_agg-result`, and `_choose` rows with unresolved active terms; `collectAllBlocked` also pulls in blocked bracket-aggregation rows (kind `aggc`, from comp-aggregate.ts)
- `selectEarliestTier` — minimal elements of the `prior` (interval-start) partial order
- `closeDoAgg` — computes a blocked aggregate and emits its `_agg-result` rows
- `collectReactiveFinalizations` — per-group pending reactive breakpoints (residual-keyed); `finalizeReactive` materializes one group's `_aggval` row at one breakpoint
- `foldGroupAt` — folds a single reactive group (key bound) at a point; `joinClosure` — join-closure of a group's lefts (its breakpoint set)
- `_free` — wildcard key position marking a group-by slot
- `_aggval` — materialized reactive aggregate value row (`_aggval head key… value`), over-persisted to `[bp, top]`

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
- `computeComponents` — main export; groups blocked chooses into connected components over shared `_constrain` rows, returning `ComponentOptions` per component
- `ConstrainRow` — a parsed `_constrain (*conj …)` row (`kind` plain/agg) touching active tokens
- `choiceComponentMoment` — the single moment a component is evaluated at (lub of its rows' left endpoints)
- `runComponent` — backtracking conjunctive query producing deduped option tuples
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

# print-ir.ts

A DOM-free, Store-free debug renderer for the raw (un-hashconsed) IR — `Term` / `RuleAtom` / `Rule` / `Program` as produced by `parse` and the `expand` sub-stages (`print.ts` only handles hashconsed terms reached through a `Store`). Used by the `v2-cli.ts` `--stage` dumps. Output is debug-oriented (one tag-prefixed line per atom) and not guaranteed to round-trip through `parse`; it honors the same id-opacity invariant as `print.ts` (`Id`/`Ref` render as opaque handles).

**Key terms:**
- `renderTermRaw` — raw `Term` render; `Id` literals and stray `Ref`s stay opaque
- `renderRuleAtom` — one line per atom tag, showing `Match` semi-naive constraint and `Atom` marker/weight
- `renderRule` / `renderProgram` — `#def`/`#agg`/`#js` headers plus indented atom lines; `RenderOptions.lines` prefixes each atom with its source line (`Lnn`)

# render-output.ts

UI glue that renders a store into a DOM host as either a syntax-highlighted tuple listing (grouped by head symbol or ordered temporally) or a horizontal timeline. Tuples are rendered as HTML spans with source-line data attributes and aligned interval columns; the timeline path delegates to `timeline.ts`.

**Key terms:**
- `renderTuples` — tuple-listing renderer (grouped by head or temporally ordered) into HTML spans with source-line attributes
- `renderTimelineH` — horizontal timeline view (delegates to `timeline.ts`; `momentStyle` spine|edges variant, defaulting to edges)
- `timelineCollapseKey` / `resolveCollapsed` — collapse identity for an episode (`atomFingerprint`: token-free, so it survives edits and appended `is` rows) and its resolution against a store into `CollapsedInterval`s
- `temporalOrder` — orders tuples by longest-path depth via `lessThan`
- `hideInternal` / `temporal` — view options (hide `_`-prefixed internal rows; temporal vs. grouped)

# timeline.ts

Renders a v2 store as a timeline visualization (SVG or ASCII): moments are laid out along a time axis using a Hasse-reduced partial order, episode (`~`) tuples become labeled bars stacked in lanes, fact (`+`) tuples become lines + labels, and `is`/`constrain` rows are pulled into a sidebar. The layout pass is orientation-agnostic and is then mapped to pixels by a projector supporting horizontal and vertical orientations plus three lane-packing strategies. A horizontal-only `MomentStyle` "edges" variant (plans/v2-timeline-edge-moments.md) gives each moment its own column, but with two-tier spacing (plans/v2-timeline-fractional-columns.md): columns are ordered by (longest-path rank, token), and per-step gaps are floored to the full step (`minColWidth`) across a rank boundary but only to a small fractional width (`minFracWidth`) between same-rank — necessarily incomparable — moments, so comparable moments stay a step apart while incomparable ones cluster tightly. It draws each moment's dot on a canonical bar edge (dashed vertical ties to other bars sharing the moment), and replaces spine arrows with orthogonal dot-to-dot cover arrows (right/up/down only, routed around bars by fewest crossings then fewest turns), suppressing pairs a bar already shows as its own endpoints.

Episodes listed in `opts.collapsed` render collapsed: episodes contained in a collapsed interval `[l, r]`, and facts whose start moment lies in `[l, r)`, are dropped before ranking (so the interior moments vanish with them), and the interval is replaced by a single narrow `name...` bar (the collapsed episode's head symbol; width floored at `COLLAPSED_BAR_W` and never sized to what it hides) that keeps the collapsed episode's tuple index for source linking. Containment is judged against the uncollapsed reachability and includes the endpoints, so co-extensive episodes (`~a, ^b` puts two bars on one interval) collapse as a unit into one stand-in and expand together. The entry's `tupleIndex` names the owning episode: it decides the stand-in's label and click target, not what is hidden. Nested collapsed intervals are subsumed by their outermost container, and collapses over the same interval are one collapse. `web-v2.ts` toggles collapse by right-clicking a bar, keyed by `timelineCollapseKey` so it survives re-evaluation.

**Key terms:**
- `renderTimeline` — builds the SVG (Hasse arrows, moment dots, episode bars, fact stubs) + sidebar; used by render-output
- `layoutTimeline` — orientation-agnostic layout: ranks moments by Hasse-reduced order, classifies tuples, packs lanes
- `CollapsedInterval` / `opts.collapsed` — moment-token pair plus owning `tupleIndex`, drawn as one `name...` bar hiding everything the interval contains
- `Orientation` / `LaneMode` / `MomentStyle` — horizontal|vertical axis; compact|nested|tree bar-packing; spine|edges moment placement
- `momentAnchor` / `momentTies` / `orderPairs` — edges-variant layout outputs: canonical dot per moment, dashed ties, drawn cover pairs
- `renderTimelineAscii` — headless text rendering (no DOM/canvas)
- episode (`~`) bars / fact (`+`) lines — the two tuple classes laid out; `is`/`_constrain` rows go to a sidebar
- `data-source-line` — stamped on bar rects/labels, fact labels, and sidebar rows from `store.tupleSource`, consumed by `source-link.ts`

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
- `highlightLine` / `clearHighlight` / `focusLine` / `caretLine` — line-highlight overlay (positioned off the gutter rows, so it can't drift) and caret helpers used by `source-link.ts`

# source-link.ts

Bidirectional source-line ↔ output linking shared by the v2 editor page (`web-v2.ts`) and presentation-mode code blocks (`pres/render.ts`); see plans/v2-source-timeline-link.md. One linker binds one `Editor` to N output roots whose renderers stamp `data-source-line` (db rows from `render-output.ts`, timeline bars/facts/sidebar rows from `timeline.ts`). Forward: the caret entering a line with an emitting atom highlights every matching element across all outputs (db rows scroll into view; the timeline never auto-scrolls). Reverse: hovering a linked element shows the editor's line-highlight overlay and lights up same-line siblings; clicking moves the caret to that line. `Ctrl-.` cycles through the caret line's timeline occurrences, centering each in its scroll container in turn and wrapping around.

**Key terms:**
- `attachSourceLink` — binds an `Editor` + output roots; installs delegated hover/click handlers, caret tracking, and the `Ctrl-.` binding
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

The bundled fallback display module (used when a program declares no `-- display:` directive). It renders an interactive icon tree from `icon T` / `icon:name` / `at X -> L` relations filtered to the selected choice-component's moment, shows clickable group/chip headers for active choice components, and commits choices via `DisplayApi.commit` when an icon matches a component slot (with a pending state for ambiguous multi-slot matches).

**Key terms:**
- `createDefaultDisplay` — factory for the fallback `DisplayModule` (used when no `-- display:` directive)
- `DisplayModule` / `DisplayApi` — the render interface and host callbacks (`peek`, `renderTerm`, `tokensEq`, `commit`, `addStyles`)
- icon tree — built from `icon` / `icon:name` / `at X -> L` rows within the selected component's moment
- `ClickIntent` / `commit` — clicking an icon matching a choice slot commits `{ activeTerms, optionTuple }`
- `aggregateOver` — used to resolve `at` parent links when a schema is present

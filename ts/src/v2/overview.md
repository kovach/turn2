Summaries of each `.ts` file under `ts/src/v2/`, roughly following the compilation pipeline: **parse → expand → fixpoint eval (store) → render**.

# types.ts

Defines the v2 intermediate representation (IR): the `RuleAtom` algebra spanning both pre-expand (parser output) and post-expand (evaluator input) phases, the `Rule`/`Program` containers, stored `Tuple`s, and the result types for a fixpoint run including blocked-choice reporting. It documents the compilation pipeline (parse → expand → fixpoint eval → Store) and how source markers desugar into explicit anchor IR.

**Key terms:**
- `RuleAtom` — the core tagged-union IR node: pre-expand (`Atom`, `Sub`), both-phase (`Equal`, `JsCall`), post-expand (`Match`, `Emit`, `Le`, `AssertLt`, `Max`, `Min`)
- `Marker` — pre-expand source marker (`match`/`episode`/`fact`/`anchor`/`ask`/`constrain`/`aggregate`) driving desugaring
- `MatchConstraint` — semi-naive eval tag (`"any" | "delta" | "old"`) on `Match` atoms
- `Rule` / `Program` — named rule (body + delta fields) and the top-level container (`rules`, `schema`, `jsDefs`)
- `Tuple` — stored datum: `atom` plus interval endpoints `l`/`r`
- `SchemaDecl` / `JsDef` — relation→aggregator declaration; user-defined `#js` function
- `FixpointStatus` — run outcome (`done`/`gas`/`active-choices`/`empty-fringe-error`)
- `ComponentOptions` / `BlockedChoose` — per-component choice enumeration; a blocked choose row

# parse.ts

The v2 parser for the flat-syntax language: it tokenizes input line-by-line (comment- and indentation-aware) then turns the token stream into a `Program` (rules + schema), without applying hashconsing. It handles markers, `=` equality, `#def`/`#agg` commands, parenthesized/sequence sub-rules, dot-notation desugaring, `!(...)` compound constrain blocks, and bool-weight validation.

**Key terms:**
- `parse` — top-level entry (tokenize → `parseProgram`); returns a `Program` or a `ParseError` (`{ line, message }`)
- marker chars — `-~+^!?` map to a `Marker`
- dot-notation desugaring — threads fresh anchor vars across atoms/subs
- `!(...)` constrain blocks — parsed into compound `subAtoms`
- bool-weight validation — enforces `-> bool` weight restrictions
- `#def`/`#agg` commands — rule naming and schema declarations

# expand.ts

The expansion pipeline that lowers parsed pre-expand rules into the flat post-expand IR: it runs anchor decomposition (`decomposeRule` + `pruneChains`), universal rule-splitting on every `Emit`, dead-slice filtering, and semi-naive delta-variant generation. The core anchor-decomposition pass threads SSA running-anchor variables and a `*chain` fingerprint, lowering each marker (match/episode/fact/anchor/ask/constrain/aggregate) into the right combination of `Match`/`Emit`/`Le`/`AssertLt`/`Max`/`Min`/`Equal`.

**Key terms:**
- `expand` — top-level pipeline: decompose → prune → split → filter → delta-variants
- `expandStages` — same pipeline returning each named intermediate rule-list (`decomposed`/`split`/`filtered`/`variants`); `expand` is its `variants`. Used by the `v2-cli.ts` `--stage` dumps
- `decomposeRule` — anchor-decomposition pass; threads SSA anchor vars and a `*chain` fingerprint, lowering each `Marker` to post-expand atoms
- `splitRule` — slices a rule at every `Emit` into producer/consumer halves
- delta-variants — semi-naive cloning; tags one `Match` as `delta` and sets `deltaHead`/`deltaSafeSkip`
- fresh Id templates — per-firing fingerprint templates `*id`/`*var`/`*choose`/`*mom`
- reserved symbols — `*chain`, `*conj`, `_do-agg`, `_agg-result`, `_constrain` (consumed downstream by scheduler/constraint-query)

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
- inner loop / outer loop — fire all rules to quiescence, then close the earliest aggregate tier or surface blocked choices
- delta-safe skip — skips rules with empty deltas via `deltaSafeSkip`/`deltaHead`/`prevHeads`

# scheduler.ts

The scheduler reads store contents at outer-loop quiescence to find blocked `_do-agg` and `_choose` rows, selects the earliest tier under the `prior` (interval-start) order, and closes earliest aggregates by computing aggregate values and emitting `_agg-result` rows. It also exports `aggregateOver`, the generic grouped-aggregation engine (shared with constraint-query).

**Key terms:**
- `aggregateOver` — generic grouped aggregation: matches a `[head, keys…, weight]` pattern with `_free` wildcards and folds via the schema aggregator (`sum`/`count`/`last`); shared with constraint-query and default-display
- `collectBlockedDoAggs` / `collectBlockedChooses` — find `_do-agg` rows lacking an `_agg-result`, and `_choose` rows with unresolved active terms
- `selectEarliestTier` — minimal elements of the `prior` (interval-start) partial order
- `closeDoAgg` — computes a blocked aggregate and emits its `_agg-result` rows
- `_free` — wildcard key position marking a group-by slot

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
- `renderTimelineH` — horizontal timeline view (delegates to `timeline.ts`)
- `temporalOrder` — orders tuples by longest-path depth via `lessThan`
- `hideInternal` / `temporal` — view options (hide `_`-prefixed internal rows; temporal vs. grouped)

# timeline.ts

Renders a v2 store as a timeline visualization (SVG or ASCII): moments are laid out along a time axis using a Hasse-reduced partial order, episode (`~`) tuples become labeled bars stacked in lanes, fact (`+`) tuples become lines + labels, and `is`/`constrain` rows are pulled into a sidebar. The layout pass is orientation-agnostic and is then mapped to pixels by a projector supporting horizontal and vertical orientations plus three lane-packing strategies.

**Key terms:**
- `renderTimeline` — builds the SVG (Hasse arrows, moment dots, episode bars, fact stubs) + sidebar; used by render-output
- `layoutTimeline` — orientation-agnostic layout: ranks moments by Hasse-reduced order, classifies tuples, packs lanes
- `Orientation` / `LaneMode` — horizontal|vertical axis; compact|nested|tree bar-packing strategy
- `renderTimelineAscii` — headless text rendering (no DOM/canvas)
- episode (`~`) bars / fact (`+`) lines — the two tuple classes laid out; `is`/`_constrain` rows go to a sidebar

# editor.ts

A self-contained code-editor wrapper around a `<textarea>` that adds a line-number gutter, smart editing keybindings (indent/dedent, auto-indent on Enter, smart Home/Delete), auto-grow, a freeze (read-only) mode, an optional symbol/variable completion overlay, and debounced autosave to either a URL query param or a server endpoint. All edits go through `execCommand("insertText")` so native undo and input events keep working.

**Key terms:**
- `Editor` — textarea wrapper adding a line-number gutter, smart-edit keybindings, auto-grow, freeze mode, autocomplete, and autosave
- `SaveBackend` — autosave target: `none` | `server` | `url-param`
- `setFrozen` — read-only mode toggle
- smart editing — indent/dedent, auto-indent on Enter, smart Home/Delete, all via `execCommand` so native undo works
- `enableAutocomplete` — opt-in flag (on for index-v2, off for pres) for the completion overlay; logic lives in `autocomplete.ts`
- caret mirror — off-screen div replicating textarea metrics to position the completion box at the cursor
- `scheduleSave` — debounced (400ms) autosave to a URL param or server endpoint

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

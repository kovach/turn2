Summaries of each `.ts` file under `ts/src/v3/`: an evaluator that runs Turn programs as **procedures fired by events** instead of Datalog rules re-joined to a fixpoint (plans/v3-procedural.md, discussions/procedural-turn.md). It reads the v2 parser's `Program` (nothing in `ts/src/v2/` changes) and computes v2's (non-lattice) semantics: `diff.ts` checks it against v2 in lockstep. Pipeline: **parse (v2) → analyze → compile → run (runtime) → print / diff**.

The model in one paragraph: an episode is a **frame**; a rule is a chain of compiled continuation-passing steps whose first match is a root **listener**; an emitted tuple is **dispatched** once to the listeners registered before it; every other match is a **lookup** of the tuples that exist plus, where static analysis says more can arrive inside the rule's scope, a **subscription**. Moments are created exactly where v2 creates them (`pred` = the window's left end, `succ` = its right end), so the moment order is v2's and is answered without a graph walk. A frame ends when nothing is pending inside it. `~>p`, `;` and `>p` do not wait for `p`: the continuation runs ahead, recording `p` as a **gate**; point reads (`#acc`, `not`, lookups that do not listen) wait for the gates below their moment and for unanswered choices below it, which is exactly where v2's moment walk is blocked. Choices surface at quiescence and the run resumes in place after an answer.

# terms.ts

Interned ground terms: a `Terms` table maps symbols (numbers and string literals are symbols, as in v2), compounds, fresh objects (`#C.12`, minted by an emit with an unbound variable) and choice terms (`?C.4`, minted by `?`) to integer `Id`s, so equality is `===` and rows index by id. Patterns (`Pat`) are compiled from v2 `Term`s over per-rule variable slots (`Slots`); `@js(f a…)` (parsed as `(*js f a…)`) is a pattern evaluated when an emitted term is built.

**Key terms:**
- `Terms.sym` / `app` / `fresh` / `choice` / `show` / `nat` / `peano` / `hasMinted`
- `Pat` (`c` constant, `v` slot, `w` wildcard, `a` compound, `js` call), `compilePat`, `matchPat` / `matchArgs` (bind into a mutable env), `groundPat`, `UNBOUND`

# moments.ts

The moment order. Every moment v3 creates subdivides a continuation's window: `fresh(pred, succ)` with `pred` = XL and `succ` = XR (an episode's end has `pred` = its start), the same edges v2's `AssertLt` asserts. With the window invariant `XR ∈ succChain(XL)`, `u ≤ v` iff some moment on u's succ chain (u, its succ, … up to `top`: the ends of the scopes u was made in) is a pred-tree ancestor-or-self of `v`. Ancestor tests read an Euler tour of the pred tree kept in an order-maintenance list (Dietz–Sleator labels); each moment caches its succ chain's maximal Euler intervals (a laminar family, so disjoint) in list order, and `le` is a binary search. v3_basic.test.ts checks `le` against reachability on random histories.

**Key terms:**
- `MomentOrder.fresh` / `le` / `lt` / `max` / `min` / `lub` (incomparable moments: the least scope end above both, else a fallback)
- `Moment.frame` (on a frame's end, and `top` → the root frame) maps a window's right end to its scope

# analyze.ts

Static analysis of the parsed program. A rule's *scope* at an atom is the frame whose end is its window's right end; statically it is an episode relation (or `ROOT`), always an ancestor-or-self of the runtime scope (`exact` when it is the runtime scope). The *spawn graph* has an edge S → E when some rule emits `~E` with scope S. A tuple can only reach a window if its emitter runs inside the window's scope frame, so a match on R at scope S needs a subscription iff some emit site of R may run inside S (`mayArrive`); `is` always does. Iterated to a fixpoint (scopes and the graph depend on each other).

**Key terms:**
- `analyze` → `Analysis` (`episodes`, `acc`, `js`, `intercepted`, `spawn`, `emits`, `matches: Map<atom, MatchInfo>`)
- `MatchKind`: `first` (root listener), `ancestor`, `lookup`, `subscribe`, `await` (`is`), `acc`, `not`, `js`
- `report` — per rule, its match kinds; *procedural* iff no `subscribe` (`v3-cli --report`)

# compile.ts

Rule bodies → continuation-passing steps `(ctx, k) => void`, with v2's window arithmetic (expand.ts `decomposeMatch` / `decomposeEmit`) evaluated directly. A store match checks `XL < r`, `l < XR`, `l < r` and narrows to `[max(XL, l), min(XR, r)]` (`>p`: `r < XR`, `XL := max(XL, r)`); it listens first (when it subscribes) and then scans the tuples that exist, or, as a pure lookup, waits for completeness first. `#acc` reads and `not` are point reads at XL after `whenComplete`. `+` / `^` / `~` mint moments inside the window and emit (`~p` continues inside, `~>p` after; a rule-initial `^` lands on `(bot, top)`); `?` mints choice terms at XL and `!` records a constraint there; `( … )` restores the window, `( … );` continues at the group's end; `{p => e}` registers an interception context. Rules that start by listening start first, so every root listener exists before the first emit.

**Key terms:**
- `compileProgram` → `CompiledRule[]` (`start` runs the body from `(bot, top)`); saved v2 `^ is` rows are skipped with a warning
- exception numbering — v2's `applyExceptions` renames emits rule by rule, so an emit site has a *barrier* (-1 outside exception rules, the host's last exception in a host rule, the exception's own number in its right-hand side) and exception X may intercept it iff X's number is above the barrier (same relation and arity); `catchers` per emit site
- `build` — the term an emit writes: unbound variables become fresh objects (bound for the rest of the rule), `_` a fresh object each time

# acc.ts

`#acc` relations computed at the moment they are read, cached per moment (rows at `m` are final once computed: by construction everything at or below a reading continuation's moment has executed). Strata by Tarjan SCCs over read dependencies; a recursive stratum iterates with its current rows as the local rows; contributions are deduplicated by key, value, moment and firing identity (the matched tuples and rows); ops (`sum`, `count`, `min`, `last`, `arg-min`, boolean) fold as in v2's acc-ops.ts, `@last` keeping the temporal maxima (incomparable contributions give several rows).

**Key terms:**
- `AccEngine.rowsAt(rel, m)` → `AccRow[]` (`args` in column order, `moment`, `key`)
- contribution moment — the lub of the matched tuples' starts and rows' moments (`m` when none)

# query.ts

Conjunctive point queries at a moment, shared by acc bodies (written order) and choice constraints (`reorder`: most constrained atom first, `not` once ground, js once its inputs are bound). A stored tuple takes part when alive at `m` (`l ≤ m ≤ r`).

**Key terms:** `QAtom` (`rel`, `acc`, `not`, `js`, `eq`), `PointSource`, `solve`, `Trace` (moments and identities read)

# js.ts

`#js` functions and `#js-def` relations over interned terms (v2's value mapping, js-values.ts; clauses compiled by v2's `compileJsRels`). `runJsRel` picks the first clause whose `+` positions are bound at the call.

# runtime.ts

The store, frames, tasks, listeners, exception decisions and choices. A *task* is a continuation that will run or is waiting; each is counted in its *scope* frame (`pending`). A frame ends when nothing is pending in it, its children have ended, the gates it was spawned past (`deps`) have ended, and no unanswered choice sits below its end; its end releases waiters and dependents. Listeners keep nothing alive (a tuple that could reach them comes from inside their scope, which is counted). Emits of interceptable tuples are held for a decision at quiescence (the first exception, in v2's order, with an overlapping context catches the tuple; its right-hand side runs on the tuple's interval; a caught episode's frame becomes a ghost) while the emitter runs on past a gate.

**Key terms:**
- `Runtime` — `run()` → `Status` (`done` / `choices` with `Component`s / `gas` / `error`), `answer(component, option)`, `resolve(choice, value)` (an `is` row from the ask moment to `top`)
- `Ctx` (`env`, `xl`, `xr`, `deps`), `Gate` (an unended frame or an undecided exception), `mergeDeps`, `continueAt` (run ahead past a frame's end), `whenComplete` (wait for gates and for unanswered choices below `xl`)
- `insert` / `listen` (sequence numbers: a listener sees tuples inserted after it registered; its catch-up lookup sees the rest)
- choices — components per ask moment (no unanswered choice below, gates ended), joined by constraints; a constraint that also mentions a later choice belongs to it; zero options → dead; all-`rng` components resolve by `rng-seed` (mulberry32) or the given `random`
- gas — tuples and frames count against `tupleGas`; nesting deeper than `MAX_DEPTH` is a runaway

# bridge.ts

v3 in the web editor (`src/web-v2.ts`). A file whose header comment has `-- engine: v3` (or any file with `?engine=v3` in the page URL) runs through `runV3` instead of `runFixpoint`: the program runs with the answers saved in its source replayed, and the result is presented in v2's shapes, a real v2 `Store` (v3's moments with their order edges, every tuple with a trailing id slot and its source span, the acc rows v3 computed as point rows, `accComputed`/`accConsulted`, settled moments), a `FixpointStatus` with `ComponentOptions`, and `accAt`, so the timeline, database view, choices strip and display modules work unchanged. Choice and fresh-object terms become Id terms shaped like v2's templates (`(*id rule line (*chain name) :Var)`), which the page reads for chip labels.

Answers are comment lines, so the source still parses: `--@ C@43 (cell z z)` (one line per click; `label@line value` per answered choice, `|`-separated for a joint click). Replay goes in order, each line to the first pending component that has choices with those labels and an option with those values (printed form), resolving just those choices; it stops at the first misfit (reported in the status line as unused answers from that line). Deleting answer lines steps the game back. v3 is deterministic (rng uses a default seed), so fresh objects' printed names (`#P.17`) stay stable while the program and earlier answers do. v2's saved `^ is` rows are not read.

**Key terms:** `runV3` → `V3EditorResult` (`store`, `status`, `accAt`, `replayed`, `unused`, `error`, `answerText(activeTerms, option)`), `parseAnswers`, `ANSWER_PREFIX`, `choiceLabel`

# print.ts

Text output: `dumpTuples` (`+` facts, `~` episodes, `^` views), `dumpAcc` (rows at a moment), `showComponent`, `showReport`.

# diff.ts

Lockstep differential run against v2 (`diffRun`): the same program in both engines (saved `^ is` rows dropped, `?[rng]` made `?`), every choice answered the same way, comparing at each step the facts (tuples that live to `top`), each component's options, and every acc relation's rows at the component's moment (at `top` when both are done). Fresh objects are compared through *descriptors* (the facts that mention them), which also pick the "same" option on both sides; components with identical options are paired by their acc rows. v2 re-runs from scratch with the answers appended as `^ is` rows; v3 resumes. Returns the v2 source with every answer (`source2`) and v3's answer indices (`answers3`) for benchmarks.

Editor: add `-- engine: v3` to a file's header and open it in the editor (the data/v3 files carry it; serve them with `--v2-data data/v3`, e.g. `./watch.sh 5176 rw --v2-data data/v3`, then `http://localhost:5176/?file=ttt-v3.t`), or append `?engine=v3` to the page URL. data/v2 is searched first, so a v3 file must not share a data/v2 file's name (hence `ttt-v3.t`). ttt-v3.t uses data/v2's `ttt-display.js`, which reads its board from the `sq (cell R C)` acc rows. Profiling: profile the compiled `dist/` modules (tsx's loader hides function names), e.g. a replay loop over `dist/v3/runtime.js`.

Drivers: `src/v3-cli.ts` (run, `--answers N --pick first|random --seed N`, `--report`, `--acc`), `src/scratch/v3-diff.ts` (one lockstep run), `src/scratch/v3-bench.ts` (v2 one-shot replay vs v3 game), `src/scratch/proc-classify.ts` (the corpus classifier from the discussion).

authored by Claude Opus 5.5 (claude-opus-5-5), 26/10/13

# prompt:

> I want to investigate a pretty deep change to this language, basically a different language inspired by it. The idea would be to try to compile into a set of procedures rather than a set of data log rules. Currently, Turn uses tuples to encode both episodes and facts, and rules trigger based on these tuples. But a majority of the time, a rule is triggered by a particular episode type. If we know that a rule can only be triggered by a particular episode, then we can potentially represent it after compilation as a part of a procedure. We want to match as much of the expressiveness as turn as possible, including the acc rules.

# Procedural Turn: compiling rules into episode procedures

The question: most Turn rules start by matching one episode and then only
look things up and emit. If the compiler can prove that a rule fires only
when a particular episode starts, the rule can become part of that
episode's *procedure* instead of a Datalog rule that the fixpoint loop
re-joins every round. How much of Turn survives that change, `#acc`
included?

Short answer: most of it, and the cleanest framing is that Turn's moment
order is already a structured fork/join program that the fixpoint engine
rediscovers at runtime. Episodes become activation frames, rules become
handlers, `+`/`^`/`#acc` become state with a known update site, and `?`
becomes a coroutine yield. The one real semantic gap is that a body *match*
in Turn waits for any tuple that overlaps its window, including tuples
emitted later, while a procedure only looks up what already exists. The
compiler has to prove each match is a lookup or turn it into a
subscription. In the corpus, lookups are the overwhelming case for idiomatic
programs (Spirit Island: 135 of 142 rules), and the remaining cases fall
into four or five recognizable idioms, each with a procedural spelling.

## 1. Measurement

`ts/src/scratch/proc-classify.ts` (run from `ts/`:
`node --import tsx src/scratch/proc-classify.ts data/v2/*.t ../si/game/si-game.t [--verbose]`)
parses each program and classifies every rule statically:

- **episode relation**: a relation only ever emitted with `~`.
- **scope**: walking a body, a narrowing episode match or a `~p` makes `p`
  the current scope; `;` and `>`/`~>` return to the enclosing one. Each `~q`
  adds a spawn edge from the current scope to `q`, and each emit records the
  scope it happens in.
- **trigger**: the deepest narrowing episode match, meaning a descendant of
  every other episode the rule matches. Every other episode match must be an
  ancestor, or the rule is a *multi-episode join*.
- each remaining match is one of: **ancestor** (an enclosing frame),
  **past/context** (the relation is never emitted inside the trigger's
  spawn subtree, so all of its rows exist before the trigger starts),
  **concurrent** (it can be emitted inside the trigger's subtree, so the
  rule may have to wait for it), **acc-read**, **not-acc**, **js**, or
  **await-choice** (`is`).
- **procedural** = triggered by an episode, with no concurrent matches.

The analysis is approximate: scopes are per relation rather than per
instance, and concurrency between sibling subtrees is ignored. It is still
accurate enough to see the shape.

(diagram: image log, `slide2-proc-classifier.png`)

| | rules |
|---|---|
| procedural | 289 / 449 |
| reactive join (a concurrent match) | 110 |
| top-level (no trigger: `~game`, saved choices) | 38 |
| not episode-triggered / multi-episode join | 12 |

Two more numbers matter for the design:

- **283 of the 289 procedural rules are guard-then-body**: every read comes
  before the first emit. The six exceptions read after an awaited `~>`
  (SI's `invaders-deal-damage` reads `invader-damage` after `~>tally`).
- **Concurrent matches** (141) are the ones that wait on later tuples, and
  they cluster in small programs written before the current idioms existed
  (ttt, pins, wolf-sheep, ttt-display). In si-game they are 5 rules.

## 2. Why the model fits: windows are scopes

The pieces already exist in the v2 semantics (store.ts creation-time
invariant, moment-walk.ts, turn-temporal-logic.md §1):

- Every new moment subdivides the running window `(XL, XR)` of the firing
  that creates it, and the comparability of existing moments never changes
  afterwards.
- `XR` is always the end of some episode (or `top`), the innermost one whose
  window the rule is inside. Call it the firing's **scope**.
- A tuple can only overlap episode `E` if it was emitted by a firing whose
  window lies inside `E`'s window. A firing outside `E` places its fresh
  moments incomparable to `r_E`, so the strict overlap checks fail.
- So `r_E` becomes settled exactly when every firing scoped inside `E` has
  happened. Those firings are `E`'s handlers, their descendants, and the
  spawner's continuation after `~E`.

That is structured concurrency (a Trio nursery, or Cilk's spawn/sync): an
episode is a scope that ends when everything inside it has quiesced. The
moment walk computes this order dynamically. A procedural compiler fixes it
statically:

| Turn | procedure |
|---|---|
| episode instance | activation frame: args, parent, children, local `^` state |
| rule triggered by `E` | a handler of `E`, run when a frame of `E` starts |
| `~p` | spawn a child frame, and the rest of the rule continues *inside* it |
| `~>p` | call: spawn, then await `end(p)` |
| `;` | await the end of everything the group started |
| `>p` (match) | await `end(p)` for a matched `p` (SI's turn loop `game, >turn N, …`) |
| `(p)` on a child episode | handler of `p` that continues in the parent's scope |
| ancestor match | `frame.ancestor(E)`, resolved statically when `E` has one spawn context |
| `+f` | write to global state, visible to every later step |
| `^v` | write to the current frame, dropped at the frame's end |
| `#acc` read / `not` | point read of state at the current step |
| `?C !(…)` | `yield ask(options)`; the fiber suspends |
| `is C V` elsewhere | `await` the choice's result (an I-var) |
| fresh `+card C` | `new` (no Skolem id or derivation history) |

**Acc reads never block.** At the moment a fiber reaches a step, everything
below that step in the order belongs to its own past, its ancestors'
prefixes, or episodes it has already awaited, and all of those are done.
The settle and watermark machinery is not needed for straight-line code. A
fiber's moment is always settled when it gets there.

The order this generates should be series-parallel: each insertion is "a
fresh point between my position and my scope's end". If that holds, the
order has dimension 2, and the SP-order trick (two order-maintenance lists,
Bender, Fineman, Gilbert, Leiserson 2004) answers `a < b` in O(1) whenever
moments are needed. In the procedural runtime they are mostly not needed
for evaluation, only for the timeline display and for `@last` merges (§4).
This claim should be checked against the lattice-mode notes.

## 3. Matches: lookup or subscription

This is the central distinction. In Turn, a body match `p X` means "for
every `p` tuple that overlaps my window, now or later, continue at the
later of the two starts". Procedurally there are two implementations:

- **lookup**: enumerate the rows alive at the current step (an index scan).
  This is valid when every row that could ever match already exists. The
  sufficient conditions are the classifier's: the relation is ancestor
  context, or it is emitted only in scopes that happen before the trigger.
- **subscription**: register a continuation on `p` in the current scope,
  replay the existing rows, and call it on each later emit of `p` within
  the scope. Drop it when the scope ends. This is Rete/TREAT, but scoped,
  and still procedural code (a callback list per relation per frame).

Turn already has the lookup form: an acc read is exactly a point read at
`XL`. So the procedural language is Turn with one change of default: **a
non-trigger match is a point read, and waiting for a future tuple has to
be explicit** (say `when p X`). The compiler for *existing* Turn programs
infers which is which. For a new language, making `when` explicit is
better: it is the one construct with Datalog cost, and it is where
nondeterministic interleaving lives.

A side effect: point reads do not have the constructive-overlap problem.
`setup, pin A, pin B, +pair A B` reads every alive `pin` at the step and
gives the full cross product, which is what lattice mode was reaching for.
This is a deliberate semantic difference.

## 4. `#acc` rules become state

An acc relation's value at a moment is a fold over contributions alive
there. Procedurally the fold is maintained along the execution, and the
update sites are known statically: they are the emit sites of the
relations an acc body reads (the "per-site specialization" of
compilation-thoughts.md).

(diagram: image log, `slide2-proc-acc-lowering.png`)

- **Over `+` facts only** (72 rules): contributions are never removed.
  `@last` is a mutable map (`move It To / at It To` ⇒ `at[It] = To` at the
  emit site of `+move`), `@sum`/`@count` are counters, and boolean
  relations are grow-only sets. This is the largest procedural win.
- **Over an episode or `^` view** (52): the contribution lives while a
  frame lives. `turn T, dmg P N T / damage P N` is a per-turn accumulator,
  in effect a local variable of the `turn` frame. Enter adds, exit
  subtracts (or drops the frame-local table). `@min`/`@last` with removal
  need the group's multiset rather than a single cell.
- **Over other acc rows** (10): maintain by delta rules (DBSP style: when
  `at[p]` changes from `L1` to `L2`, retract the `L1` group's contribution
  and add the `L2` one), or memoize on read keyed by the version counters
  of the inputs. Memo-on-read is enough for a prototype.
- **Recursive** (3): a local fixpoint at read time, semi-naive when inputs
  only grow. Same as acc.ts today.

Two Turn behaviours need explicit handling:

- **`@last` across concurrent writers.** If two sibling handlers both move
  card `c`, Turn's `at c` has two rows after the join, because the
  temporal maxima are incomparable. A sequential runtime would silently
  keep the second. Either merge versions at scope end (multi-valued, which
  is faithful) or treat it as a statically detected write-write race.
- **Snapshots at an episode's start.** Sibling handlers of `E` all read
  state at `l_E`. If they run one after another on shared mutable state, a
  later handler sees an earlier one's writes. SI's `add-blight` has three
  handlers guarded on `blight-on-card`, and the first one decrements it.
  Since 283/289 handlers are guard-then-body, the cheap fix is to compile
  an episode as **all guards first, then all bodies**: evaluate every
  handler's read prefix against the start state, then run the selected
  bodies. Reads after the first emit (6 in the corpus, all after an awaited
  `~>`) are safe when no concurrent sibling writes what they read. That is a
  relation-level read/write-set check over sibling subtrees, and where it
  fails the runtime falls back to persistent (HAMT) state versions per
  fiber.

## 5. A compiled example

SI's blight rules (si/game/si-game.t:147–163), three handlers of `add-blight`:

```
add-blight L, blight-on-card N, gt N 0
  ~>add-piece L blight
  ~>take-blight L
  ~>blight-presence L
  ~blight-cascade L
add-blight L, blight-on-card 0, not flipped island
  ~>flip-blight-card
  ~add-blight L
add-blight L, blight-on-card 0, flipped island, ~lose blight
take-blight L, +blight-taken L
```

become, roughly:

```js
function* add_blight(f, L) {
  // guards, all at f.start
  const n = S.blightOnCard;                 // @sum over facts: a counter
  const g1 = n > 0, g2 = n === 0 && !S.flipped.has("island"), g3 = n === 0 && S.flipped.has("island");
  if (g1) {
    yield* call(f, add_piece, L, "blight");
    yield* call(f, take_blight, L);          // inlined: blightTaken.add(L); S.blightOnCard -= 1
    yield* call(f, blight_presence, L);
    spawn(f, blight_cascade, L);
  }
  if (g2) { yield* call(f, flip_blight_card); spawn(f, add_blight, L); }
  if (g3) spawn(f, lose, "blight");
}
```

and the choice pair

```
blight-cascade L, count L blight B, gt B 1
  ?C
  !(adjacent L C, land C)
  ~ask cascade C L
ask cascade C L, is C X, ~add-blight X
```

turns into `const X = yield ask(adjacentLands(L))` followed by
`spawn(add_blight, X)`, because `ask cascade …` has exactly one handler whose
pattern matches this spawn site, so the handler can be inlined. When several
handlers match by pattern (dominion's `activate.it.val.card:name village` /
`throne-room`), the compiler emits a switch on the arguments.

tic-tac-toe is the other extreme, since most of it was written in the
reactive style:

(diagram: image log, `slide2-proc-ttt-frames.png`)

## 6. The reactive residue, by idiom

Each of the 110 reactive rules has a procedural spelling:

1. **Setup closures**: `setup, n (s X), +n X`, `setup, n R, n C, +cell R C`,
   `board, edge A B, +adjacent A B`, and most of wolf-sheep and hex. These
   are timeless derivations inside a phase, so they are recursive or plain
   boolean `#acc` relations (the tutorial already recommends this for
   recursion), or js relations. Alternatively, an episode-local `derive`
   block runs to a fixpoint before the episode ends.
2. **Episode attributes as views**: `~turn, ^actor o` read back by
   `turn, actor P`, and dominion's `it`/`val`. These are constructor
   arguments. SI already writes them as arguments (`turn N`,
   `ask damage V L N`). A translator can recognize `~E` immediately
   followed by `^attr` emits in the same rule.
3. **`^` views read at a child's end**: `~>tally L` then
   `invader-damage L Raw` over `^deals` rows that tally emitted. These are
   **return values**: the child's frame-local state is visible at its end
   and then dropped.
4. **Peeking at a child episode**: `main, (rest)`, `turn, (won M _)`. This
   is a handler of the child that continues in the parent's scope. It is
   procedural once the trigger is the child.
5. **Standing joins inside a window**: ttt's win check (`turn, filled A M,
   adj …, filled B M, …` sees fills made during the turn). These are true
   subscriptions (`when filled …`), or can be rewritten to a point read at a
   later step (a `turn-done` handler reading `filled` as acc).

Only one rule in the corpus is a multi-episode join with no ancestor chain
(dungeon.t:195), and it may be a classifier artifact.

## 7. Other constructs

- **Choices.** `?` suspends the fiber. A choice surfaces only when no fiber
  is runnable, so every `!` contributed at its moment by other handlers
  (`turn, (choice C), !sturdy C`) has been added. That is the current
  quiescence rule without the moment walk. Dead choices (no options) drop
  the fiber. Joint choices and the `you`-before-`rng` ordering carry over
  unchanged, since they are about components, not evaluation strategy.
- **Exceptions** `{p => e}` are effect handlers with a temporal scope. If
  the context is installed by an ancestor or in the fiber's past, which
  covers the corpus's uses, interception is a synchronous lookup at the
  emit site: walk the frame chain, plus a global table for fact-scoped
  contexts. A context installed concurrently with the emitter needs Turn's
  deferred default (commit at scope quiescence). It is probably better to
  reject that case than to keep the two-phase machinery.
- **Dedup.** Each firing happens once, so re-derivation dedup and the
  `*chain` fingerprints go away. Set semantics stays a property of reads
  and acc folds, as now.
- **Display.** The timeline needs moments. The runtime can log
  (frame, start, end) and emit points with SP labels, and render from that.
  The display layer does not have to know the program was compiled.

## 8. What changes semantically

Going procedural is not a pure optimization of the current semantics:

- Non-trigger matches become point reads by default, so matching no longer
  moves the window forward, and emits start after `XL` rather than after
  the matched tuple's start. `when` restores the old behaviour.
- Cross products of sibling facts start working (§3).
- `@last` races become visible decisions, either merged or rejected (§4).
- Handler order within an episode is unobservable only if isolation is
  kept, through guards-first, the read/write check, or persistent versions.
  Turn gets this for free from incomparable moments, and the procedural
  runtime has to enforce it.
- Concurrently installed exception contexts are restricted (§7).

## 9. Suggested next steps

1. **Translator for the procedural subset**: Turn AST to JS generator
   functions (frames, spawn/call/await, guards-first, per-site acc updates,
   memo-on-read for derived acc, a choice protocol compatible with the
   current `is` rows). Fall back to the existing engine for anything the
   classifier does not mark procedural.
2. **Differential test on si-game**: drive both runtimes with the same
   saved `is` rows and compare the facts and the acc rows at each awaited
   step. This is the real test of §2's "acc reads never block" claim.
3. **Rewrite ttt and wolf-sheep in the idioms of §6** and see whether
   anything is left that needs `when`. If nothing is, the new language may
   not need subscriptions at all, only episode handlers with point reads,
   acc rules, and a `derive` block.
4. Check the series-parallel claim (§2) against lattice mode and
   `notes/moment-insertion.md`.

Related work worth reading alongside: structured concurrency (Trio
nurseries, Cilk spawn/sync), SP-order maintenance (Bender et al. 2004),
DBSP / differential dataflow for incremental acc, Rete/TREAT for
subscriptions, algebraic effect handlers for exceptions, LVars for monotone
shared state between fibers, and Dedalus for the temporal stratification
Turn already uses.

## 10. Results of the v3 implementation (26/10/13)

Steps 1–3 of §9 are done: `ts/src/v3/` (overview there; plan and
corrections in plans/v3-procedural.md). What changed from the sketch above:

- **No fallback engine was needed.** Every match is a lookup plus, only
  where §3's analysis says more can arrive in its scope, a scoped
  subscription. With that, v3 runs every program in the corpus, not only
  the procedural subset, and the classifier's "reactive" rules simply cost
  a listener.
- **Moments stayed, cheaply.** Rather than dropping moments (§7), v3
  creates them exactly where v2 does and answers `≤` from the structure:
  `u ≤ v` iff some moment on u's succ chain (u and the scope ends above it)
  is a pred-tree ancestor of `v`. This keeps sibling isolation exact with no
  persistent state versions, so the guards-first compilation of §4 was not
  needed either. The series-parallel question in §2 became moot.
- **"Acc reads never block" was half right.** It holds for a continuation
  that waited at every `~>`. But v2 does not wait at `~>`: the continuation
  runs on, and only reads wait. At a choice, v2 therefore already has every
  fact that does not depend on the answer. To match, v3 runs ahead too and
  makes *reads* wait on what they ran past (unended frames, undecided
  exceptions, and unanswered choices below them): "awaits are lazy, reads
  force", which is dataflow futures more than call/return.
- **Exceptions follow v2's elimination order**, not dynamic scope (§7): an
  exception never intercepts its own right-hand side or host rule.

Measured against v2 in lockstep (facts, every acc relation at each choice,
option sets): all corpus programs, 35 Spirit Island spirit variants, and 9
complete si-game games agree. v3 plays a game 3–23x faster than one v2
run of it (SI: 10–17 ms vs 130–260 ms, with about a tenth as many stored
tuples), and it resumes after an answer where v2's harness re-runs from
scratch.

§9.3: `ts/data/v3/ttt-v3.t` and `ts/data/v3/wolf-sheep-v3.t` rewrite the two
most reactive programs in the idioms of §6, and `v3-cli --report` shows no
subscriptions in either. Every rule is an episode handler whose other
matches are lookups, `#acc` reads or `is` awaits. So for these games the
new language needs no `when` at all, only handlers, point reads, acc
views, and called episodes whose views are read at their end. Two lessons
came from rewriting:

- nesting turns by tail-spawning (`~turn Next` inside the last turn)
  keeps every earlier turn alive, so a view keyed on `turn wolf` holds
  during a sheep turn. A loop that calls each turn with `~>` is the
  procedural shape;
- the original wolf-sheep capture rule recurses forever after the second
  capture (a sheep already at `nowhere` is re-sent there). Both engines run
  out of gas on it.

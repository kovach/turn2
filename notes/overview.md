# dead choices
(follow-up to the section below; no separate plan file — implemented directly 26/08/20)

- an earliest-tier choice component with zero option tuples is *complete*: it resolves to
  nothing and no longer blocks the scheduler
- assumption: temporal monotonicity — the component is evaluated at its quiescent moment M,
  and no later emission's interval can contain M, so an empty component can never gain options
- mechanism: mark each active term with a reserved `_dead-choice <term>` row at (bot, top);
  collectBlockedChooses and gatherChoiceContext treat it as a resolution with no value, so the
  ask stops blocking and its `.is` continuations never fire (Ceptre "transition not applicable")
- applies to `you` and `rng` alike (supersedes the old zero-option-rng surface-and-wait guard);
  an unconstrained `?` is still an empty-fringe error
- this behavior was originally designed in plans/reify-choice-options.md (abandoned, v1);
  re-derived here for v2 after the dungeon port stalled on an unaffordable `buy` choice

# js-def relations inside !(...)
plan: plans/v2-js-rel-in-constrain.md

- allow a `#js-def` relation as a sub-atom of a `!(...)` constrain block
- expand tags such subs `*c-js` (no `-> weight`, arity checked eagerly); constraint-query enumerates the generator during the component's backtracking join instead of reading the store
- clause selection is dynamic (ground-under-substitution modes, earliest fitting clause); js subs are scheduled after all store-backed subs, component-wide

# term-render-component, info-log
plan: plans/v2-term-render-component.md

this change has two parts: slight refactor of the `info` panel; changing how term ids render

## term rendering
- we render terms in various parts of the editor as `*x`, where x is a natural number, its id in the hash-cons store
- this change will introduce a clickable element to render a term-id.
  - we will use it everywhere we currently display terms; so it will be parametrized so that it matches the current appearance of the various spots
  - clicking it will emit info about that term to the `info` panel; the info will include every tuple that refers to the term *directly*
    - this check does *not* recurse into terms to check indirect reference
      -`foo *3` refers to term 3; `foo (s *3)` does not
## refactor info panel
- turn it into a log: a place where we dump various kinds of info
- instead of rendering exactly the current choice set, we will emit those choices as a list of clickable log-lines
- any changes are append only
- we assume various components might be appended
  - the info log currently displays active choices.
    - after this change, we will refactor that into a component and append that component when a choice is to be made.
    - the component, once resolved, will still visually be there, but it will collapse and no longer accept input
  - after clicking a term `t`, we append an "all tuples that refer to `t`" component

# choice-actor syntax
plan: plans/v2-choice-actors.md

- instead of `?X`, we may write `?[<actor-specifier] X`
- for now, there is a finite set of actor ids
- the default actor is called `you`; the sugar `?X` is equivalent to `?[you]X`
- we will add a new actor called `rng`; basically, it indicates that the selection be made uniformly at random
- this change adds a handler branch to the code handling choices that interfaces with the scheduler
  - first: note that a choice component may include variables assigned to different actors
  - we assume actors are totally ordered, and in particular `you > rng`
  - choices resolved by priority, with highest actor first
  - when `rng` is the highest priority actor within a group, we choose one of its choice variables uniformly at random, then choose its value uniformly at random, and commit the choice

# live values in editor
plan: plans/v2-live-values-in-editor.md

- after clicking a tuple in the timeline/database and jumping to rule, visualize the *bound values* that were active when that particular tuple was asserted
- they should appear as faint var/value pairs to the side of each line where the value is bound
- terms should render as their `*x` id only

# 26/08/19
# aggregates, concluded
plan: plans/v2-aggregates-concluded.md
status: not adequate?

- this change will supercede #agg, #reactive, and the bracket notation
- the main idea:
  - running the main fixpoint loop produces a set of non-monotone obstructions that need to be resolved (aggregate observations and choices) (just like now). we'll call these *stuck moments*
  - we take the earliest stuck moment(s) and resolve them (just like now)
- the difference is how we calculate the stuck moments:
  - when a rule observes an aggregate like `it:at X -> L` it emits a `do-agg` tuple (like today) anchored at the parent interval as if it were asserted with `^`
  - for all aggregate relations we maintain a set of breakpoint moments (like for `#reactive` today)
    when a rule emits a tuple `it:at X Here` to be aggregated with left-endpoint m, we take the lub of m with each previous breakpoint
  - to calculate the stuck moments:
    for each `do-agg Rel @ M1, M2`:
      for each `Rel` breakpoint `M` ≤ `M2` and maximal with that property, that has no associated `agg-result`:
        yield `M` as stuck moment`
  - after getting all stuck moments, we evaluate the minimal ones, asserting `agg-result` tuples, and yield back to the fixpoint
  - an `agg-result` tuple is associated with a particular breakpoint/do-agg pair, not just one or the other.
    - for instance, a `do-agg` asserted at (bot, top) may yield many observations, one per breakpoint
  - we *discard* the rest; the next time we calculate stuck moments they may no longer be stuck (check this!)

```
#agg at * -> last
#agg :count * -> sum
~game
  ~f; ~g
f, ~move a x
f, ~move b x
g, ~move a y
move I T, +at I T
at I -> T, ^:count T -> 1
```

# 26/08/14

# extending icon
plan: plans/v2-icon-layout.md

- currently we use `icon I` and `icon:name I N` to display and label clickable icons
- now we add `left:right I1 I2` and `above:below I1 I2` for visual arrangement.
- the GUI should pack icons into a grid layout, respecting each constraint if possible
- default can match current behavior: icons entered into a row
- we assume no conflict between the layout constraints and the current `at X -> L` handling: we ignore `left:right x y` unless it is true that `at x -> z` and `at y -> z` (both have same parent) (same for `above:below`)

# js relations
plan: plans/v2-js-relations.md

currently we have `#js (inc x) { return x + 1; }` to define term-level js functions.

this change allows the following:

```
-- we use `+`, `-` to denote *mode*
#js-def range +Lo +Hi -I {
  for (let i = Lo; i < Hi; i++) {
    yield [i]; // yield just the unbound arguments
  }
}
```

then a use like
```
range 0 8 I, range 0 8 J, ^foo I J
```

- allowed only as match atoms
- a given relation may have several `js-def` with different mode markings
  - modes are ordered: `- < +`, and the overall order is the product order across the arguments
  - at compilation, we choose the earliest `js-def` that is ≤ the match atom
  - to do this, we need to do simple left-to-right binding analysis on rules.
  - we do this as a final stage: after expansion/splitting/etc
- must be pure functions

# 26/08/12
# 26/07/24

# tie visual provenance to atom spans, not lines
plan: plans/v2-atom-span-provenance.md

followup: this should ultimately be grounded on a reflection mechanism that links tuples to the source in a queryable way

# small things
- editor: source provenance tracked through exceptions
- editor: collapsible timeline bars
- parser: newline + no whitespace -> start of new rule
- semantics: some/none for `[Q | ...]`

# exception default-case provenance
plan: plans/v2-exception-default-provenance.md

- provenance attribution for the timeline/db view currently attributes an exception's default-case re-emitted tuple to the exception's line
- instead, attribute it to the line that asserted the original (re-written) tuple: `applyExceptions` records static head→prime links (derived from the final default-rule bodies, after all renaming), and a post-fixpoint pass rewrites `tupleSource` by matching each linked tuple to its stored prime tuple (same args sans id slot, same endpoints), following links transitively for chained exceptions
- no evaluator/decompose/renderer changes; exception-case output (`z` from `{x => ~z}`) keeps its current attribution to the RHS's own line

# 26/07/22
switching more to fable

# linking program to timeline view
plan: plans/v2-source-timeline-link.md

- currently, the editor "database" view maintains a bidirectional link between tuples and program lines
- this change will do the same for the timeline view: mousing over a timeline bar will highlight lines; clicking will move cursor. following the same logic
- this should apply both to the v2 editor page, and to the presentation mode display. we should use a common abstraction representing a live program, its execution, and one or more display widgets.

misc fixes to address: there is currently an alignment issue between the gutter highlight and the correct line number

# timeline occupancy-based lane placement
plan: plans/v2-timeline-occupancy-lanes.md

fix bars drifting to high lanes when later unrelated bars splice new
lanes below them. the placer keeps full per-lane occupancy instead of
a single frontier token, so placement becomes monotone: no splice, no
global shift. sharing rule (partial-order disjointness) unchanged.

# variable-head matches
plan: plans/v2-variable-head-match.md

a match whose head is a Variable (`foo T, T X`) should match whatever relation `T` names.
today it parses and expands fine but silently matches nothing.

- emit already works (`foo T, ~T zzz` emits `bar zzz`) — only `evalMatch` is broken
- it reads the head structurally out of the IR, never through the trail
- fix: resolve head via trail; Symbol -> existing bucket path, unbound -> full scan
- unbound scan skips `_`/`*`-headed engine rows

# aggregate output variable
plan: plans/v2-agg-output-var.md

semantics-preserving refactor of bracket aggregation: separate the reduced variable
from the variable it binds outward.

approximately: `[f X Y | sum Y]` becomes `[f X Y' | Y = sum Y']`

- the `Y` inside `Q` and the value bound for the enclosing expression are now distinct
- the LHS of `=` unifies: it tolerates an unbound variable, a bound variable, or a term
- consequence: an inner reduction variable no longer leaks into the enclosing query.
  `[[at A B | last B] | count A]` gives bindings over (A,B) -> (A,X) -> (X)
- this is what makes plain variable substitution into a bracket expression sound (see `# aggregation synonyms`)

# aggregation synonyms
plan: plans/v2-aggregation-synonyms.md
depends on: plans/v2-agg-output-var.md

we want to create macros that expand into bracket aggregate expressions (plans/v2-bracket-aggregation)

example:
```
land:count B A := [[at A B | last B] | count A]

activate push, target L, land:count L X, ~something X
```

- implementation:
  - simply rewrite occurrences of the macro (`land:count X Y`) with the body (`[[at A B | last B] | count A]`)
    - freshen all variables in the body
    - append `=` nodes that unify the locals with the parameters (`= X B, = Y A`)
  - assume macros are accessible throughout the source file (definition may follow use)
- static check: ensure macros are not recursive (directly or indirectly). compile time error

# another take on aggregation
plan: plans/v2-bracket-aggregation.md

- new aggregate operation
- generalizes the `agg` mechanism
- note about the aggregation:
  - aggregation fundamentally involves projection: we start with a set of tuples defined over some variables, then we project onto a subset of those variables, and for each group, we reduce to a single value by applying some fold operation to the group
  - this approach is going to reduce one variable at a time.
    - as an example, `[p X Y | sum Y]` is an expression that will produce one (X,Y) binding per unique value of X, with the Y value being bound to the sum of all input tuples' Y values.
      `{p 2 4, p 1 1, p 1 3} -> {(X:1,Y:4), (X:2, Y:4)}`
    - as another (slightly contrived) example, `[[p X Y | sum Y] | sum X]` would first reduce over Y, and then reduce over X, grouping X's together that happen to have the same aggregate Y value
      `{p 2 4, p 1 1, p 1 3} -> {(X:3,Y:4)}`

syntax:
```
[ Query | Reduction-expression ]
Query := sequence of match RuleAtoms
Reduction-expression
  = count V
  | sum V
  | last V
```

syntactic restriction: V must be a variable free in Query (not bound earlier in the rule)

semantics sketch:
- the expression `[Q | R]` occurs within a Turn rule, so there is an active anchor A at that point
- evaluate Q as a normal match, but *restricted only to tuples that contain A*
  - we will assume Q contains no temporal stuff: it is a plain join query.
    the only temporal aspect is the one just noted about containing A.
- this produces a set of bindings defined over the free variables of Q
- apply the reduction operation wrt the given variable:
  - `foo X` means to project onto the variables except X and apply `foo` to the X's, binding the result to X in the enclosing expression
    - `count X`: ignore X values
    - `sum X`: sum X values
    - `last X`: take temporally last X value, in the same way that the current `last` operation works (note that last produces multiple values if there are incomparable final moments)

some examples:
```
[ invader X | count X ] -- produces one tuple; the count of all invaders
[ it:at X L | last L ]  -- produces one tuple per X; the last (temporally) value of L
monster X, [ it:at X L | last L ] -- `monster X` binds X inside the aggregate; produces one value of L per
[ [ it:at X L, invader X | last L ] | count X ] -- produces one tuple per L; the count of invaders at L
[ invader X, [ it:at X L | last L ] | count X ] -- this is semantically identical to previous
```

full examples:
```
-- *for each point scored during draw-step, score another point after draw-step*
( draw-step, active-player P
  ( draw, [ score P X | sum X ] ) );
( post-draw-step, ~score P X )
```

# 26/07/21
some usage of fable starting around now; still mainly opus

# arity + auto `_` insertion
plan: plans/v2-arity-auto-wildcard.md

- idea: predicate arity determined by number of `:` characters occurring.
  this is already followed to some extent by convention, but this would make it part of the language
  so `turn` has arity 1, `player:hand` has arity 2, and so on
  (we essentially never use nullary predicates, except in cases that we are now ok promoting to arity 1 because of the next bullet point)
- the reason is to enable a shorthand for (unary) temporal predicates where we usually don't care about their argument, but sometimes need it
  e.g. we can write
  `turn, (~draw; ~play)`
  which expands to
  `turn _, (~draw _; ~play _)`
  and later write
  `play, ~do-something`
  as well as
  `play E, some-predicate P, ^played:card E P`

# 26/07/16
# 26/07/13
- see `# exceptions`

# expansion refactoring using binary connectives
plan: plans/v2-temporal-connectives.md (step 1: parity refactor)
followed by: plans/v2-bound-set-anchors.md (step 2: commutative `,`, bound-set anchors; from plan review discussion)
status: pending

- idea: conceptually simplify the "anchor decomposition" stage of `expand.ts`
- introduce new IR containing binary operators called *temporal connectives*
- each connective performs a join over its children, but also joins their intervals to produce a new interval, depending on the connective in question
  - `a , b`: succeeds if child intervals overlap; produces the overlap (replicates current behavior of `a, b`)
  - `a / b`: succeeds if children overlap; produces interval of left child (replicates current behavior of `a, (b)`)
  - `a /; b`: succeeds if children overlap; produces interval (x, y) where x is right endpoint of b, and y is right endpoint of a (replicates current behavior of `a, (b); ...`)
- the point is this:
  - it should be very easy to translate the pre-decomp RuleAtom IR into this IR
  - it should be possible to then generate the post-decomp RuleAtom IR from this IR using a very simple syntax-directed recursive function. it should be somewhat simpler than the current implementation
  - at the end of the day, we will have 3 irs for the 3 stages
- this sketch is missing details and may be mistaken, so please review.

# 26/07/2
- revert to connective formulation?

# 26/06/30
# per-group reactive breakpoints (semi-naive materialization)
plan: plans/v2-per-group-breakpoints.md

- the scheduler pools every group's left endpoints and re-folds every group at
  every pooled breakpoint, re-stamping unchanged groups (`_aggval at me a @ *22`
  when `it` moved) — over-materialization
- fix: a group's breakpoints are the join-closure of ITS OWN contributors; a new
  source fact folds only the group it belongs to (semi-naive delta)
- complementary to the read-snapshot plan: removes the re-stamp duplicate;
  enclose-start + last still handle the self-read and genuine value selection

# reactive read = last-read snapshot (enclose-the-start)
plan: plans/v2-reactive-read-snapshot.md

- a `#reactive` read in a rule body (`move A B, at A -> C`) over-matches: it
  plain-joins every over-persisted `_aggval` row that *overlaps* the anchor and
  never `last`-selects, so it reads the move's own caused `at` and later changes
- should bind the value *as of the start* of the surrounding match (the `at`
  row whose interval encloses `move_l`), i.e. a `last`-by-left-endpoint read
- implements the consumption side v2-reactive-aggregates.md specified but never built

# stratification analysis
plan: plans/v2-stratification-analysis.md

- for each `a, ..., ~b` add an edge from `a` to `b` marked `<`
- for each `a, ..., +b` add an edge from `a` to `b` marked `<`
- for each `a, ..., ^b` add an edge from `a` to `b` marked `=`
- same for aggregation atoms

this will be used to compute aggregates correctly, and possibly useful for other analyses later

# 26/06/22

# reactive aggregates?
plan: plans/v2-reactive-aggregates.md

# 26/06/21
# 26/06/15

# timeline: edge-anchored moments + pairwise arrows
plan: plans/v2-timeline-edge-moments.md

- new horizontal timeline variant: moment dots sit at the left/right edges of interval bars inside the diagram (not on the spine), and arrows are drawn between each pair of moments
- shows ordering info the current view loses when distinct moments collapse to the same rank

decided: Hasse covers only; suppress arrows implied by a bar's own endpoints; interval-aware arrow routing (straight when clear, corridor detours around bars); horizontal orientation only; each distinct moment gets its own horizontal position (linear extension replaces ranks); one canonical dot per moment (arbitrary bar edge), dashed vertical ties to other bars sharing the moment

# clean up v1
plan: plans/v1-cleanup.md

goal:
- move any deprecated "v1" code to a v1/ folder. ensure that it is complete (we could go back and run the v1 version if we wanted)
- make the v2 free-standing; ensure that any lingering connections (e.g. the types file) are duplicated into v2
- ensure that the main server application only accesses v2 functionality

# CLI interface
plan: plans/v2-cli-interface.md

- add a script that provides CLI access to turn compilation/evaluation
- include a "stage" flag that determines what stage of output to produce (after parse, after various expand steps, final program, final evaluation with db output)
- accept input from stdin or file

# 26/06/9
installed typescript-lsp plugin
  not sure about this

# 26/06/8

# better aggregates
plan: plans/v2-aggregate-comprehensions.md
status: abandoned

```
+total me 2
= ... sum( X -> Y | total X Y )           # per X, sum of Y

-- nested: for location L, total value of tokens whose last loc is L
sum( L -> Val | last( T -> L | token T, at T L ), value T Val )

-- turns in which at least one card was drawn
activate.hmm,
count( T -> N | turn T, draw-card ), N > 0

sum( L -> Val | last( T -> L | token T, at T L ), value T Val )

token T, at T L, +_agg0 T L
sum( L -> Val | _agg0 T -> L, value T Val )

token T, at T L, +_agg0 T L
_agg0 T -> L, value T Val, +_agg1 L Val
_agg1 L -> Val
```

# 26/06/7
- aggregation
- show the hasse diagram
- start thinking about garbage collection

# editor auto-complete
plan: plans/v2-editor-autocomplete.md

- new editor parameter (set when constructed): enable symbol/variable autocomplete
  - default to on for index-v2, off for pres editors
- if cursor is at right-end of a token that parses as a symbol or variable, propose autocompletion based on 1) set of symbols in current program or 2) set of variables in current rule
  - right-end means whitespace to right, at least one non-whitespace to left
- display only top N continuations in an overlay box; text should match the teal color used in index-v2 database view
- if current token is complete symbol/variable or has no continuations, don't display box
- when box is shown, <tab> selects first one. no keybinding to select others.
- box displays at most 5
- must work even if program fails to parse; finding symbols is trivial from the lexer
  - finding variables is harder because rules can be either whitespace separated or begin with `#def ...`
  - decision: don't track state or guess; just disable proposals for variable completion if the program doesn't parse
- helper functions:
  - determine prefix of rule text of rule containing cursor
  - determine token that cursor is immediately to the right of, if exists
  - compute completions
    - strategy: propose strict continuation followed by subsequence continuations (query chars in order, gaps allowed; hyphens are not special); so if symbols `foo` `foo-bar` exist, then `f` could complete either
      example:
        suppose file contains symbols `foo`, `fbar` `foo-b-ar`
        query: `fo` completions: `foo`, `foo-b-ar`
        query: `fb` completions: `fbar`, `foo-b-ar`
        query: `ba` completions: `fbar` `foo-b-ar`
        query: `foo` completions: none (exact match)
      any other edge cases you can think of?
    - edge case: the in-progress token is itself part of the program text, so it gets
      collected as a symbol/variable and would exact-match itself (always suppressing
      the box). fix: blank out the token's span (preserving offsets so line numbers and
      other occurrences are unchanged) before collecting candidates. a genuinely-complete
      token still matches its other occurrence(s) and is suppressed correctly.

# 26/06/3
- add pres to file overview
- ? cleanup: move v1 code to sub-dir

# random actor
plan: TODO
status: ? depends on small change: store some tuples outside of source text

- add a new optional syntax for `?` (ask): `?[...]`, which allows an *actor* to be selected
- for now, two options: `random` and `you`. the default (what is done today) is `you`
- each actor corresponds to a *handler* for the choice when it is scheduled; currently all of the handling is external to evaluation and results in an `is` tuple being asserted
- example RuleAtom: `?[random] C`
- the `random` actor will also generate an `is` tuple, but ...
  ...

# user defined js functions
plan: plans/v2-user-js-functions.md

```
#js (div x y) {
  return Math.round(x / y);
}
```
becomes
```
function div(x, y) {
  return Math.floor(x / y);
}
```
and it's called like:
```
  +foo @js(div X 4)
```

- this is a new `#` command (alongside existing `#def` and `#agg`)
- it allows easy calls to arbitrary js code, which we expect to be *pure*
- any variables in the `@js(...)` expression must be bound (error at lift time)

## term encoding/decoding
- a compound like `(pair x (f y))` becomes `["pair", "x", ["f", "y"]]` on the js side and translated back
- `bool` in js becomes 0/1 on term side
- other relevant cases? expand this list
- apply `decode` for each argument before call; and `encode` on the return value

# 26/06/2

# `sum` weight parsing
plan: plans/v2-sum-reject-invalid-weights.md
status: unimplemented

# relaxed editor freezing
plan: plans/v2-relaxed-editor-freezing.md

- walking back the most recent change partially
  (plans/v2-pres-preserve-edits)
- logically, a code block with n pauses represents n+1 different editor states (each called a *reveal*)
- moving from one to the next means concatenating some lines of code (a *segment*) to the previous
- we will return to the prior behavior, where each intermediate state can be edited
- we use the following data structure S per code block:
  - for each reveal, either `left Segment `, where Segment is the segment from the source file, or `right EditState`,
    where EditState is the edited content
  - on advance to reveal R, do `editorState(R, S)`
    - if S(R) = left Segment, append Segment to `editorState(R-1, S)`
    - if S(R) = right EditState, return EditState
  - an edit can only be done at R if S(R') = left, for all R < R'
    - otherwise, editor should be frozen
  - when an edit is done at R and S(R) = left ..., update S(R) = right content, where content is the current content plus the edit
    if S(R) = right already, then just update the state

## what happens if we advance backwards?
- advancing backwards may move to a slide that is before the latest edited `r`. doing so freezes the editor
  note that, on the initial pass forward, all reveal states are editable (because `r` is >= 1)
  (this should be checked on each reveal change, not just backward steps)

# 26/05/29
exn todo
- review note about anchor for `e`
- review multiple exns per rule

# pres preserves edits during a presentation
plan: plans/v2-pres-preserve-edits.md

- when we edit the code of a slide, we should preserve those edits in the in-memory representation
  leaving and returning to the slide should preserve edits
- this is complicated by the fact that each code block may be divided into segments by `[pause]` expressions
- we will simplify by only allowing edits to the final version of the code. the earlier stages will show their original content, then after the last pause within a code block, the full (potentially modified) code will be loaded
- the main requirement is to add a flag and method to the editor class: whether the editor is frozen.
- after creating the editor for the slide, freeze it if it contains pauses; after last pause, unfreeze

# 26/05/28
- slide overview view?
- primary model: switched to opus 4.8

# 26/05/27
# 26/05/26
# 26/05/25
todo
- actors
  - random
  ? arbitrary
- dominion
  fix gain-action timing
- choice widget on slides
- progress on exceptions
? views on codebase
  - all rules referring to `p`

# exceptions
plan: plans/v2-exceptions.md
amended: plans/v2-exception-watchers.md (26/07/13 — non-gating watcher desugaring; exception LHS vars are local)

*exceptions* are rules that override default behavior in some sense
```
activate.it.is misfits
  ~choose.it _X, !in-supply _X;
  is _X X
  ~play-card.it.^is X
    {move X _ => ~nope}
```

```
foo . {bar => baz}
{card => foo} . action
action.it.is.{move To => move To'}
```

- an exception expression is `{p t1..tn => e}`
  - the lhs is an atom without a marker
  - the rhs is an arbitrary rule expression that *does not contain any exception expression*
- they are implemented as a global program transformation that occurs before any expansion
- every positive occurrence of the predicate symbol `p` is rewritten to a fresh `p'`
- the exception expression is rewritten to `(p' t1..tn, ^ p_exn V1..Vm -> 1)` (within the rule it occurs in)
  - the `Vi` variables are any variables appearing in `e` that are bound earlier in the rule (any bound within `t1..tn` can be excluded)
    - note that if rule contains two `{...}`, then the latter expression's `Vi` may contain variables bound by the prior expression's `t1...tn`
      the basic requirement is that the generated exception/default rules described below should have no dangling references
- we generate a fresh `p_exn` symbol and a declaration `#acc p_exn v1..vm => bool` (the `vi` terms are arbitrary; ignored by compiler for now)
- a new rule `p' t1..tn, p_exn V1..Vm -> 1, e` (*exception*)
- a new rule `p' V1..Vn, p_exn ... -> 0, ^ p V1..Vn` (*default*)
  - the `V1..Vn` here are fresh variables; the default rule matches any tuple, not just the ones matching the terms used in the exception case
  - the arguments to `p_exn` (in the default case) should be all bound by `_`, since they are unused
- the generated rule names should be derived from the source rule name:
  ```
  #def f ... { ... } ...
  ```
  generates three rules, whose names are as if they were declared:
  ```
  #def f ...
  #def f_exn ...
  #def f_default ...
  ```

no other semantics changes: this feature is a source-to-source transform on the rule set


## multiple exceptions on `p`

multiple exceptions are handled trivially by applying the previous logic in sequence:
- we assume that the set of rules containing exceptions is totally ordered
- if we have `{p => q}` followed by `{p => r}`, we apply the transformation for `p => q` first; in particular, this generates a default case which asserts `p`
- then when handling `p => r`, these generated rules are rewritten as described

## multiple exceptions in one rule

- as before, exception rewrites are applied one at a time, starting with the one earlier in the rule
- see note above about variable scoping

## limitations (for now)
- `{...}` cannot appear as the head or tail of a dot (`.`)
- the rhs `e` of `{... => e}` cannot contain `{...}`

## comments/issues for later
questions (these are considerations for later, not this change):
- is the f_exn rule redundant? just do `e` inside `f`? is it meaningfully easier to understand this way?
- we could allow the set of all rules to be ordered, so that rule R later than exception E is not re-written by it
  - we might not expose this to users, or only through a dedicated syntax

### the misfits example explained
the intent here is to play the selected card without moving it
the exception fires exactly when a card is going to be moved as a result of playing it in this context

# boolean aggregate
plan: plans/v2-bool-aggregate.md

- a new aggregation type, `bool`, which produces boolean values `0, 1`
- declared `#acc p <args> -> bool`
- fact is asserted `(+|^|~)p Arg -> 1`. asserting `... -> 0` is a syntax error
- query is written `p Arg -> 1` or `p Arg -> 0`
- isomorphic to count (count = z vs. count = (s _))

# 26/05/25
hello from bertinoro!

# draggable svg in slides
plan: plans/v2-pres-svg-draggable.md
status: incomplete demo to show someone claudecode. might be useful after file persistence is implemented

changes to pres:
- syntax for embedding svg graphics:
  ```
  [svg][%
  ...
  %]
- direct-manipulation edits to svg source
  - attach mouse drag handlers to all geometry
  - translate drag events on geometry to source edits to geometry coordinates
  - persist changes in memory, since source file cannot be edited by slide software

# easier semicolon syntax
plan: plans/v2-easier-semicolon.md

- change parser so that `... ; ...` -> `(... ); ...`
- for example:
  ```
  foo
    bar; baz; quux
  ```
  ->
  ```
  foo
    ((bar); baz); quux
  ```
  or
  ```
  foo
    bar;
    baz;
    quux
  ```
  ->
  ```
  foo
    ( bar );
    ( baz );
    quux
  ```
- this effect is local to the line


# compound constraints
plan: plans/v2-compound-constraints.md

- we want to write something like:
  ...
  ? A B
  !(prop A X, other-prop X B)
  ...
- a variable inside a constraint can be either bound by an `ask` earlier in the rule, bound by an ordinary variable, or free
- at eval time, when the `!(...)` is asserted, we do the following:
  - bound by regular var: substitute the value into the asserted row
  - bound by ask node: replaced by active term during expand
  - free (the new thing): replaced by a *var* term during expand. a fresh term like the other ids
- after the choice component is built, we treat these var terms like ordinary free variables. in summary, when the component is being built, it branches on the forms of terms:
  - active term T: checks for `is T V`, substitutes if available. otherwise part of the active terms
  - var term (new): replaced by a fresh ordinary variable
  - other value: treated as literal term
- note: suppose we had these rules

  ```
  event, ? X, ~it X

  it A, !(p1 A Y, p2 Y)

  it B, !(p3 B Y, P4 Y)
  ```

  few things to note:
    - A and B refer to the same term (they both bind the active term generated by `?X`
    - the two constraints happen to use the same variable Y
    - the final generated constraint component query is equivalent to this:
      `p1 X Y1, p2 Y1, p3 X Y2, p4 Y2`
      that is, we would not want the two constrains to accidentally capture each others' variables
      this is the reason for converting each to an id at assert time, then treating them as free variables at choice time

# is-substitution during constraint queries
plan: plans/v2-is-substitution.md

- partial commits (binding some active terms of a multi-slot component) currently leave the
  component in a dead state — the constraint query matches the original `*id` template
  literally instead of the bound value. fix: gather `is X V` rows into a substitution map
  and rewrite each constrain row's wrapped atom before querying.

# 26/05/22
todo
- compound constraints
- dev server it
- fix done!
  - issue with count?
- handle multiple locations in choice gui
  not an issue

# default GUI
plan: plans/v2-default-gui.md

- we began a related plan several changes ago. the idea is roughly the same, but the details of that plan are stale
- core idea:
  - a program may generate elements of an `icon X` relation and `#acc at * -> last` relation
    - wrt a particular moment M, we can render the db state guided by these relations:
      - if `icon X` holds, we should generate a div I and associate it with X.
      - if `at X -> Y` holds at M, and we have icon IX for X and icon IY for Y, then IX should be a child element of IY
    - the rendering will be guided by our need to solicit choices from the player
      - suppose that one choice component C is active, and its choice component moment is M
        - the component has some set of activeTerms; render an icon for each of them
        - render the db wrt M
        - if icon I corresponds to X, and X is a valid value for one of the active choice variables, highlight I
        - if I is clicked, then:
          - if it corresponds unambiguously to a single active choice term, bind it to that term
          - if it ambiguously corresponds, then apply a different highlight to I, then highlight the set of possible active terms
            - after the user clicks one, bind it
          - if I is clicked again without being bound, unselect it
      - suppose more generally that several choice components C_1..C_n are active
        - render icon groups for each component
        - pick arbitrarily C_1 (at moment M1) to be *selected*; highlight its group
        - render the state at M1
        - same as above; handle all actions wrt C_1
        - if the user clicks a different choice component group C_i, activate it. update the state rendering wrt M_i

# choice component evaluation
plan: plans/v2-choice-component-evaluation.md
note: notes/moment-insertion.md

- use the moment-lub function to compute the **choice component moment** (the moment associated with a choice component)
- specifically, compute the lub M of all the left endpoints of all the constrain/constrain-agg tuples in the component
- instead of evaluating each constrain wrt its own interval, evaluate wrt M:
  - constrain tuples are restricted to tuples that contain M
  - constrain aggregate tuples are restricted to tuples that contain M

# timeline: weakened lane-sharing rule
plan: plans/v2-timeline-weakened-lane-sharing.md

relax "same lane = same containment parent" to "a.rTok ≤ b.lTok in the moment partial order"
for lane-mates. siblings of different parents can share a lane when temporally disjoint;
yields denser pictures, especially in tree mode (e.g. print here/print there merge).

# timeline: nested lane layout
plan: plans/v2-timeline-nested-lanes.md

new lane-assignment mode for episode bars: arrange by containment hierarchy (leaves
on lane 0, parents above, `~game` outermost) so the program structure is visible in
the picture. coexists with the current greedy minimum-lane mode via a `laneMode` opt.

# pres: always-mounted editor for code blocks
plan: plans/v2-pres-editor-always-mounted.md

replace the initial `<pre>` rendering of a code block with an editor from slide-entry
so the only thing that changes on slide advance is the editor's value; drops the
pre→editor transition and the duplicated visual style between the two.

# editor line number gutter
plan: plans/v2-editor-gutter.md

- for now, the gutter will only display line numbers in a color slightly different than main text

# pres: show last run if text invalid
plan: plans/v2-pres-stale-db-on-error.md

currently, in presentation mode, if the program in an editor doesn't parse, the db/timeline components just
  show the parse error. sketch a plan that would instead run the most recently valid program and show its
  db/timeline, and display the parse error separately

# improved horizontal timeline layout
plan: plans/v2-timeline-variable-columns.md

- how might we adjust spacing for horizontal-layout mode to better fit the
  text? I'd like to decrease the spacing between ranks when there is little or
  no text, and increase the spacing if necessary for long text labels
- how do we measure the text width definitively (without assuming a static width)?

# 26/05/21
todo:
- get demo website on internet
- publish WIP slides/blog?
  - control passing slide
  - final slide (choice gui?)

# standalone slides
plan: plans/v2-pres-standalone.md

modify pres/ to generate standalone pages.
foo.pres -> foo.html.
this is a minimal change: all we want to do is embed the original slide source as a string inside `foo.html`
we can do parsing and rendering at load time, just like now

# 26/05/19

# temporal issues around choices and constraints
## moment LUB
plan: plans/v2-moment-lub.md

given a set of moments S and a store:
- compute the set U of moments >= everything in S
- compute the minimal elements of U
- if the result set is a singleton {LUB}, define that to be the least upper bound of S

note: incomplete

# fix choice issue
plan: plans/v2-earliest-tier-choices.md
currently all choices are being proffered at once, not just the earliest component(s)

# 26/05/18

# slide software
plan: plans/presentation-software.md

let's build some simple presentation software here.
goals:

- describe a presentation consisting of slides using plain text
- integrate basic features, like text highlighting and `[pause]` command
- navigation either bullet by bullet or whole slide at a time
- integration with turn evaluator, so we can have inline program and program output, or timeline viz

here's an example document:
```
[metadata][%
  title: Turn Intro
  author: Scott Kovach
  date: [today]
%]

[slide][%Purpose%]
- Turn is for describing situations [pause]
- It does stuff

[slide][%The Now%]
A query describes a point in time, reading from top to bottom:
[code][%
turn T       -- during some Turn... [pause]
play-card C  -- a card is played... [pause]
action C     -- that is an action... [pause]
~activate C  -- so activate the card.
%]

[slide][%Demo%]
[code][%
~turn T       -- during some Turn...
~play-card C  -- a card is played...
~action C     -- that is an action...
%][timeline,tuples]
```

- bracket commands: `[name]`, `[name][%body%]`, or `[name][%body%][opts]`
- `[%` … `%]` bodies nest, so they can contain blank lines and brackets
- slides are introduced by `[slide][%Title%]`; blank lines are not structural
- `[metadata]` is not rendered; an auto title slide is built from its `title`/`author`/`date`
- `[code][%...%]` is monospaced and editable; `[pause]` inside it splits the reveal
- `[code][%...%][opts]` options:
  - timeline: small timeline view from web-v2
  - tuples: display output like in `DISPLAY` component from web-v2
- the code is editable in-place; edits stick across slide changes but aren't persisted
- `- ` lines become list items
- `[pause]` anywhere cuts the reveal at exactly that point

note: in the course of implementation and plan refinement, syntax changed
todo: add link to living spec

# 26/05/15

# expand liveness
see ts/src/v2/expand-liveness.ts

# 26/05/13
todo:
  - default display
    ! constraints might exist at different points in time
  ? numeral relation literal

# rule names/commands
plan: plans/v2-rule-names.md

# default display
plan: plans/v2-default-display.md
status: superseded by plans/v2-default-gui.md

sketch a plan for a "default display" that works for any program.
  we'll use a special `icon` predicate to mark terms that want a visual representation.
  each will get a div in display with the term pretty-printed as the label text.
  then when a term is a valid choice for exactly one of the active components,
    its icon can be clicked to create the `is` tuple

# constrain by aggregate
plan: plans/constrain-aggregate.md

- handle `! at X -> Y` properly

# .dot notation

plan: plans/v2-dot-notation.md

new purely syntactic feature: writing `foo . bar` is a shorthand for a binary join: `foo X1, bar X1`
more examples:
  foo X . bar y Z -> foo X X1, bar X1 y Z
  player . score -> S -> player P, score P -> S
  player .hand .top-card C -> player P, hand P H, top-card H C
  player.hand.top-card C -> player P, hand P H, top-card H C
  turn .(actor A) .(index I) -> turn T, (actor T A), (index T I)
  turn .(actor.name N) .foo F -> turn T, (actor T A, name A N), foo T F

we should introduce a new temp IR that the parser produces containing dots;
then we rewrite into the current IR with the fresh variables inserted
nothing later changes

# 26/05/11

# move decompose first, fix lingering rule expansion issues
plan: plans/v2-decompose-first-pipeline.md
supersedes
  plans/v2-consumer-prefix-elision.md
  plans/v2-prefix-expansion.md

# 26/05/10

# v2 explicit anchor manipulations in IR
plan: plans/v2-explicit-anchor-ir.md

- move anchor intersection / overlap / fresh-moment / addOrder out of
  evaluator and into the program IR
- new RuleAtom constructors: Match, Emit, Le, AssertLt, Max, Min
- match no longer overlap-tests or intersects; assert no longer mints
  moments — expand emits explicit `le / max / min / assert-lt` chains
- e.g. `a, b` -> `[al,ar] a, [bl,br] b, le al br, le bl ar, max al bl xl, min ar br xr`
- `+ b` -> `= bl <freshMom>, assert-lt al bl, assert-lt bl ar, emit [bl, top] b`

# v2 consumer prefix elision (aggregate rules)
plan: plans/v2-consumer-prefix-elision.md
revisit after plans/v2-explicit-anchor-ir.md

- aggregate consumer body re-runs the prefix join purely to put
  prefix-bound vars back in scope; the producer's `aggId` already
  encodes the same info (it's a freshIdTerm derived from the
  prefix's chain)
- replace consumer body with a single `_agg-result` match whose
  `aggId` arg is a structured `Id` pattern: slot positions are
  Wildcards, prefix user vars are Variables — unification binds
  them from the matched aggId
- drops the `_do-agg` match and all prefix matches; `_do-agg` ↔
  `_agg-result` are 1:1 so no information is lost
- top-level weighted matches first; sub-nested ones deferred

# v2 stats tracker
plan: plans/v2-stats-tracker.md

- per-rule-variant counters: invocations, skipped, firings,
  tuplesEmitted, tuplesDeduped, wallMs, candidate funnel
  (scan → gen → overlap → literal → unify)
- per-head: scanCount, bucketSize, peakBucketSize
- per-iteration: tuplesAdded, dupes, rulesRan, rulesSkipped
- opt-in flag on the store; off by default to keep the hot path clean

# v2 prefix expansion
plan: plans/v2-prefix-expansion.md
waiting

- port v1 expand step 3: emit one expanded rule per positive atom,
  with earlier positives demoted to matches and the target as the
  rule's only positive
- removes within-sweep cascade dependence and producer/consumer
  prefix-sharing; combined with strict semi-naive, makes
  `addTuple` dedup ≈redundant
- runs after `splitRule`, before `generateDeltaVariants`

# v2 semi-naive evaluation
plan: plans/v2-seminaive.md

- port the v1 three-bucket (any/delta/old) scheme to the v2 evaluator
- gen-stamp tuples; emit one delta variant per match atom; filter
  candidates in `evalMatch`'s candidate loop
- correctness is already preserved by `addTuple` dedup; this is a
  perf change to stop re-enumerating the full store every round

# nat syntax
plan: plans/v2-nat-syntax.md
status: pending

- parse numerals (0, 1, 2, ...) as unary encoded natural numbers (z, (s z), (s (s z)), ...)
- also display them
- make this a modular feature: it should be possible to define new objects in the future that define a specialized parser/pretty-printer for other term patterns
  - that is, there should be an interface definition for what comprises a TermSugar; but this doesn't need to be handled dynamically; we can have all the actual instances written down in one place in the compiler to avoid boilerplate

# v2 tuple/source links
plan: plans/v2-source-output-linking.md

# 26/05/9

# v2 design notes
see notes/v2-design.md (living document for cross-file v2 invariants)

# v2 — tag compiler-generated identity terms as Id
plan: plans/v2-id-tagging.md

# v2 timeline view
plan: plans/v2-timeline-view.md

- a visualization pane that lays moments out left-to-right by partial order
- `~` episodes as labeled bars between their endpoints
- `+` facts as vertical lines at their left endpoint with the tuple text below
- arrows between moments along the Hasse reduction of the moment order
- `^` tuples align automatically since identical moments share an x-coordinate

# update editor keybindings
plan: plans/v2-editor-keybindings.md

# update editor
plan: plans/v2-editor-ttt.md

# redo choice
plan: plans/redo-choice.md

- port the choice syntax to v2
  - see end of notes/turn-program-1.t and the edit inside it to `!` tuples

- re-establish the "scheduling" pattern
  - rules with an aggregate as their next operation should block until other rules reach a fixpoint
  - any `_choose` tuple is also "blocked"
  - earliest blocked _choose or aggregate may proceed. to proceed:
    - aggregate is computed
    - in case of choice, computation is just stuck. the harness waits for a new user choice and restarts computation from scratch

# new semantics
plan: plans/new-semantics.md

this proposes major changes to the syntax and semantics.
this should be implemented parallel to the existing project code until ready to switch over.
there is substantial conceptual overlap with the existing language and editing tools, so we are not initiating a fresh project

see this program for a tutorial:
notes/turn-program-1.t

# 26/05/8
- let's start recording the date in-file
- date entries might have some notes like this, or todos
- note [26/05/21]: after format edit, might have positioned this wrong by one or two plans

# rule name parsing
plan: plans/rule-name-parsing.md

- add a step to the parser that parses an optional rulename prefix for each rule
  ```
  : rule
  - foo
    + bar
  ```

  - new `:` node
  - at most one per rule, must be first statement
  - if missing, do the current auto-gen behavior (r1, r2, ...)

- before expansion, check that the initial program has unique name per rule

# static dispatch
plan: plans/static-dispatch.md
status: abandoned

# new flat relational IR
plan: plans/flat-relational-ir.md

- new IR called TurnExpr (*TE* for short); convert tree into TurnExpr before evaluation
- TE is a list of constraints, each of which is an *atom* or an *episode relationship*
- key idea is that the temporal relationships handled by parent/child and before/after (via TreeBody.children) are more explicit
- episode relationships:
  before:after, contains, prior, overlap
- atoms: same as now: an id and a list of terms, usually the first one being a symbol
- each of Assert, Constrain, Aggregate, Ask will become a leaf node in the new type
- there will be only one negative leaf node
- the current negative nodes (Match, Before, Overlap) will be translated to one leaf node + whatever constraints on their children
- key question: where in pipeline do we implement this

# reifying choice option tuples
plan: plans/reify-choice-options.md
status: abandoned

- instead of evaluating choice "components" outside of the fixpoint loop,
  materialize the option query as a pattern and evaluate it "normally"
- first step: add a general method for adding a new pattern rule to a fixpoint in progress.
  the new rule should see all tuples it would have seen had it been present all along;
  we will assume that this feature is only used on *safe* rules that would not have changed the course of the program, that is (in pseudocode):
    -- running join program from empty set = running joint program from fixpoint of base program
    fix(P+P', {}) = fix(P+P', fix(P))

# separate id terms from atom
plan: plans/separate-id-terms.md

- it is dangerous to ever recursively traverse id nodes, because they grow exponentially in absolute size
- currently they are represented using the same term node type (Atom) as user defined compound values, which typically do not grow exponentially
- we will add a new Term constructor, `Id`: `| { tag: "Id"; atom: Atom }`,
  which will behave like `Atom` in most respects, but individual functions will likely treat differently

# implement constraint tuples pt1
plan: plans/constraint-tuples.md

## step 0: refactor `Ask`
- ask becomes a node without TreeBody; instead it has two fields: an id and an array of Variable
  - represent this array as an Atom, but check during parsing that each is a variable
- it is a positive node type, and subject to the step where `id` and unbound variable terms are expanded into Atom terms, just like `id`
  - that is, the atom of terms will be expanded into `id` atom terms
- similar to how aggregate nodes are expanded into Assert of `agg-instance`, expand these nodes into Assert of `choose` with given id and atom of arguments

## step 1: recognizing active choices
- we are going to stop fixpoints early if there is an *unresolved choice* that is *earlier* than any pending aggregate
  - an unresolved choice is a term C which was asserted by an `Ask` atom like `?choose C` that
    does not have a corresponding `is C Value` tuple in the store.
- recall that, while evaluating aggregates, we only resolve a pending aggregate that has no earlier pending aggregate
- we are going to consider all unresolved choices and pending aggregates together
  - if any of the earliest things are aggregates, resolve those aggregates
  - if all of the earliest things are choices, break out from the fixpoint.
- the fixpoint now returns a tagged union indicating the reason for breaking
  - if pending choices, it should return the set of all pending/"active" choices (e.g., a list containign the actual atom bound to `C`)
  - if it runs out of gas, returns number of steps run
  - otherwise it returns a default case indicating completion

## step 2: processing Constrain tuples in the output
- the `Constrain` tuples should behave similar to Assert during fixpoint calculation
  - Constrain nodes are positive
  - match nodes do not match `Constrain` tuples in ref store
- if the fixpoint breaks due to a pending choice, we will analyze the choice term
  - calculate the fringe (see below) for the choice term
  - filter to only the `Constrain` tuples in the fringe
- interpret the fringe as a query
  - each tuple is like a `match` atom
  - each choice term becomes a variable
  - combine the fringe tuples as siblings within the match root.
    - so e.g. `card C` and `prop C` becomes the pattern
      ```
      - card C
      - prop C
      ```
  - normally this pattern would do nothing (since it contains no positive node).
    instead, run this as a one-off query wrt the current tuple store
  - display the options as a list to the user

## step 3: web.ts interface
- the `web.ts` interface will change somewhat significantly
- instead of the existing code for locating choices and binding them to clicks, we will extract the available choice(s) from the fixpoint output
  - e.g. in the ttt.sl/ttt.js example, clicking will respond to the currently active choice
- the fringe query will be displayed

# refactor Tree type pt 4
split connective/positivity coupling

# refactor Tree type pt 3
plan: plans/refactor-tree-type-pt3.md

- now remove the id, atom, and children fields from TreeBase; every case still needs them except for Equal
- check that no behavior depends on Equal having those fields

# refactor Tree type pt 2
plan: plans/refactor-tree-type-pt2.md

goal: simplify NodeRow

- the nilTree should have an assert tag, not Match
- check this claim: the only calls to buildRefStore pass in the nil tree
  - if true: we can get rid of buildRefStore (which takes an arbitrary Tree), and rewrite it to just construct the canonical empty store
- check this claim: every other insert inserts either an `Assert` or `Ask`
  - if true: we don't need the wide NodeRow type; we only need a couple of cases for positive tags

# refactor Tree type
plan: plans/refactor-tree-type.md

propose a refactor to the Tree type (types.ts) that merges together Tree, Literal, and LiteralType.
- afterwards, there should be one case of Tree per current case of LiteralType
- initially, the types should be isomorphic and all other code should behave the same
- note that as the project developed, Tree was used both for patterns and reference trees,
  but currently the reference is stored using a different type

# eliminate Variables in output
plan: plans/eliminate-variables-output.md

# fix agg-instance nesting
plan: TODO

- motivating case: the "last aggregate" test in `ts/src/fixpoint.test.ts`
  (currently skipped behind `if (false)`) trips the
  `sortBindings` throw for non-commutative aggregators. The three
  `agg-binding` siblings under a single `agg-instance` are not
  orderable via `before`: each `bnd_i` gets only `before:after(t_i, bnd_i)`
  and nothing links `bnd_a → bnd_b → bnd_c` to each other.
  Transitive-closing `before` does not fix it — the graph is divergent
  (`t_a → {bnd_a, t_b}`), not a linear chain through the bindings.
- fixing this requires redoing how `agg-binding` rules are constructed.
  we need the `agg-binding` to be localized at the result of the query,
  but we don't have pattern definitions that let us express this yet.

# new temporal relationships/removing totally ordered child requirement
plan: plans/temporal-relationships.md

- currently we assume each new node is inserted as a "last" child of its parent, and each node has a unique tree path from the root to itself by following these parent/child links
- we want to change the semantics to remove these restrictions:
  - after the change, it will be possible to assert `parent:child(x, y)` for any pair of nodes, although we expect this relation to be a valid partial order
  - we will keep the `children` array as an index optimization to efficiently iterate the child nodes of a parent,
    - but (!) the index ordering no longer connotes temporal order
    - instead, a new `before:after(x, y)` relation will hold atomic facts about temporal order
  - the logic for matching candidate nodes will mostly stay the same, but the implementation will differ.
  - first we introduce some new ideas about what the nodes represent

- This change will make more explicit several temporal relationships that are implicit in the code so far.
  In brief, each tree node represents an interval of time, and these intervals can be nested or sequential:
  - Example (1):
    ```
    + [A] a
      + [B] b
      + [C] c
    ```
    - this pattern creates three intervals. A contains B, and A contains C.
    - we interpret sequential `+` sibling nodes as being temporally sequential: so the interval B is before C
    - graphically, the result looks like `(A (B --) (C --) )`
    - a query like
      ```
      - [A] a
        - [C] c
        - [B] b
      ```
      - matches any `c` and `b` both contained within an `a` — two
        Match siblings impose no ordering constraint between
        themselves.
  - Overview of temporal relationships:
    - *containment*: A contains B if A=B or A is an immediate parent of C and C contains B (transitive reflexive closure of parent:child)
    - *before*: A is before B if there exist A',B' with `before:after(A',B')` and A' contains A and B' contains B
    - *prior*: A is prior to B if A is before B or B contains A
    - *overlap*: A and B overlap if there exists a C such that A contains C and B contains C
      - note that every interval contains itself, so overlaps itself, and if A contains B, then they overlap
  - We will introduce a new literal type, `,`, which matches so long as the given atom overlaps the parent anchor
    ```
    - [A] a
      , [C] c
      , [B] b
    ```
    this matches against example (1).

# relational storage
plan: plans/relational-storage.md

- currently we use a tree alongside a set of indexes to handle queries and hold state over time
- the structure of the tree is used for pattern matching:
  - the hierarchy is used to resolve `-a\n  -b` (b must match a descendent of a)
  - and `-a\n<b` (b must match a predecessor of a)
- idea: store reference tree relationally. each node is a tuple stored in a flat set.
  each parent relationship is an explicit fact `(parent:child A B)`
  each sibling relationship is also explicit `(before:after A B)`
- most of unify becomes database queries

# string interning
done

since each node has a unique parent, this is well-defined
`... root -> a ...  -->  ... root -> b -> a ...`

# semi-naive evaluation
plan: plans/seminaive.md

# further perf
plan: TODO

- pre-filter by children of node in case of `-a\n  -b` query (currently we only filter by `b` tuples)

# unification perf - index
plan: plans/unify-index.md

- most tree node atoms start with a sym
- while adding nodes, maintain an index on the side mapping a sym to all the tree nodes whose atoms start with that
  - e.g. if we `+[Id] foo bar`, we insert `(foo, ObjId)` where ObjId is the node
- We check `pat` inside `matchSubtree`, before line 207.
  If its first term is a sym, we use the index. otherwise we do a full scan as now.
- this is purely a performance optimization

# nice display for natural numbers

# display as ttt board
plan: plans/display-ttt.md

- a program might have program-specific display functions written in ts
- parse this from a comment block at the file top:

```
/ display: ttt.ts
```

## notes on ttt demo
display functions for the tic-tac-toe application written at `ts/data/ttt.sl`
- a `cell R C` should be a square at row R (vertical) and column C (horizontal) across page
- a `fill (cell R C) M` should show `x` or `o` (value of `M`) on top of the cell
- clicking a cell that is not filled should carry out what is currently done by clicking the most recent ask followed by clicking a tuple in the result pane

# hashcons for ids
plan: plans/hashcons.md

- new term type ref
- for each atom term occurring within a node being asserted to output tree, hashcons it
  - example: hashcons dictionary empty. output contains (id x y). this gets hashcon's to ref(1).
    output node contains only ref(1)
  - new tuple contains (id (id x y) z)
    first arguments are hashconzed, yielding ref(1) and sym(z)
    now tuple (sym(id) ref(1) sym(z)) is hashconsed to ref(2)

- invariant: atom term never refers to other atom terms (only refs)
  - thus: hashcons dictionary is not needed during unification.
    we know that unequal refs refer to distinct atoms, and when unifying a variable with a ref, we just bind it to the ref

# fringe
define the *fringe* of a value to be the set of all nodes in a tree whose atoms contain that value
```
  + root
    + card c
    + card:name c n
    + card c2
```
the fringe of `c` is `(card c) (card:name c n)`.

the union-fringe of a set of values is the union of their fringes;
the intersection-fringe of a set of values is the set of nodes that each refer to all the values.

TODO: use this for constraining choices

# query algorithm
Overview of tree unification types and algorithm

- a *term* is one of
  - Symbol(String)
  - Variable(String)
  - Atom(Atom)
- an *literal-type* is one of `match, assert, ask, constrain`
  - `match` is called *negative*
  - `assert, ask, constrain` called *positive*
- an *atom* is a vec of terms
- an *literal* is a literal-type and an atom
- a *tree* is (a "node" containing) an *id* term, a literal and an *ordered* list of child trees

unify-atom:
  two atoms unify if they unify in the usual sense (producing a substitution of variables to symbols)

unify-tree:
  takes a *pattern* tree and a *reference* tree
  a solution consists of
    - for each `N = Node(I,A,Ns)` in pattern, a Node `f(N) = Node(I',A',Ns')` in reference
    - a single substitution s that unifies each (I,I') and (A,A')
    - for each path from a node in pattern to the root of pattern, the corresponding reference nodes also lie on a path in reference, *in the same ancestor order*.
      that is, if A is an ancestor of B in pattern, then f(A) must be an ancestor of f(B) in reference. so `(foo (bar))` does not match `(bar (foo))`.

to compute unify-tree:
  - init empty substitution
  - traverse the nodes in pattern in any order
    - for each, enumerate candidates from reference, constrained by the path condition and the substitution so far
  - return set of all reference terms that unify

notes:
  - we are ignoring the atom-type for now. assume all atoms that show up have type match

## other literal types
### before
- plans/before.md

- add a new literal-type: `before`, denoted with the marker `<`
- this is a negative literal, like match.
  it behaves like match, except that it matches nodes that are *temporally before* (see ordering def below) its *previous sibling*, or its parent if it has no previous sibling
  ```
  + a
    + b
    + c
  ```
  the previous sibling of c is b

```
- turn A
  < move X
    + note A X
```
applied to reference tree
```
+ root
  + move a
  + move b
  + turn
```
yields

```
+ root r
  + move a
    + note r a
  + move b
    + note r b
  + turn
```

```
- a
  - c
  < b
  + ok
```
applied to
```
+ a
  + b
  + c
  + d
```

adds `ok` to the tree


# temporal semantics of reference trees
an ordering on nodes within a tree:
- if nodes A and B are siblings, and A is before B as a child, then A < B
- if C is a (nested) child of A, and A < B, then C < B.

```
- root
  - a
    - b
  - c
  - d
    - e
```

in this tree, the temporal ordering relation is the transitive closure of
  - a < c
  - b < c
  - c < d
  - c < e

## for substitutions
we define that a substitution `s` is before a node `n` if every id value in the range of `s` is before `n`

# Temporal semantics of aggregate nodes
see notes/aggregates.md

# tree syntax

## basic syntax
see `example.sl`
- the format is whitespace sensitive
- each line denotes a node. the first character determines atom-type:
  - = match
  + = assert
  ? = ask
  ! = constrain
- the rest of the line is the atom for that node. a lower-case token is a symbol, upper-case for variable
- indentation is the parent/child relationship. so
  ```
  - foo
    ! bar X
  ```
  should become `Tree(Atom(Match, [foo]), [Tree(Atom(Constrain, [bar, X]))])`
- a parenthesized expression is an atom term
  ```
  - foo (cons X Y)
    + bar X Y
  ```

## matching the node id
the following syntax allows a pattern to bind the node id explicitly:
```
-[Id] foo
  + bar Id
```
```
- [(id X)] foo
  + bar X
```

The syntax is `*[<term>]` where `*` stands for a literal type.

# evaluation
plan: plans/evaluation.md

## filling in `.id`
1) id-expand
  given: a pattern tree and a *name* string
  each tree node needs an id value, depending on literal type.
  these are filled in top to bottom (starting from the first line of the pattern and going down)
  - `match` node gets a fresh id variable (generate var string in some syntactic way)
  - each positive node (`assert,ask,constrain`) gets an atom term; the atom has the following form:
    `[sym("id"), sym(name), sym(line) ...previous_vars]`, where
      - `name` is the name passed to this function
      - `line` is a value that is unique per positive node within the rule (1,2,...)
      - `previous_vars` :=  the preceding id variables and the variables appearing within the earlier atoms
  - explanation:
    - todo

  e.g. if name = "r1"
    ```
    - f
      + g
        - h
          + i
    ```
    becomes
    ```
    - f X1
      + g (id r1 id1 X)
        - h X2
          + i (id r1 id2 X1 X2)
    ```

## step algorithm v2
1) expand
  given: a pattern
  - compute each prefix of the pattern that ends with a positive node
    e.g.
      ```
      - f
        - x X
        + g X
          - h
            + i X
      ```
      has two prefixes:
      ```
      - f
        - x X
        + g X
      ```
      ```
      - f
        - x X
        + g X
          - h
            + i X
      ```
      (note: this step applies after the id-expand step, but we omit those from examples)
  - for each prefix, replace each assert (+) marker with match (-) for the nodes before the head
    e.g.
      ```
      - f
        - x X
        + g X
      ```
      ```
      - f
        - x X
        - g X
          - h
            + i X
      ```
  - yield these rules

2) expandAll
  given: a set of (name, pattern) pairs
  apply `expand` to each, and take the set of results

# step algorithm
define literal-type match *negative*
define literal-type assert, ask, constrain *positive*

step(pattern, reference) // mutates ref
- compute unify-tree to get a set of substitutions
- for each substitution S:
  - generate a copy of reference
  - for each node N containing a positive literal L in pattern:
    - A := S applied to L.atom
    - I := S applied to N.id
    - P := the reference node whose id is S applied to parent(N).id
    - inserts node(I,A,[]) as a child of P in reference

# fixpoint algorithm

nilTree := a tree with one node, whose atom is empty
  (canonical root)

suppose a list of patterns and a reference tree R, initially nilTree
  changed = false
  do
    for P in patterns:
      changed = step(P, R)
  while changed

# editor GUI notes
- use standard text area actions so that any text insertion or keybinding action (see below) can be undone with ctrl+z

## linking source code with output
plan: plans/source-output-linking.md

when cursor is on a `+` line, highlight the set of corresponding assertions in the result.
- use the span info from the parser to determine the pattern node
- from the pattern node, get the id term
- from the id term structure, find the result nodes matching it

example: suppose pattern text is
```
- foo X       (line 1)
  + bar X     (line 2)
```
after idExpand with name "r1", the `+ bar X` node gets id `(id r1 id1 X1)`.
when this rule fires (say X=a), the result tree gets a node with id `(id r1 id1 a)`.
the prefix `(id r1 id1 ...)` is stable — it identifies the source pattern node.
so: parse the result node id, extract `r1` and `id1`, look up which source line produced that (line 2).

heuristics:
- try to scroll so that they are all in view. if they don't fit, scroll to the earliest ones
- apply css class to highlight their background

## terminology
define a line to be *weak* if it consists of optinoal whitespace, optional literal type marker (!/+/?/-), optional whitespace
rule text is *valid* if it parses and fixpoint runs to a result without exhausting gas

## keybindings
<tab>
  if everything before the cursor is whitespace: inserts two spaces
  if the current line is weak and has a type marker: inserts two spaces before the literal type marker
  if text is highlighted, insert two spaces at the start of each highlighted line
<shift-tab>
  if text is highlighted, remove two leading spaces from each highlighted line (if present)
  otherwise, if first two characters of line are whitespace, delete them
<return>
  if current line is weak, replace it entirely with a newline
  otherwise, insert newline, indent to level of previous line, insert copy of previous literal type marker followed by space
<ctrl-]> <ctrl-[>
  cycle to next or previous file available from server. only carried out if current editor contents are valid *and* synchronized with server
<ctrl-s>
  if attached(see below): force a save, even if invalid
  if detached(see below): save to new file
<ctrl-space>
  reset the file parameter, enter detached mode, and clear the editor
<+,-,!,?>
  if current line is weak, delete back until the current literal type is removed; add the typed literal type; then add a space
<ctrl-x>
  if text is selected, cut it (to the clipboard)
  if no text is selected, cut the current line
<ctrl-b> <ctrl-f>
  move cursor back or forward one character
<ctrl-a> <ctrl-e>
  move cursor to beginning or end of current line
<ctrl-p> <ctrl-n>
  move cursor to previous or next line, preserving column

# editor web server
plan: plans/editor-web-server.md
- serve (one or more) rule files.
- set of files stored in ts/data/ directory. any `.sl` file is available
- editor has a state, either *attached* or *detached*
  - in attached mode, the current editor is kept synchronized with a file on the server
    - synchronize whenever the current file content is *valid*
    - the file url parameter is set to the name of the file
  - in detached mode, editor is not synchronized. pressing <ctrl-s> saves to a fresh file on the server
    - the file url parameter can be anything. when <ctrl-s> is pressed, this is used as the filename. the server checks that this does not overwrite a file
      - if there is no url parameter or it is invalid, use current unix timestamp + `.sl` suffix as name
- when client initially loads, attempts to load file specified by url parameter. if it doesn't exist, open empty editor in detached mode

# gui interpretation of programs
plan: plans/gui-interpretation.md
now we implement handling of the `?` `Ask` literal type, which takes user input
- `?` nodes behave initially like `+` nodes
- in the result view, register click handlers for all nodes
- in response to <click> node N:
  - if N is a `?` node, remember it as the last `?` node clicked
  - if N is a `+` node and most recent `?` is M, then assert a tuple `click M N`, where M and N stand for the id's of the nodes
    - assert this new tuple by appending it to the list of input patterns

# beginning of document
- each new change appended to top
- some lines indicate date (so, changes at or after that date appear earlier in the doc)
  - started adding inline dates at 26/05/8.
- model: used sonnet 4.5 up until ~ 26/04/20, then switched to opus 4.7

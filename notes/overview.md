# CLI interface
plan: plans/v2-cli-interface.md

- add a script that provides CLI access to turn compilation/evaluation
- include a "stage" flag that determines what stage of output to produce (after parse, after various expand steps, final program, final evaluation with db output)
- accept input from stdin or file

# 26/06/9
installed typescript-lsp plugin
  not sure about this

# 26/06/8

# bottom up aggregates
status: beginning of sketch

suppose we have a relation `p` and a subset of `p` tuples `s`
call `s` complete for `t` if
  - all tuples in `s` contain `t` (temporally)
  - all tuples of `p` that contain `t` temporally are in `s`

here's a plan to eagerly compute aggregate relations (bottom up):
- whenever we insert `t` into `p`, get the complete subset for `t` (which always includes `t` itself) and compute the aggregate anchored at `t`

sum { X -> Y | p X Z, q Z Y }

sum { X -> Y | p X Z, count { -> N | r Z _ }, N > 0, q Z Y }


# better aggregates
plan: plans/v2-aggregate-comprehensions.md.
status: paused

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

authored by Claude Opus/Fable

# A short Turn tutorial

Notes from writing `ts/data/v2/pins.t` (Poison Pins), a minimal two-player
game. Everything here was checked against the v2 evaluator
(`node --import tsx src/v2-cli.ts <file>`); the gotchas are ones I actually
hit. `ts/data/v2/ttt.t` is the larger companion example.

## Tuples live on intervals

A Turn program derives tuples, and every tuple occupies an *interval* of
moments — a span with a start and end in a partial order, not a timestamp.
Episodes are tuples too: `setup` or `turn` is a tuple whose interval is the
episode's duration, and matching an episode in a rule body means overlapping
its interval.

The assertion sigils differ in how long (and to whom) the result is visible:

- `+fact` — persists from its emission to `top`: visible to every later moment.
- `^prop` — holds from a fresh moment just after the rule's current point to
  the end of the enclosing episode, and the rule continues from that moment.
  A `^` at the very top of a rule, before anything is matched, holds
  everywhere.
- `~sub` — launches a sub-episode (a new tuple with its own interval, which
  other rules can match and extend).

All three start their result at a *new* moment after the rule's current
point. So a reaction always comes after what it reacted to: whatever an
aggregate or a choice observed at a moment is final, and nothing a rule does
in response can change it retroactively.

### Continuing after something: `;`, `>p`, `~>p`

By default the rest of a rule body runs *inside* what it matched. Three forms
move it on to after something instead:

```
game, ~>setup, ~play        -- play starts after setup ends (both inside game)
game, >setup, ~cleanup      -- match an existing setup; cleanup comes after it
game, ~setup; ~play         -- `;`: after the whole preceding group ends
```

- `~>p` asserts the episode `p`, then continues after it ends (still inside
  the enclosing window).
- `>p` matches `p` and continues after it ends. `p` doesn't have to overlap
  the current window, only end before the window does, so `b, >a, ~c` works
  even when `a` finished before `b` began.
- `>` combines only with a plain match or `~`. A fact never ends, so
  `>fact, ~x` never fires.
- `p` has to end strictly before the window does. If they end together
  (typically a `^p` view of the same episode), "after `p`" is a single
  moment and the match fails; see "Joins need constructive overlap".
- `;` still works. It continues after the *earliest* end in the preceding
  group, which `>p` / `~>p` say more directly for a single atom.

## Rules

A rule is a sequence of atoms: matches, negation checks, and assertions,
separated by commas or newlines with indentation.

```
setup, n (s X), +n X
```

reads: while `setup` is active, for each `n (s X)`, assert `n X` persistently.
Terms are first-order: constructors like `(s z)`, `(cell R C)`, `(two Q R)`
nest freely, and matching destructures them.

**Rule boundaries follow the offside rule.** A line whose first character is
at column 0 starts a new rule; indented lines continue the enclosing one;
blank lines carry no meaning. So this is three rules:

```
setup, pin Q, +hits (one Q) Q
setup, adj Q R, +hits (two Q R) Q
setup, adj Q R, +hits (two Q R) R
```

and this is one rule (the blank line changes nothing):

```
pin Q, turn
  not fallen Q

  ^standing Q
```

A multi-line `( ... )` group may return to column 0 — the boundary is
ignored inside an open group. When output looks wrong, `v2-cli --stage
parse` shows the rule boundaries the parser actually saw.

## Data modeling: objects and attributes

The modeling idiom is entity–attribute: a *unary* predicate marks that an
object exists, and *binary* attribute predicates attach properties to it:

```
setup
  +card C
  +card:name C copper
  +card:kind C treasure
```

`C` here is a fresh object — the unary `card C` is its existence marker, and
each `card:name` / `card:cost` row is one property. The `:` is part of the
predicate name; the convention `namespace:attr` reads as "the attr of a
namespace-object" (and the parser uses the colon count to infer arity, so an
attribute head can be written with fewer arguments and padded with
wildcards).

The `.` dot sugar makes attribute access read like field paths — `a.b`
threads a fresh variable from the last argument of `a` into the first
argument of `b`:

```
draw.:card.card:name lucky-coin, ...
-- desugars to: draw D, :card D C, card:name C lucky-coin, ...
```

Episodes are objects too, so the same idiom applies to them. An episode
attribute is just a binary predicate whose first argument is the episode
tuple, emitted with `^` so it lives inside the parent:

```
game
  ~turn .^:actor me

turn.:actor P, ...    -- read it back: P = me
```

`~turn .^:actor me` launches the turn and attaches `:actor <turn> me` in one
breath (the leading-colon head `:actor` is an attribute with no namespace —
"the actor of"). ttt and pins use the unsugared spelling of the same idea
(`~turn ^actor a`, read back as `(actor P)`); dominion leans on the dotted
form for chains like `turn.actor.player:hand.^your-hand`.

A chain can also start from a variable you already hold. A lone variable on
the left of a dot is the value itself, not an atom to match, so
`A.card:name N` is `card:name A N`, and the marker on the right is whatever
you write: `A.^:actor me`, `A.~turn`, `A.(a:b B).(a:c C)`.

## Joins need constructive overlap

Each match in a rule body narrows an *anchor interval* — the running
intersection of everything matched so far — and the rule's emissions are
placed at a fresh moment constructed strictly inside it. That placement must
be *provable* in the moment partial order. Two tuples both persisting to `top`
still fail to join if their start moments are incomparable, because no moment
can be shown to lie inside both.

**A window that shrinks to a single point is a failed match.** Overlap has
to have width: if matching a tuple would leave the anchor interval as one
moment (the tuple only touches the window at an endpoint, or a `>p` lands
exactly where the window ends), that match fails, quietly, like a failed
unification. Nothing could be placed strictly inside a point anyway. The
usual way to hit this is a `^` view read back with `>` by a sibling rule:

```
explore-step N, ^exploring N
explore-step N, >exploring N, ~explore L     -- never fires
```

`^exploring N` ends where `explore-step N` ends, so "after `exploring N`,
inside `explore-step N`" is the single moment where both end. To act after
the view exists, give it room, e.g. a later sub-episode:
`explore-step N, ^exploring N, ~>do-explore N`, then
`do-explore N, …, ~explore L`.

This bites with sibling emissions. Here each `pin` comes from an independent
firing of one rule, so the pins sit on sibling branches of the moment order:

```
setup, n (s X), +pin (s X)

setup, pin A, pin B, +pair A B    -- only pair X X, never pair X Y!
```

The self-pairs fire (a tuple overlaps itself); the cross pairs silently
don't. Three ways out:

1. **Parenthesized matches.** `(atom)` matches without tightening the anchor
   interval, so no overlap between the siblings is needed:

   ```
   setup, (pin A), (pin B), +pair A B    -- full cross product
   ```

   This is why ttt writes `turn, (actor P), (turn-complete)` — it reads
   properties of the turn without anchoring inside their spans.

2. **Derive along a chain.** A recursive derivation from one base fact keeps
   every emission on a single chain, so all starts are comparable:

   ```
   setup
     +pin (s (s z))

   setup, pin (s X), +pin X          -- pin/pin joins now work
   ```

   This is why ttt's `n`-based joins (`setup, n R, n C, +cell R C`) work.

3. **Replace one side with an acc lookup** (see below) — `not fallen R` or
   `fallen R` is a point read at the anchor's start, not a tuple match, so it
   adds no interval constraint.

The same applies to views derived with `^`. Each `^` fact under an episode
starts at its own fresh moment inside it, and facts derived by different
rules are siblings. They are all alive together at the episode's end, which
is where to read them jointly (`( turn … );` — see Choices).

Experimental: with moment-lattice mode (`v2-cli --lattice`, `?lattice` in the
web URL), facts matched together always overlap — the window starts at the
join of their starts — so `pin A, pin B, +pair A B` gives the full cross
product. Episodes still need their order to be known.

## Aggregates and negation

Aggregation is `#acc` (below); there is no other. Negation is `not`, which
reads an `#acc` relation and succeeds when it has no matching row:

```
#acc fallen : pin
down Q / fallen Q

pin Q, turn, not fallen Q
  ^standing Q
```

`not fallen Q` succeeds while no `down Q` has happened by the start of the
turn. The read is a snapshot at the anchor's start: a pin knocked down during
a turn is seen by later turns, not by the turn that knocked it down. (ttt's
"has someone won" works the same way: `#acc winner : player`,
`won P _ / winner P`, `not winner _`.)

- Every variable of a `not` must already be bound (`_` is allowed and means
  "any value"); `not` binds nothing and does not move the anchor.
- `not` only reads `#acc` relations. To negate an ordinary relation, declare
  the boolean acc relation that states it, as `fallen` does for `down` — that
  relation is also what the timeline shows.
- Inside `!(...)` it reads at the choice's moment: `!(cell C, not filled C)`.
- In a `/` rule it may read only relations computed strictly before the
  head's own (no negation through recursion).

### Acc relations

An acc relation's rows are *computed* at each moment by their own kind of
rule, never asserted. Declare the relation with a type, one column per
argument, at most one of them an aggregation marked with `@`:

```
#acc damage    : e @sum
#acc at        : e (@last location)
#acc occupancy : location @count
#acc crowded   : location            -- no @ column: a boolean relation
```

Then write `body / head` rules. The body is ordinary matches (and `=`); the
head is one atom of the acc relation whose `@` column holds this rule's
contribution:

```
hit X A / damage X (@sum A)          -- the (@sum ...) wrapper is optional
move A B / at A B
at _ X / occupancy X ()              -- count takes no argument
occupancy X (s (s (s _))) / crowded X
```

At every moment the engine runs these rules against the tuples alive there
(and against other acc relations' rows at that moment — rules may chain, and
may recurse), folds each key's contributions with the declared op, and stores
the result as rows at that moment. An ordinary rule reads an acc relation
with a plain match — `check, crowded L, ^warn L` — and sees the value at the
*start* of its current anchor, once that moment has been reached. Reading
never narrows the anchor, and there is no `->`: the aggregated column is just
an argument position. Rules cannot `+`/`^`/`~` into an acc relation.

The ops, and what a key's rows look like:

| op | you write in the head | rows per key | recursion through it |
|---|---|---|---|
| `@sum` | a numeric symbol (`3`) | one, the total | not meaningful |
| `@count` | `()` | one, a Peano nat `(s (s z))` | not meaningful |
| `@min` | a Peano nat | one, the least | fine (shortest paths) |
| `@last` | any term | one per temporally latest contribution | fine |
| `@arg-min` | `(pair A N)`, `N` Peano | one `(pair A Nmin)` per `A` attaining the least `N` | fine |
| *(no `@`)* | nothing extra | the key is present or absent | fine (reachability) |

Two things follow from "computed at the moment". First, a key with no
contributions has no row, so `damage you D` simply does not fire for an
undamaged `you`; for negation use `not` on a boolean acc relation that states
the positive condition. Second, the rows at a moment are a snapshot
taken when the engine settles that moment: if a rule reads `crowded here`
at the start of `check` and asserts `+at extra here` in response, the extra
occupant counts from the next moment on, not retroactively at `check`'s
start.

Shortest paths, in this style:

```
#acc distance : location location @min
edge A B / distance A B (s z)
edge A B, distance B C L / distance A C (s L)
```

The recursion converges because `@min` only ever decreases. The same rule
shape with `@sum` or `@count` has no well-defined fixpoint; the engine does
not check, and reports an error if the computation fails to settle.

Recursive views belong here, not in `^` rules. A `^` recursion over cyclic
data (`turn, reach A B, edge B C, ^reach A C` over a cycle) never terminates —
every re-derivation is a new fact at a new moment — while the boolean acc
form computes the closure once per moment:

```
#acc reach : node node
edge A B / reach A B
edge A B, reach B C / reach A C
```

On the timeline an acc value is drawn as one square-cornered bar for as long
as it holds, in a band above the episodes: `at me here` ends where
`at me there` begins. A dashed right edge means the value was still holding
where the computation stopped (the end of time, or a pending choice). An
orange dot on a bar marks a moment where an ordinary rule read the relation.
Click a moment's dot for the full acc state at that moment, with what changed
from the moment before. The `acc` checkboxes above the timeline show or hide
a relation; relations that only other `/` rules read start hidden.

## Exceptions

A rule can intercept tuples that other rules emit while its context holds,
and replace them with something else:

```
bird X, ^flies X

peng X, { flies X => ^swims X }
```

`{p t1..tn => e}` reads: a `p` tuple matching `t1..tn` whose interval
overlaps this rule's context is not asserted; `e` runs in its place, on the
tuple's interval, with the `ti`
variables bound from the tuple. An empty right-hand side, `{ flies X => }`,
just suppresses the tuple. Variables already bound earlier in the rule (here
`X` from `peng X`) filter which tuples are intercepted, so `flies y` is
replaced for a penguin `y` while `flies x` for another bird `x` in the same
moment survives. Left-hand-side variables are local to the block; a `_`
matches anything. The block must close on the same line and may not contain
another exception. Tuples emitted outside the context, or not matching the
pattern, pass through unchanged.

## Choices

A choice point suspends evaluation and asks the harness for input:

```
game, other P Op
  ( turn, (actor P), not fallen (s z) );
  ?C
  !eligible C
  ( ~move C
    ^mover P );
  ~turn
  ^actor Op

move C, is C M, hits M Q, +down Q
```

- `?C` introduces the choice; `~move C` names it for other rules.
- `!eligible C` constrains the answer: the harness offers exactly the terms
  for which `eligible` holds *at the moment the choice was asked*. Eligibility
  is computed with ordinary rules (`turn, standing Q, ^eligible (one Q)`),
  and each such view starts at its own moment inside the turn — so the choice
  is asked at the turn's *end* (`( turn … );`), the one moment where all of
  them hold. Views derived earlier in the asking rule itself
  (`pick, ^opt x, ^opt y, ?C, !opt C`) or read from `#acc` relations are
  visible at an earlier ask too.
- The harness answers by appending an `is` row binding `C` to the chosen
  term; `is C M` then matches. The row holds from the moment the choice was
  asked, so reading it moves a rule to that moment: a rule anchored on
  something that ended before the ask cannot read the answer and act in the
  past.
- If the constraints admit **no options at all**, the choice resolves to
  nothing rather than blocking: no `is` row ever appears, `.is`-gated
  follow-ups never fire, and the program simply continues — the Ceptre
  "transition not applicable" case. (An ask with no `!` constraint anywhere
  is still an error.)

**A choice lives at one moment.** `?` and `!` do not move the rule along in
time (unlike `+` and `~`): a choice is asked at the moment its rule has
reached, and a `!` must sit at that same moment. So write the `!` next to its
`?`, before anything that moves the rule on — a `+`, a `~`, a `;`, or a
match that narrows the anchor. `?C, ~choice C, !eligible C` is reported as a
`late-constraint-error` naming the line; `?C, !eligible C, ~choice C` is the
fix. Another rule may add a constraint to the same choice, as long as it
reaches the same moment — read the choice with a parenthesized match, which
does not narrow the anchor:

```
turn, (choice C), !sturdy C
```

Choices are resolved in the order of their moments. Several `?`s at one
moment that share a `!` are one joint choice (`?W, ?To, !(valid-move W To)`
offers pairs). A `!` that mentions a choice asked *earlier* is not joint: the
earlier choice is made first, on its own constraints, and the later one is
then offered against its value:

```
a, ?X, !(opt X), +mark, ?Y, !(pair X Y)   -- X first; then Y, with X known
```

Every choice therefore needs a constraint of its own at its own moment; one
whose only `!` also mentions a later `?` is an empty-fringe error.

Acc relations may appear inside `!(...)` as plain patterns
(`!(at C here)`) or negated (`!(cell C, not filled C)`). The block sees the
state at the choice's moment from *before* the choice is made — and since a
choice's consequences start after its moment, a second choice asked at the
very same moment does not see the first one's effects at all; put it at a
later moment if it should.

`?X` requires `X` to be *fresh*: an ask accepts only one or more distinct
variables (`?A B` asks two at once), and asking an already-bound variable is
a compile error — an ask introduces choices, it never inspects values.

An ask may name the *actor* that resolves it: `?[you] C` (the human — the
default, so `?C` means the same) or `?[rng] C`. An `rng` choice never waits
for input: the scheduler picks one of the component's option tuples
uniformly at random and commits it. When `you` and `rng` variables are
entangled in one component, the `you` choices resolve first (one at a time);
the rng remainder then rolls over the options narrowed by them. The harness
persists each roll as an appended `is` row — same as a user choice — so an
outcome is rolled exactly once and never re-rolled on later runs or edits.

A program may seed the rng once at startup by asserting the `rng-seed`
relation with one numeric argument:

```
~game
  + rng-seed 42
  ...
```

The stream is latched at the first `rng` roll, so the seed must be
established before any rng choice (a top-level or setup fact). With a seed,
rolls are deterministic — the same program always plays out the same way.
Asserting `rng-seed` with two different values, or a non-numeric one, is an
error; a harness-provided random stream (e.g. a test passing
`options.random`) overrides the seed.

The evaluator's status tells you where things stand: `active-choices` means
it is waiting on input; `done` means fixpoint with nothing pending.
`src/tests/v2_ttt.test.ts` shows how to drive choices programmatically
(run fixpoint, pick an option, append the `is` row, re-run);
`src/tests/v2_choice_actor.test.ts` does the same for `rng` actors (pass a
seeded `random` in `runFixpoint`'s options and read `result.rngCommits`).

## Comparing numbers

Numbers are plain symbols (`3`, `-7`); the language has no arithmetic of its
own, but four comparison relations are built in and need no declaration:

```
lt A B    -- A < B
gt A B    -- A > B
le A B    -- A <= B
ge A B    -- A >= B
```

Both arguments must already be bound when the atom is reached — a
comparison tests values, it never enumerates them — and an unbound one is a
compile error naming the rule. A comparison is timeless: it does not narrow
the rule's anchor, so it slots in anywhere, including inside a `!(...)`
block to filter a choice's options:

```
(v X), gt X 3, ^big X

turn, ?N, !(num N, ge N 3)
```

Only numeric symbols compare; a name or a Peano nat is a runtime error. To
compare a `@count` (which is Peano), match its shape instead:
`occupancy X (s (s (s _)))`. The names `lt`/`gt`/`le`/`ge` are reserved —
a `#js-def`, `#js` or `#acc` of that name is rejected (and so is `not`). For
anything beyond comparison (adding, ranges), see the next section.

## Escaping to JavaScript

Two escape hatches. `#js` defines a term-level function, called with `@js(...)`
inside emit atoms:

```
#js (inc x) { return x + 1; }

n X, +m @js(inc X)
```

`#js-def` defines a *relation* backed by a JS generator, usable only as a
match atom. Parameters carry a mode: `+` means the argument is bound at the
call (the body receives it as a JS parameter), `-` means the body enumerates
it — each `yield` is an array of just the `-` arguments, in order:

```
#js-def range +Lo +Hi -I {
  for (let i = Lo; i < Hi; i++) {
    yield [i];
  }
}

range 0 8 I, range 0 8 J, ^cell I J
```

A relation may have several `#js-def` clauses with different mode vectors
(same arity); the compiler analyzes which arguments are bound at each call
site (left to right through the rule) and picks the earliest clause whose
modes fit. A `-` clause position happily accepts a bound argument — the
yielded value just has to match, so `range 0 8 X` with `X` already bound acts
as a membership test. Bodies must be pure functions of their arguments: a js
relation is timeless (it doesn't constrain the rule's anchor) and is
re-enumerated on every firing, so nondeterminism or side effects will
misbehave. Emitting into a js relation (`^range ...`) or negating one is a
compile error.

A js relation may also appear as a sub-atom of a `!(...)` constrain block,
where it enumerates or filters the option domain of a choice:

```
? N
!(range 1 10 N)
```

Inside `!(...)` clause selection is dynamic — an argument counts as `+` when
the component's other constraints determine it, regardless of where the js
sub is written in the block (js subs run after all store-backed sub-atoms).
Make sure some clause serves the modes your block can actually produce, or
the run fails with a mode error.

## Structuring a game

The pattern shared by ttt and pins (`ts/data/v2/pins.t`):

```
~ game
  ( ~setup );
  ( ~turn
    ^actor a )

-- views of the turn, derived with ^ inside it
turn, standing Q, ^eligible (one Q)

-- at the end of a turn its player moves; the next turn follows the move
game, other P Op
  ( turn, (actor P), not fallen (s z) );
  ?C
  !eligible C
  ( ~move C
    ^mover P );
  ~turn
  ^actor Op
```

`;` sequences: `( turn … );` continues at the turn's end, where the move is
chosen, and `( ~move C … );` continues after the move, where the opponent's
turn starts. The rule is the whole game loop. State is monotone — nothing is
retracted; "the pin fell" is a persistent `+down` fact, and "still standing"
is a per-turn view read through `not fallen Q`. Designing the state to be
add-only (plus per-episode derived views and acc relations) is the idiom that
makes everything above compose.

Removed forms, for readers of older programs: `#agg`, `#reactive`, weighted
reads and writes (`rel k -> V`), bracket aggregation `[ Q | op V ]` and
`#macro` all became `#acc` relations (with `not` for the `-> 0` negation
idiom); the parser reports each with a pointer here.

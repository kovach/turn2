# New semantics

Implement the language and evaluator described in
`notes/turn-program-1.t`. Run alongside the existing tree-based
project until v2 reaches feature parity, then cut over.

Spec: `notes/overview.md` §"new semantics" + `notes/turn-program-1.t`.

## Semantic summary

A rule is a flat sequence of *atoms* separated by newlines or `,`,
with parenthesised sub-rules and `--` line comments. Five atom
markers:

| marker | meaning                                                    |
|--------|------------------------------------------------------------|
| `-` (default) | match: tuples whose interval overlaps the anchor    |
| `~`    | assert with fresh `(l', r')` strictly inside the anchor    |
| `+`    | assert with fresh `l'` (in anchor) and `r' = top`          |
| `^`    | assert with interval *equal to* the current anchor         |
| `!`    | output tuple — no interval, separate sink, never matched   |

The DB stores both interval-bearing tuples and moment-ordering
facts (`m1 < m2`). Reserved sentinel moments `bot` / `top` are
strictly less / greater than every other moment.

**Match relation.** `(l1, r1)` matches `(l2, r2)` iff
`l1 <= r2 ∧ l2 <= r1` *and* the pairs `l1`/`l2` and `r1`/`r2` are
each comparable in the order relation (one direction or equality
is derivable). The comparability requirement is what makes the
relation defensible over a partial order.

**Anchor.** The eval context carries an interval `(l, r)`,
initially `(bot, top)`. After processing any interval-bearing
atom (negative *or* positive — match, `~`, `+`, `^`) with
interval `(al, ar)`, the anchor becomes `(max(al, l),
min(ar, r))`. Comparability of endpoints (required for matches;
constructed by asserts) makes max/min well-defined. `!`
output asserts have no interval and don't update the anchor.

Specifically:
- after `~`: anchor becomes the fresh `(l', r')` (strictly inside).
  As a consequence, sibling `~` atoms nest: `~a, ~b, ~c` produces
  three nested episodes, not three siblings in time.
- after `+`: anchor becomes `(l', r)` (left advances, right unchanged
  since `min(top, r) = r`).
- after `^`: anchor unchanged (interval == anchor).
- after a match: anchor intersects with the matched tuple's interval.

**Sub-rules.** `( ... )` pushes a copy of the anchor on entry,
pops on exit. Variable bindings do *not* pop — once bound,
in scope until the end of the enclosing rule (see `episode E,
( some-property E P ); + property-reference P` in the spec).

**Sequencing.** A sub-rule may close with `);` instead of `)`.
This pops the current anchor like `)`, but before resuming,
replaces the (now-top) outer anchor's *left* endpoint with the
*right* endpoint of the popped interval, and asserts the
corresponding moment-ordering fact. Effect: subsequent atoms
in the outer rule run after the sub-rule's interval. Worked
example from the spec:
```
foo
  ( ~ e1 );
  ~ e2
```
creates `e1` and `e2` as sub-episodes of `foo` with `e1_r < e2_l`
asserted, so `e1` precedes `e2` in interval order.

**Fresh moments.** Each `~`/`+` produces moment terms with a
lexical part (rule name + position + `l`/`r` role) and a dynamic
part (the variables bound so far). Hashconsed.

**Rule splitting.** As today's `expand`: a rule with a positive
followed by later atoms splits into a producer rule plus a
consumer rule. The consumer carries the literal moment terms of
the produced tuple (`[Id-left, Id-right]`) as match-side bindings
so it sees only the producer's output. See the `p1/p2/p3/p4`
example. Splitting applies to `~`/`+`/`^` only — `!` outputs
never need a split (nothing matches them) and weighted matches
behave like ordinary matches with extra fold work, not producer
boundaries. Each substitution produced by a rule's matches is
an *independent firing* with its own fresh moments (the dynamic
part of fresh-moment construction keys on the substitution).

**Interval order.** `(l, r)` is *before* `(l', r')` iff
`r <= l'`. This is a partial order over intervals, used by the
`last` aggregator.

**Tuple terminology.** A `~` tuple is an *episode*; a `+` tuple
is a *fact*; a `^` tuple is one or the other depending on the
anchor at creation; a `!` tuple is an *output* / *external*
tuple.

**Weighted atoms (aggregation).** An atom may end with
`-> <term>`. Schema declarations `% rel -> func` (with `func` ∈
`{sum, count, last}`) bind aggregators to relations file-wide.
A weighted *assertion* stores the weight as a trailing slot — no
aggregation logic fires. A weighted *query* gathers every stored
tuple whose head matches the pattern and whose interval
*contains* the current anchor (`(l, r)` contains `(l', r')` iff
`l <= l'` and `r' <= r`), folds the weights, and binds the
result. Candidates whose endpoints aren't comparable to the
anchor's are skipped (same convention as the match relation).
The anchor does *not* contract. Empty reductions: `sum -> 0`,
`count -> 0`, `last` fails (the rule firing is discarded).
`last` is multi-valued when the partial interval order has more
than one maximal candidate — each maximal element produces its
own firing.

## Pipeline

A new pipeline lives in `ts/src/v2/`:

- `parse.ts` — flat-syntax parser (`-`/`~`/`+`/`^`/`!`, comma- or
  newline-separated atoms, `( ... )` and `( ... );` sub-rules,
  `% rel -> func` decls, weighted-atom suffix `-> term`, `--`
  comments).
- `types.ts` — `Rule`, `RuleAtom` (with optional weight slot),
  `Tuple = (atom, l, r)`, `OutputTuple = atom`, `MomentOrder`
  row, `SchemaDecl: relation -> aggregator`. Moments reuse the
  hashconsed `Atom` algebra; no new term tag.
- `expand.ts` — produces split-rule derivatives, threading
  literal asserted moment terms into consumer matches.
  Cross-reference current `expand.ts` for the prefix logic.
- `store.ts` — relational store. Indexes: by atom-head sym, by
  `l` and by `r` for overlap candidate lookup, by literal moment
  terms for split-rule consumer matches, plus forward+reverse
  adjacency on the moment-order relation for transitive
  comparability.
- `eval.ts` — single-rule driver. State: anchor stack, flat
  substitution accumulating across the whole rule, schema table.
  Per atom:
  - **match** (`-`): enumerate candidates overlapping & comparable
    with the anchor; bind; intersect anchor.
  - **weighted match** (`rel -> N`): look up aggregator; gather
    candidates whose interval contains the anchor (non-strict);
    fold; bind weight var. Anchor unchanged. Missing schema decl
    → parse error. Empty: `sum`/`count` use zero, `last` fails.
  - **`~`/`+`/`^`**: build interval per marker, insert tuple +
    new ordering facts, update anchor.
  - **`!`**: insert into output sink. No interval, no anchor change.
  - **`( … )`**: push anchor, recurse, pop.
  - **`( … );`**: as `( … )`, but on pop replace the resumed
    anchor's left endpoint with the popped interval's right
    endpoint. Subsequent `~`/`+` atoms then construct their
    fresh-moment ordering facts against this modified anchor,
    which is what produces the `popped_r < next_l` fact in the
    store.
- `fixpoint.ts` — semi-naive outer loop, like today's.

## Reuse vs replace

**Reuse:** hashcons (`hashcons.ts`), aggregator folds
(`aggregators.ts` — only candidate gathering changes), editor /
web GUI (with a small adapter rendering intervals + an outputs
pane), parser plumbing for spans / interning.

**Subsumes:** `plans/flat-relational-ir.md`. That plan is a
different design point (flat constraint list with explicit
`IntervalRel` edges over the existing tree-walking evaluator);
v2's intervals-on-tuples + moment-order relation covers the same
ground without the dual-IR cost.

**Replace:** the `Tree` type and everything walking it
(`unify.ts`, `step.ts`, `tree.ts` structural helpers, edge tables
in `refstore.ts`, the synthetic `$root` row). Intervals on tuples
+ a moment-order relation subsume the parent/before/overlap edge
tables. Drop the `Id`-as-tuple-identity convention — a tuple's
identity is `(atom, l, r)`, and fresh-moment uniqueness gives that
for free. `Ask`/`Constrain` re-introduced only when the feature
re-lands (separate plan).

## Migration

1. Parser + types under `ts/src/v2/`. No wiring to existing code.
   Tests parse `notes/turn-program-1.t` and a few stripped examples.
2. Evaluator + store, validated on these golden programs in order:
   `play-card / it / move`; `foo, + bar`; the `activate` sub-rule
   example; the `episode E, ( some-property E P ); + property-
   reference P` scope example; the `foo ( ~ e1 ); ~ e2`
   sequencing example; the `% points -> sum` aggregation example.
   Test bar = expected tuples, moment-order facts, output tuples,
   aggregator bindings.
3. Port `ts/data/ttt.sl` to `ts/data/v2/ttt.sl` — parity check.
4. Editor adapter: file-path discriminator (`ts/data/v2/*` →
   v2). Result pane shows interval brackets + an outputs section.
5. Cut over: retire v1 evaluator files, promote `v2/` to
   top-level.

Stages 1–3 are non-invasive.

## Files

**New:** `ts/src/v2/{parse,types,expand,store,eval,fixpoint}.ts`,
`ts/src/tests/v2/*.test.ts`, `ts/data/v2/*.sl`.

**Touched:** `hashcons.ts` (reserved syms `bot`/`top` if they
need stable ids), `web.ts` / `server.ts` (file-path dispatch +
result-pane adapter; coexistence, not refactor).

## Open items

- **Static analysis for degenerate `);`.** A `);` after a
  sub-rule that didn't contract its anchor produces a degenerate
  resumed anchor `(r, r)`, against which any subsequent `~`
  fails (no strictly-inside room). OK as a runtime error for
  now, but add a static analysis pass to flag rules where this
  is statically guaranteed.

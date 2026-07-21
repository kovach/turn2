# v2 bracket aggregation: `[ Query | Reduction ]`

Source note: `# another take on aggregation` at the top of notes/overview.md.

A new aggregation expression that generalizes the current `#agg` / `p k.. -> W`
mechanism. Written `[ Q | op V ]`, it evaluates the conjunctive query `Q`
(restricted to tuples containing the active anchor), projects away `V`, and
folds the `V` values of each group with `op`, binding the result back to `V`.
One variable is reduced at a time; nesting reduces several.

```
[ invader X | count X ]                          -- one tuple: the invader count
[ it:at X L | last L ]                           -- one tuple per X: last L
monster X, [ it:at X L | last L ]                -- X bound by prefix, one L per firing
[ [ it:at X L, invader X | last L ] | count X ]  -- per L: count of invaders there
```

The existing `#agg`/`_do-agg`/`_agg-result` and `#reactive` mechanisms are left
untouched; this is a parallel, more general demand-driven path. (The old
single-atom form may later be re-expressed in terms of this one — out of scope.)

## Semantics (decisions)

- `[Q | op V]` occurs inside a rule at a point where the running anchor is
  `(XL, XR)`. `Q` is a plain join query — a comma-separated sequence of
  unmarked match atoms and nested `[...]` expressions, optionally chained
  with `.` dot notation (same desugaring as a rule body — the linking var is
  an ordinary free variable of `Q`; a `[...]` item may not sit on either side
  of a `.`). No temporal markers, no `->` weights, no `;`, no `=`, no
  `!`/`?`/`{...}` inside the brackets (parse errors).
- Every candidate tuple matched by an atom of `Q` must have an interval that
  **contains the anchor** `[XL, XR]` (`intervalContains`, exactly the
  restriction `aggregateOver` applies today).
- *Free variables of the expression*: variables occurring in `Q` (including
  inside nested comps) that are not bound earlier in the rule. Prefix-bound
  variables are parameters — their values are substituted into the query when
  the producer row is emitted (same trail mechanism `_constrain` rows use).
- The expression produces one binding row per group over
  `freeVars(Q) \ {V}`, with `V` bound to the reduction of the group's `V`
  values. All of `freeVars(Q)` (including `V`) become bound for the rest of
  the rule, exactly like variables bound by a match.
- Reduction ops (initially): `count V`, `sum V`, `last V`.
  - `count V`: ignores the `V` values; binds `V` to the group size.
  - `sum V`: folds the group's `V` values with the `sum` aggregator.
  - `last V`: selects the temporally last `V` per group. **Moment of a
    binding row** := the least upper bound of the left endpoints of all
    tuples that contributed to that row (for a single-atom `Q` this is the
    tuple's own left endpoint, matching the current `last`). Maximal rows are
    selected by comparing these moments on left endpoints, as `aggregateOver`
    does; incomparable maximal rows each produce a result (so `last` can
    yield several rows per group).
- Empty query result, mirroring `aggregateOver`'s current policy:
  - `last`: no result rows.
  - `count`/`sum` with a nonempty group key (`freeVars(Q) \ {V}` ≠ ∅): no rows.
  - `count`/`sum` with an empty group key: one zero row (`V` = aggregator zero).
- Restrictions on `V` (checked during decomposition, where the prefix-bound
  set is known):
  - `V` must occur in `Q`.
  - `V` must not be bound earlier in the rule.
  - `V` must be a named Variable (not `_`).
- Nested `[Qi | opi Vi]` items are evaluated recursively *inside* the
  enclosing close (see scheduler section) — the whole bracketed tree is one
  blocked unit closed atomically at its moment. All levels use the same
  anchor restriction. Inner free variables are shared with the outer scope by
  name: in `[ [ it:at X L | last L ] | count X ]`, the inner comp contributes
  binding rows over `(X, L)` which the outer query then consumes.

## Pipeline changes

### 1. parse.ts

- Tokenizer: at `atomStart`, `[` opens an aggregate-comprehension block. Scan
  to the matching `]`, tracking bracket depth, **continuing across line
  breaks** (the multi-line `#js` handling is the model for consuming
  subsequent lines from inside the tokenize loop: advance `li`, then resume
  the outer scan past the closing `]`). Per continuation line, apply
  `stripComment` before scanning; join the collected pieces with a single
  space (`|`, `,`, and parens are the only structure the mini-parser needs —
  original line breaks carry no meaning). Blank lines inside an open bracket
  are part of the block, never a `ruleEnd`. Unclosed at EOF: error
  "unterminated '['" at the opening line. Emit a new token
  `{ tag: "aggcomp", text, line }` (line = opening line, used for all
  errors from the mini-parser) with the brackets stripped. A stray `]` is an
  error. Add `[` and `]` to the atom-content scanner's top-level break set so
  `foo[...` errors comprehensibly rather than swallowing the bracket into a
  symbol.
- A recursive mini-parser for the block text (it never re-enters the main
  tokenizer):
  - Split on the single top-level `|` (not inside `(...)` or `[...]`). Zero
    or ≥2 top-level `|`s: parse error.
  - Left of `|`: comma-separated items; each item is either a nested
    `[ ... ]` (recurse) or an atom parsed with the existing term parser
    (`parseAtomText` or equivalent — compound `(...)` terms allowed). Run
    `saturateArity` on atoms as elsewhere. Reject markers, `->`, `;`,
    `=`, `{`.
  - Top-level `.`s split items too and survive as `dot` `BodyItem`s: the
    comp is a `{ kind: "aggcomp"; items: BodyItem[] }` pre-desugar item, and
    `desugarBody` recurses into `items` with the rule's shared
    `usedNames`/`counter` so `_dotN` names never collide. A comp neither
    receives nor advances a dot anchor (like `=`).
  - Right of `|`: exactly `op V` where `op` ∈ {count, sum, last} and `V` is a
    Variable token. Validate op name here.
- New pre-expand `RuleAtom` variant (types.ts):

  ```ts
  | {
      tag: "AggComp";
      // Items: plain match Atoms (marker "match", no weight) or nested AggComps.
      body: RuleAtom[];
      reduce: { op: string; varName: string };
      span: Span;
    }
  ```

- The token is accepted wherever an atom item is accepted in a rule body
  (top level, inside `(...)` subs, either side of `;`). Not allowed inside
  exception LHS; allowed in exception RHS bodies (it's just a body atom).

### 2. expand.ts — `decomposeAggComp`

Modeled directly on `decomposeAggregate` (producer Emit + consumer Match
sharing one inline `idTpl`), with a structured wrapped query instead of a
single freeified atom.

- Snapshot `prefixSeen = new Set(state.seen)`. Compute `freeVars` of the
  whole tree in first-occurrence order; validate the reduce-var restrictions
  above (throw a source-anchored error otherwise).
- Encode the query tree as a ground wrapped term (free variables become
  reserved marker atoms so the Emit's trail substitution leaves them alone,
  same motivation as `*var` in constrain rows):
  - comp := `(*cq (*cq-red <opSym> (*fv <vname>)) item1 ... itemN)`
  - atom item := `(*cq-atom t1 ... tk)` with each free Variable/Wildcard
    rewritten to `(*fv <name>)` (wildcards get fresh generated names — they
    are existential, contribute no group column; simplest: give each `_` a
    fresh `*fv` name and exclude generated names from `freeVars`).
  - nested comp item := its own `(*cq ...)` term, recursively.
  - Prefix-bound Variables stay as Variables; the trail substitutes their
    ground values when the producer row is interned at Emit time.
- Producer: `Emit (_do-aggc (*cq ...) idTpl) at (XL, XR)` where
  `idTpl = freshIdTemplate(state, k, "_emitId")`. `splitRule` slices on it
  like any Emit; exempt from the universal paired Match, exactly as the
  existing aggregate is (chain recovery comes from the consumer Match).
- Consumer: `Match (_agg-resultc (*row V1 ... Vm) idTpl) at (_l_k, _r_k)`
  where `V1..Vm` are the actual rule Variables of `freeVars` in canonical
  order — unification against the stored result row binds them (including
  the reduced `V`). Mint `_l_k`/`_r_k`, push to seen/chain/essential; add the
  freeVars to the chain via `collectVarsTerm`; new running anchor is
  `(_l_k, _r_k)` (equal to `(XL, XR)` by the close invariant, same as today).
- Reserve the new symbols alongside the existing reserved list:
  `_do-aggc`, `_agg-resultc`, `*cq`, `*cq-atom`, `*cq-red`, `*fv`, `*row`
  (parser must reject user atoms headed by them; add to the reserved check).
- `computeAggStrata` (scheduler.ts) and `applyExceptions`' traversals: extend
  the pre-expand walkers to descend into `AggComp.body`, treating every atom
  head inside as a read (marker-`"match"`-like). Grep for `tag === "Sub"`
  recursions over pre-expand bodies to find every walker that needs the new
  case (parse-side name resolution, exception prime-renaming — comp bodies
  only *read*, so prime-renaming of emitters never rewrites inside them, but
  the LHS-match renaming of `p` reads must).

### 3. New module `ts/src/v2/comp-aggregate.ts` — close logic

Keep the recursive query evaluator and close entry out of scheduler.ts (which
is already ~700 lines). Exports used by scheduler/fixpoint:

- `collectBlockedDoAggCs(store): BlockedDoAggC[]` — `_do-aggc` rows whose
  trailing id has no `_agg-resultc` row with the same id token (mirror
  `collectBlockedDoAggs`).
- `closeDoAggC(store, blocked, schema): boolean` —
  1. Decode the wrapped `(*cq ...)` term back into a query tree (expanding
     Atom-tagged Refs; `*fv` markers become query variables).
  2. Evaluate bottom-up: nested comps first, each producing a list of
     binding rows `{ subst: Map<name, token>; moment: Term }` over its free
     vars (moment = lub of contributor lefts, needed by `last` and by the
     enclosing level's own lub). A nested comp's row list then joins like a
     virtual relation at the outer level.
  3. Atom items enumerate `candidatesByHead` filtered by
     `intervalContains(t.l, t.r, l, r)` and match structurally: ground
     positions by hashcons token, `*fv` positions bind/check against the
     current substitution (a small token-level matcher, not the full trail
     unifier — same flavor as `matchFreePattern` but with a binding map).
     Plain backtracking join over items in order.
  4. Reduce: group rows by the tokens of `freeVars \ {V}`; fold with
     `getAggregator(op)` (`count` folds `zero`+1 per row ignoring `V`;
     `sum` folds `V` values; `last` selects maximal rows by moment as
     specified above). Apply the empty-input policy.
  5. Emit one `_agg-resultc (*row v1..vm) <copied id>` row per result at
     `[blocked.l, blocked.r]` with `addOrder(store, l, r)`, mirroring
     `emitAggResultRow` (hashcons the row terms; `addTuple` dedups).
  - `leastUpperBound` returning `null` (incomparable minimal upper bounds):
    throw with a message naming the expression's source span, like the
    reactive joinClosure error. This shouldn't occur while the moment order
    is a lattice.
- `sum`/`count` need no schema lookup (op is inline); `schema` is threaded
  only if we later allow user-declared ops — omit the param if unused.

### 4. scheduler.ts / fixpoint.ts wiring

- Add `{ kind: "aggc"; row: BlockedDoAggC }` to the `Blocked` union;
  `collectAllBlocked` includes `collectBlockedDoAggCs`. `l`/`r` on the row
  give `selectEarliestTier` its ordering for free.
- fixpoint.ts outer loop: alongside the existing `b.kind === "agg"` branch,
  close tier `aggc` rows via `closeDoAggC`; any successful close re-enters
  the inner loop, same as today.

### 5. Tests — `ts/src/tests/v2_bracket_agg.test.ts`

Drive through `runFixpoint` on small programs; assert on the store via the
debug renderers (`renderAtomDebug` from print.ts). Cases:

- Parse: token forms, nested brackets, top-level `|` splitting; errors —
  unterminated `[` at EOF, stray `]`, missing/duplicate `|`, unknown op, `_`
  as reduce var, marker/`->`/`.` inside brackets. Multi-line expressions:
  a bracket spanning several lines (incl. a blank line and a `--` comment
  inside the block) parses identically to its one-line form and does not end
  the rule.
- `sum` with grouping: the note's example
  `{p 2 4, p 1 1, p 1 3} → {(X:1,Y:4), (X:2,Y:4)}` via `[p X Y | sum Y]`.
- `count` with empty group key: `[ invader X | count X ]` → one row; also the
  zero-row case with no candidates.
- Prefix-bound parameter: `monster X, [ it:at X L | last L ]` — one firing
  per X, inner query filtered by the bound X.
- `last` with incomparable final moments → multiple rows (mirror the existing
  aggregate-`last` test shape).
- Nesting: `[ [ it:at X L, invader X | last L ] | count X ]` and its
  flattened-equivalent `[ invader X, [ it:at X L | last L ] | count X ]`
  produce identical results.
- Anchor restriction: a tuple outside the anchor interval doesn't contribute.
- Decompose error: reduce var bound earlier in the rule.
- The full draw-step example from the note as an integration case.

Run with `./run-tests.sh v2_bracket_agg` (sandbox: `node --import tsx`).

### 6. Docs

- New file `ts/src/v2/comp-aggregate.ts` ⇒ **update `ts/src/v2/overview.md`**
  with a section for it, and touch the parse/expand/scheduler/types sections'
  key-terms lists (new token, `AggComp`, reserved symbols, `Blocked` kind).
- Note the syntax in whatever living spec section covers aggregates when one
  exists.

## Out of scope (recorded for later)

- Weighted atoms or temporal markers inside `Q`; dot chains crossing a
  nested `[...]` boundary.
- A `bool` reduction op; user-defined reduction ops.
- Re-expressing the old single-atom `#agg` consumption form via this
  mechanism; `#reactive` interaction (a comp reading a `#reactive` relation
  reads `_aggval` rows like any other head — untested here).
- Stratification refinements: `computeAggStrata` only gains read edges; no
  new stratum kinds.

# v2 universal split

Generalize `splitRule` to slice at *every* Emit, not just `_do-agg`. The
aggregate paired-Emit-Match design becomes the universal shape: every
emitted tuple carries an idTpl term, every consumer-slice begins with a
Match keyed on that idTpl. Side effect: each rule decomposes into one
sub-rule per Emit, each containing a single Emit.

## Design

For every Emit produced by decompose (fact, episode, anchor, ask,
constrain, aggregate-producer), the emitted atom grows a trailing
**id slot** carrying `idTpl = freshIdTemplate(state, K, "_emitId")`.
Immediately after each Emit, decompose inserts a paired

```
Match (<sameAtomShape> <idTpl>) at (_l_K, _r_K)
```

— same idTpl term, same anchor handoff trick as today's
`_agg-result`. The Match unifies against the just-emitted tuple and
binds chain Variables via structural unification on idTpl.

`splitRule` then slices the rule at every Emit: producer is everything
up to and including the Emit; consumer is everything after (starting
with the paired Match). Recurses on the consumer.

```ts
function splitRule(rule: Rule): Rule[] {
  const eIdx = rule.body.findIndex(a => a.tag === "Emit");
  if (eIdx < 0) return [rule];
  const producer = { ...rule, body: rule.body.slice(0, eIdx + 1) };
  const consumer = { ...rule, body: rule.body.slice(eIdx + 1) };
  return [producer, ...splitRule(consumer)];
}
```

After splitting, prune rules whose body contains no Emit *and* no
AssertLt. These are observably empty: pure guards/matches with no
write to the store and no edge to the moment-order relation.

## Store schema impact

Every stored tuple gains an opaque trailing id term, displayed
analogously to endpoint moments (a third metadata column in
pretty-printers / viz / snapshots). Tuple shape becomes:

```
atom = (head ...userTerms <idTpl-ground>)
l, r = endpoint moments  (unchanged)
```

User-written Matches don't reference the id; decompose's `match` case
implicitly tacks a trailing `_` (Wildcard) onto the user atom so it
ignores the id slot. Aggregator schema lookups remain keyed on the
head Symbol — unaffected.

## Aggregate becomes a subsumed instance

The current `_do-agg` / `_agg-result` machinery is a hand-rolled
version of this pattern. Under universal split:

- The aggregate marker still lowers to a wrapped producer Emit and a
  consumer Match keyed by idTpl, because the consumer Match references
  the aggregate's *weighted* shape (`originalPatternWithWeight`) which
  differs from the producer's `_free`-wrapped shape. So the `_do-agg`
  / `_agg-result` symbol pair stays.
- But splitRule no longer needs a special `isDoAggEmit` predicate;
  it slices on `tag === "Emit"` uniformly. The producer's `_do-agg`
  Emit is just one of many Emits.
- `closeDoAgg` continues to translate `_do-agg` → `_agg-result` in the
  store. (The id slot on `_do-agg` carries through to `_agg-result`
  identically.)

## Per-pass changes

### `decomposeRule`

- New helper `wrapEmit(state, atom, l, r, lexPos)`:
  1. Build `idTpl = freshIdTemplate(state, lexPos, "_emitId")`.
  2. Emit `Emit (<atom-with-idTpl-appended>) at (l, r)`.
  3. Mint `_l_K`/`_r_K`; push to chain.
  4. Emit `Match (<sameAtomShape-with-idTpl> _l_K _r_K)`.
  5. Set running anchor to `(_l_K, _r_K)`.
- Apply `wrapEmit` from every marker case that produces an Emit
  (fact / episode / anchor / ask / constrain). **Aggregate is
  exempt**: its producer `_do-agg` Emit still gains an id slot for
  store-schema uniformity, but no universal paired Match is inserted —
  the existing `_agg-result` Match already supplies chain recovery via
  aggIdTpl. Conceptually wrapEmit's contract is "ensure a chain-
  recovery Match follows this Emit," and aggregate has already
  satisfied it.
- The `match` marker case appends a trailing Wildcard to the user
  atom, so `~ points X` becomes `Match (points X _) ...`.

### `splitRule`

The 5-line slice above. No `_do-agg` predicate — slices on
`tag === "Emit"` directly. Recurses.

### Post-split filter

After all splitting, `decomposed.flatMap(splitRule)` is followed by:

```ts
const kept = split.filter(r =>
  r.body.some(a => a.tag === "Emit" || a.tag === "AssertLt")
);
```

Rules with neither an Emit nor an AssertLt produce no observable
effect — drop them. Today this only triggers on the trailing slice
of a rule whose final Emit has post-Emit guards (Le / Min / Max
without effect); pure-Match tails get pruned.

### `generateDeltaVariants`

Each surviving rule has at most one Emit (always the last body atom).
The delta-variant pass simplifies: one Emit position to consider for
`positiveBeforeDelta`; `deltaSafeSkip` becomes uniform.

### Driver

```ts
export function expand(program: Program): Program {
  const decomposed = program.rules.map(decomposeRule);
  const split = decomposed.flatMap(splitRule);
  const kept = split.filter(hasObservableEffect);
  const variants = kept.flatMap(generateDeltaVariants);
  return { rules: variants, schema: program.schema };
}
```

### Storage / display

- Tuple printer: render the trailing id like endpoint moments — a
  fourth bracketed slot, e.g. `points 3 [m_1, m_2] {id_42}`.
- Snapshot fixtures regenerate (every tuple gains a slot).
- Viz: surface the id slot in tuple cells, or hide behind a toggle.
  Visually distinct from user terms.

## Invariant check

Filter is safe iff no AssertLt ever survives lexically past its
associated Emit into a trailing pure-guard slice. Today decompose
emits AssertLts as part of Emit scaffolding (immediately around the
Emit), so this holds by construction. Add a test that asserts no
post-split rule has `AssertLt` after the body's final Emit.

## Plan

1. **Storage display.** Update tuple/atom printers to render the
   trailing id slot like endpoints. Snapshot churn — regenerate.
2. **`wrapEmit` helper** in `expand.ts`. Apply to fact / episode /
   anchor / ask / constrain. Aggregate stays as-is initially (its
   custom paired Match remains; producer Emit just gains the id slot
   via `wrapEmit`).
3. **Match marker grows trailing wildcard.** Decompose's `match` case
   appends `{ tag: "Wildcard" }` to the user atom's terms.
4. **Generalize `splitRule`** to slice on `tag === "Emit"`.
5. **Post-split filter** in `expand` driver.
6. **Simplify `generateDeltaVariants`** for the at-most-one-Emit
   invariant.
7. **Tests**:
   - `v2_ttt` regression: `[9, 8, 7]`.
   - Snapshot a multi-Emit rule's split into N+1 sub-rules.
   - Confirm pure-guard trailing slice is filtered out.
   - Confirm no AssertLt ever lands in a filtered slice.
   - `profile-ttt-v2.ts`: counts likely shift (more rules, same
     emitted tuples). Update baseline.

## Future optimizations

- **Skip the id slot for emits with no consumer slice.** Today the
  trailing-emit common case still grows an id slot. Could lex-detect
  "this Emit has nothing after it in the same rule" and omit the
  wrapping. Saves storage but breaks uniformity — defer.
- **Chain minimization** (carried over from
  `v2-decompose-first-pipeline.md`): trim chain entries unreferenced
  by any post-Emit body. More valuable now that every Emit carries
  the chain via idTpl.

## Ambiguities / open questions

- **Anchor SSA recoverability.** Same as before: every Variable a
  consumer slice references must be in the chain. P1
  (`freshAnchorVar` pushes to chain) already covers this.
- **Aggregate `closeDoAgg` invariant.** `_agg-result` rows must
  preserve the producer's id slot so the consumer's universal Match
  binds correctly. `closeDoAgg` already copies `_do-agg`'s payload
  verbatim into `_agg-result`; no change needed if the id is part of
  the wrapped payload.
- **External ingestion.** If anything outside the rule pipeline
  inserts tuples (test fixtures, JSON load), they need a synthetic id
  slot. Use a sentinel like `_ext_id` or skip-id tuples that the
  reader treats as wildcards on the slot.
- **Equality of "the same fact" across firings.** Two rules that
  both `+ points 3` produce two tuples with distinct ids. Today they
  produce two tuples with distinct intervals (already not deduped by
  payload). No semantic regression; just confirms current behavior.
- **Display.** Pick id rendering early — affects all snapshot
  regen. Suggest `{id}` postfix or third bracketed slot.

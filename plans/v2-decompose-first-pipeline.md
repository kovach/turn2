# v2 decompose-first pipeline

Reorder expand so decomposition runs first; lower aggregates into a
paired emit + match in the unsplit body; let `splitRule` become a
literal body slice.

```
current:  splitRule → generateDeltaVariants → decomposeRule
new:      decomposeRule → splitRule → generateDeltaVariants
```

## Design

For an aggregate atom (`fills (cell R C) -> z`) at lexPos K, decompose
emits two IR atoms inline:

```
Emit  (_do-agg     <aggIdTpl> <wrappedFreePattern>)         at (XL, XR)
Match (_agg-result <aggIdTpl> <originalPatternWithWeight>)  at (_l_K, _r_K)
```

Both inline the *same* `aggIdTpl = freshIdTemplate(state, K, "_aggId")`
— a closed term over chain Variables, evaluated independently in
producer and consumer contexts to give the same ground value. No
shared `Equal`, no aggIdVar Variable threaded through the body.

`splitRule` is then a literal slice keyed off the `_do-agg` Emit:

```ts
function splitRule(rule: Rule): Rule[] {
  const pIdx = rule.body.findIndex(isDoAggEmit);
  if (pIdx < 0) return [rule];
  const producer = { ...rule, body: rule.body.slice(0, pIdx + 1) };
  const consumer = { ...rule, body: rule.body.slice(pIdx + 1) };
  return [producer, ...splitRule(consumer)];
}
```

## Two prerequisites

**(P1) Chain contains every bound Variable.** For the literal split
to work, every Variable any post-aggregate atom references must be
recoverable from the matched `_agg-result` row — either via the
aggIdTpl (chain Variables, bound by structural unification on the
Id) or via `originalPatternWithWeight` (vars introduced by the
aggregate atom itself).

Today the chain includes most things but excludes anchor SSA names
(`_xl_K`/`_xr_K`); these are referenced by Sub-closing
`Max XL_pre-sub inner.XR → XLseq` atoms after `sequence: true` Subs.
Fix: have `freshAnchorVar` (`expand.ts:310`) push the minted Variable
onto `state.chain` and `state.seen`. Single-line addition; the only
structural change to chain construction.

**(P2) Unifier descends into Id-tagged terms.** `notes/v2-design.md`
treats Id as opaque (token-equality). For the consumer's Match to
bind chain Variables inside aggIdTpl from the stored ground aggId,
unifyTerms must descend structurally when one side has unbound
Variables.

Update the unifier so it does as little unfolding as possible but
handles any pair:

| left          | right         | action                                       |
|---------------|---------------|----------------------------------------------|
| Ref a         | Ref b         | short-circuit on token equality (today)      |
| Ref a         | Id-with-vars  | unfold left one level, recurse               |
| Id-with-vars  | Ref b         | unfold right one level, recurse              |
| Id (a)        | Id (b)        | structural recurse on terms                  |

"Unfold one level" = replace the Ref with its hashconsed structure
for this step; keep children as Refs. Preserves ground-vs-ground
fast path; pays one hashtable lookup per opaque-vs-non-opaque
mismatch, only when binding is needed.

`matchFreePattern` (`scheduler.ts:309-310`) is a separate concern;
unaffected.

## Anchor scaffolding around the consumer Match

`closeDoAgg` writes `_agg-result.l/r = _do-agg.l/r` (`scheduler.ts:299`),
which equals the producer's `(XL, XR)` from the prefix anchor. So the
Le/Max/Min that `decomposeMatch` would normally emit around the
consumer's `_agg-result` Match are no-ops by invariant. Decompose's
aggregate case omits them and declares the post-aggregate running
anchor to be `(_l_K, _r_K)` directly.

## Per-pass changes

### Parser

Recognise `atom -> weight` as a new `aggregate` marker. Drop the
`weight` field from `match` Atoms; only `aggregate` carries it.

### `decomposeRule`

- Modify `freshAnchorVar` to push onto chain (P1).
- Add an `aggregate` case to `decomposeEmit`'s marker switch:
  1. Snapshot `state.seen` as `prefixSeen` before walking the user
     pattern.
  2. Build `wrappedFreePattern` by replacing Variables not in
     `prefixSeen` and Wildcards with `_free` (today's `freeify`,
     lifted from `splitRule`).
  3. Build `originalPatternWithWeight = a.atom.terms ++ [a.weight]`,
     running `emitBindingsAndRewrite` over user atoms first.
  4. Build `aggIdTpl = freshIdTemplate(state, K, "_aggId")` — inline,
     no Variable binding.
  5. Emit `Emit (_do-agg aggIdTpl wrappedFreePattern) at (XL, XR)`.
  6. Mint `_l_K`/`_r_K`; push to chain.
  7. Emit `Match (_agg-result aggIdTpl originalPatternWithWeight) at
     (_l_K, _r_K)`. No Le/Max/Min scaffolding.
  8. Set running anchor to `(_l_K, _r_K)`; push user vars from
     `originalPatternWithWeight` onto chain.

### `splitRule`

The 5-line slice above. Drops `WMPath`, `atPath`,
`buildProducerBody`, `buildConsumerBody`,
`collectBoundVarsBeforePath`, `freeify`.

### `generateDeltaVariants`

Walks flat IR, tags `Match.constraint` directly. `tagBody`,
`countMatches`, `findDeltaAtom`, `positiveBeforeDelta` lose their
Sub-recursive branches. `positiveBeforeDelta` treats `Emit` as
positive, skips guards.

### Driver

```ts
export function expand(program: Program): Program {
  const decomposed = program.rules.map(decomposeRule);
  const split = decomposed.flatMap(splitRule);
  const variants = split.flatMap(generateDeltaVariants);
  return { rules: variants, schema: program.schema };
}
```

## Plan

1. **Unifier (P2)**: update `unifyTerms` in `unify.ts` per the table
   above. Land first — the rest of the refactor depends on it.
2. **Anchor SSA in chain (P1)**: modify `freshAnchorVar` to push
   onto chain. Identity churn — regenerate fixture snapshots.
3. **Parser**: add `aggregate` marker, drop `weight` from `match`.
4. **Decompose `aggregate` case** (steps 1–8 above). Lift `freeify`.
5. **Rewrite `splitRule`** to the 5-line slice.
6. **Adjust `generateDeltaVariants`** for flat IR.
7. **Update the `expand` driver** to the new order.
8. **Remove dead code**: splitRule helpers; Sub-recursive branches
   in delta-variant helpers; the `case "Atom": case "Sub":` arm in
   `evalSeq` (`eval.ts:72-74`) becomes a strict error.
9. **Tests**:
   - `v2_ttt` regression: still produces `[9, 8, 7]`.
   - Snapshot post-expand IR for a weighted-match fixture.
   - Add a fixture with `sequence: true` Sub spanning an aggregate
     to exercise P1 (consumer evaluates with no prefix).
   - `profile-ttt-v2.ts`: identical firing counts.

## Future optimization: chain minimization

Many chain entries are deterministic functions of earlier entries
and add no fingerprinting power; embedding them bloats every
template. A later pass can drop chain entries that aren't referenced
by any post-aggregate atom (or whose references can be redirected
to their inputs). Deferred — the literal-split design is correct
without it; this is purely about template size.

`plans/v2-consumer-prefix-elision.md` is subsumed: the literal split
*is* full prefix elision. Mark superseded.

## Ambiguities / open questions

- **Identity stability.** P1 and the new aggregate IR both change
  template content. Interned tuple ids shift; regenerate snapshots.
  Internal invariants (no firing collisions; producer aggId matches
  consumer template under structural unification) must hold —
  satisfied by construction.
- **Sub interactions.** `sequence: true` Subs containing the
  aggregate produce the post-aggregate `Max XL_pre-sub …` references
  that motivated P1. Add a dedicated test fixture.
- **lLit/rLit on aggregate atoms.** If the parser permits them, attach
  them to the consumer-side `Match (_agg-result …)` (binding `_l_K`/
  `_r_K` after the Match), same as `decomposeMatch`. Producer Emit
  doesn't use them.
- **Multiple aggregates per rule.** splitRule recurses; each aggIdTpl
  is distinct by lexPos. No interaction.
- **Recognising the producer Emit.** Head Symbol `_do-agg` is
  reserved. If we ever needed disambiguation, add a `kind:
  "aggregate"` flag to Emit.
- **Marker name bikeshed.** `aggregate`.
- **Template size.** Without chain minimization, templates grow
  linearly with prefix length. Deferred-optimization lever above.

## Design history

Earlier drafts of this plan went through several iterations. Tracking
the simplifications, smallest to largest:

1. **Aggregate marker, not weighted match.** Started by recognising
   that the surface `pat -> weight` is morally an *assert*, not a
   weighted match. Moving it into its own marker lets decompose own
   the lowering instead of `splitRule`.

2. **Inline the aggIdTpl, drop the shared `Equal`.** A draft had
   decompose emit `Equal aggIdVar = freshIdTemplate(...)` upstream
   as a shared atom kept in both producer and consumer bodies. Since
   no atom outside the producer Emit and consumer Match references
   `aggIdVar`, the binding adds nothing — inline the closed
   freshIdTemplate term directly into both atoms. Both substitute to
   the same ground value at runtime.

3. **`splitRule` becomes ordering-based.** Without the shared
   `Equal`, there's no need to tag atoms producer/consumer/shared.
   The producer's `_do-agg` Emit has a reserved head Symbol;
   splitRule finds it and slices.

4. **Drop `_do-agg` Match in the consumer.** `closeDoAgg` is 1:1
   between `_do-agg` and `_agg-result`, so the consumer's `_do-agg`
   match adds no filtering. One Match (`_agg-result`) suffices.

5. **Elide consumer-Match scaffolding.** The Le/Max/Min around the
   consumer's `_agg-result` Match are no-ops by closeDoAgg's
   interval invariant. Drop them; set the running anchor to
   `(_l_K, _r_K)` directly.

6. **Literal split (consumer = body slice after `_do-agg`).** False
   start: claimed the consumer didn't need the prefix at all because
   the aggIdTpl encodes every chain Variable. The Sub case shows
   this fails as stated — `sequence: true` Subs emit post-aggregate
   `Max XL_pre-sub …` atoms whose anchor SSA references aren't in
   the chain.

7. **Anchor SSA in chain (P1).** Walked back the in-progress
   chain-minimization idea (B). For the literal split to be sound
   universally, the chain must contain every Variable any
   post-aggregate atom references — which today excludes only
   anchor SSA. One-line fix in `freshAnchorVar`. Chain minimization
   moves to a future optimization.

8. **Id-unification check (P2).** Confirmed obstacle: the consumer's
   structural unification of `aggIdTpl` (Id-with-vars) against the
   stored ground aggId Ref must bind chain Variables. Inspection of
   `unify.ts` showed the existing Atom/Id-vs-Ref path already does
   one-level unfolding and structural recurse. No code change
   needed.

The end result: `splitRule` is a 5-line slice on post-expand IR;
decompose owns the entire aggregate lowering; the
consumer-prefix-elision plan is fully subsumed.

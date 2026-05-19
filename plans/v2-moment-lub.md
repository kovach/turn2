# Moment least upper bound

## Goal

A store utility `leastUpperBound(store, moments: Term[]): Term | null` that
returns the unique minimal upper bound of a finite set of moments under the
v2 moment partial order, or `null` when the join doesn't exist uniquely
(empty intersection, or two-or-more incomparable minimal upper bounds).

## Why

Several upcoming features need to know "the earliest moment after all of
these" — see `# temporal issues around choices and constraints` in
`notes/overview.md`. Examples:
- determining whether a set of constraints converges to a single anchor;
- the "default display" question of *when* a term is the unique remaining
  choice (constraints existing at different moments — see the 26/05/11 note
  in overview);
- future anchor-narrowing logic that currently uses pairwise `Max`/`Min`.

## Algorithm

### Key observation

For any set `S`, the upper-set `U = ⋂↑s` is *upward-closed* under the
partial order: if `x ∈ U` and `x ≤ y`, then `y ∈ U`. Therefore

> `m ∈ U` is minimal ⇔ no immediate predecessor of `m` (in the asserted
> edge graph) is in `U`.

This collapses minimality checking from O(|U|² · BFS) to a single edge
sweep.

### Binary primitive `lubPair(a, b)`

```
1. Fast paths: a == b → a; a ≤ b → b; b ≤ a → a.
2. Compute upper-sets ua = ↑a, ub = ↑b (cached forward-closure in eager
   mode; BFS through orderFwd otherwise; always include `top`).
3. U = ua ∩ ub (iterate the smaller into the larger).
4. notMin = { successors of m in U | m ∈ U } ∪ ({top} if |U| > 1).
   The `top` special case is needed because the moment graph stores no
   edges into `top`, but `top` is universally above every other moment.
5. Survivors of U \ notMin = minimal elements. Return the unique one or
   `null`.
```

### n-ary via fold

`leastUpperBound([m_0, m_1, ..., m_k]) = lubPair(lubPair(... lubPair(m_0,
m_1), m_2) ..., m_k)`. Empty → `bot`; singleton → itself.

Sound in any poset where every intermediate binary join exists; in the
moment poset that's always true because `top` is above every moment, so
some intersection is non-empty.

## Implementation notes

- Lives in `ts/src/v2/store.ts` alongside `lessThan` / `lessEq` /
  `comparable` / `intervalsOverlap`.
- Exports a public `leastUpperBound(store: Store, moments: Term[]): Term |
  null`. The binary helper `lubPair` and the upper-set BFS stay private.
- Needs a token → Term recovery for moments not in the input set (the LUB
  can be a common descendant outside `S`). Approach: add a small
  `momentTerms: Map<number, Term>` populated in `addOrder`, `addTuple`
  (endpoints), and `createStore` (bot/top). Negligible cost; symmetric
  with how `byHead` is maintained.
- Reuses the existing `lessThanTok` memo paths (`ltPos` / `ltNeg`) for the
  fast-path comparability checks.

## Tests

- empty → bot; singleton → itself.
- comparable pair: `a < b` returns `b`; `b < a` returns `a`; equal returns
  the term.
- two incomparable moments with a single common descendant → that
  descendant.
- two incomparable moments with no common descendant other than `top` →
  `top`.
- two incomparable moments with two incomparable common descendants →
  `null`.
- triple via fold: `{a, b, c}` where the pairwise joins compose to a single
  moment.
- triple where two incomparable upper bounds appear only after combining
  three → `null` (current fold gives this answer; documents the
  limitation).

## Next steps

Once the primitive is in place:
1. Audit `expand.ts`'s pairwise `Max`/`Min` anchor narrowing — `Max` over
   a set of moments could just be `leastUpperBound`; potential
   simplification or at least a clearer mental model.
2. Use it in the "default display" pipeline to decide when a choice has
   exactly one option *at a given moment*.
3. Provide the dual `greatestLowerBound` (Min/meet) for symmetry — same
   algorithm with directions flipped, sharing the asserted-edge graph
   inverted via `orderBwd`. Add only when a caller needs it.
4. Profile: if `lubPair`'s closure walk shows up in hot paths, switch the
   store to the eager `ORDER_STRATEGY` (already a single-line flip) so
   `gt` provides O(1) upper-set lookups.

## Out of scope

- Caching `lubPair` results across calls. The fast paths already catch
  the comparable case, which dominates real queries; a memo would just
  duplicate `ltPos`/`ltNeg` and bloat the store.
- Synchronized-BFS short-circuit for the binary case. Worth revisiting
  only after profiling shows the closure walk is a bottleneck.
- A distinguished "ambiguous" vs "no join" return shape. Callers today
  treat both the same way; revisit if a use site needs to enumerate
  competing minimal upper bounds.

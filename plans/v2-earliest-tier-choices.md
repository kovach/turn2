# Earliest-tier choice components

## Goal

When the v2 scheduler dispatches a `choice` tier, surface only the components
reachable from the earliest-tier choose rows, instead of returning components
built over every blocked choose at once. Later-tier chooses stay blocked and
re-surface on a subsequent fixpoint round.

## Background

Today `fixpoint.ts` calls `computeComponents(store, collectBlockedChooses(store), schema)`
(ts/src/v2/fixpoint.ts:85). The `prior` partial order is only consulted to
decide whether the earliest tier is "all aggs" or "all choices"; once it's
choices' turn, the entire blocked-choose set is handed to the constraint-query
module and every component over the full active-term graph is returned to the
host.

`computeComponents` (ts/src/v2/constraint-query.ts:338) builds `activeSet` from
those chooses, gathers `_constrain` + `_constrain-agg` rows touching it,
forms components via BFS over the bipartite (active-term ↔ constrain-row)
graph, and runs each component's conjunctive query.

## Tension: entanglement

If we naively restrict `activeSet` to earliest-tier chooses, any constrain
row (plain or agg) that mentions both an early-tier active term and a
later-tier one will treat the later term as a ground value — `matchTerm`
falls through to token-equality and almost never matches. We need a closure
rule: when a constrain row links an early-tier active term to a later-tier
one, pull that later choose into the surfaced batch.

## Plan

1. **Thread the tier through to component computation.**
   In `ts/src/v2/fixpoint.ts:85`, instead of passing the full
   `collectBlockedChooses(store)` list, derive the earliest-tier chooses from
   the `tier` already computed at line 62:
   ```ts
   const seedChooses = tier.flatMap(b => b.kind === "choose" ? [b.row] : []);
   ```
   Pass `seedChooses` plus the full blocked set into `computeComponents` as
   distinct arguments. The full set is still needed so the closure step
   (below) can pull in entangled later-tier chooses.

2. **Two-phase activeSet in `computeComponents`**
   (ts/src/v2/constraint-query.ts:338). New signature roughly:
   ```ts
   computeComponents(store, seedChooses, allChooses, schema)
   ```
   - Phase A: build `activeSet` and `termByTok` from `seedChooses` only.
   - Phase B: scan both `_constrain` and `_constrain-agg` rows. For each
     row whose `activeTokensIn(wrapped, store, allActiveSet)` includes at
     least one seed token and at least one non-seed token, add every
     non-seed active term from the touched choose(s) into `activeSet` /
     `termByTok`. Iterate to fixpoint over the bipartite graph (chooses ↔
     constrain rows including agg).
   - Closure must treat `_constrain` and `_constrain-agg` symmetrically —
     both kinds of rows can entangle chooses.

3. **Reuse the closed set downstream.**
   `gatherConstrainRows`, `buildComponents`, and `runComponent` already key
   off `activeSet`; once it's correctly populated by step 2, no further
   changes are needed. `runAggRow` already rewrites active-token positions
   to `_free`, so pulled-in active terms are handled uniformly.

4. **Return value & host contract.**
   `active-choices` reports `choices` as the closure (seed + transitively
   pulled), not all blocked chooses. The host only resolves these; remaining
   later-tier chooses re-surface on the next fixpoint round.

5. **Empty-fringe check.**
   Stays in `computeComponents` but runs over the closed `activeSet`, so the
   error is correctly attributed to a choose in the surfaced batch.

## Implementation locations

- `ts/src/v2/fixpoint.ts:85` — pass seed (tier-derived) and full blocked sets.
- `ts/src/v2/constraint-query.ts:338` (`computeComponents`) +
  `gatherChoiceContext` (line 42) — new two-phase population and closure
  loop. Signature change.
- `ts/src/v2/scheduler.ts` — no change; reuse `selectEarliestTier` filtered
  to `kind === "choose"`.

## Test coverage to add

- **Independent earlier/later.** Two chooses at different `l`, no shared
  constrain row: only the earlier one surfaces; the later remains blocked.
- **Shared constrain row.** Two chooses sharing a `_constrain` row: both
  surface together regardless of `l` ordering (entanglement via plain).
- **Shared constrain-agg row.** Same as above but the entangling row is
  `_constrain-agg`: both surface (entanglement via agg).
- **Mixed.** Three chooses where early + late are entangled and a third
  late one is independent — early-tier pair surfaces, third stays blocked
  for the next round.
- **Multi-step closure.** A → constrain → B → constrain-agg → C, with only
  A in the earliest tier; all three surface.

## Open questions

- If a stricter model is preferred — error or assert when an early-tier
  component touches a later-tier active term, rather than auto-pulling —
  that's a one-line swap in step 2.

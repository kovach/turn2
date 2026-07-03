# v2 stratification analysis (time-marked dependency graph)

This plan designs the static analysis that orders **reactive-aggregate
finalization within a single moment**, and characterizes which recursive
programs are temporally well-formed. It refines the ad-hoc "aggregate
dependency strata" sketch in
[plans/v2-reactive-aggregates.md](v2-reactive-aggregates.md) (the *single-moment
stratification* section) and supersedes the unmarked, same-rule edge analysis
currently in `scheduler.ts:computeAggStrata`.

The seed (notes/overview.md, `# stratification analysis`):

```
- for each `a, ..., ~b` add an edge from `a` to `b` marked `<`
- for each `a, ..., +b` add an edge from `a` to `b` marked `<`
- for each `a, ..., ^b` add an edge from `a` to `b` marked `=`
- same for aggregation atoms
```

## The problem this solves

A reactive aggregate's value at a moment must be **final** before any consumer
folds it (otherwise the consumer reads a half-built value, and at a *single*
moment the half-built values all share one left endpoint, so `last`-read can't
disambiguate them — see the reactive-aggregates plan). The scheduler orders
finalization lexicographically by **(moment, stratum)**. Moment is the primary
key; this analysis computes the **stratum** — the secondary, within-moment key.

The central observation, and the reason a careful analysis is needed:

> **Time already stratifies most dependencies. The within-moment stratum is
> needed only for dependencies that can occur *at the same moment*.**

A dependency `a → b` is *same-moment* exactly when `b` is produced at the
**anchor** (`^b`), i.e. without minting a fresh moment. When `b` is produced by
`+b`/`~b` (a fresh `l`, strictly above the anchor), `b` lands at a strictly
later moment than its inputs, and the moment-primary scheduler handles it with
no stratum constraint at all.

## The time-marked dependency graph

Nodes are **relation symbols** (all of them — reactive, `#agg`, and plain — so
dependencies can chain through intermediate plain relations; see "Transitivity"
below). For each rule, link every **read** head to every **produced** head (a
rule body is a conjunction, so every read gates every produce), marking the edge
by *how the produced atom places its moment relative to the anchor*:

| produced atom | marker (pre-expand) | mints a fresh moment? | edge mark |
|---------------|---------------------|-----------------------|-----------|
| `^b` (anchor) | `anchor`            | no — `b` at the anchor | **`=`**  |
| `+b` (fact)   | `fact`              | yes — fresh `l`, `r=⊤` | **`<`**  |
| `~b` (episode)| `episode`           | yes — fresh `l`, `r`   | **`<`**  |
| `?b` (ask)    | `ask`               | yes — like fact        | **`<`**  |

Reads are body atoms with marker `match` (plain) or `aggregate` (a reactive /
`#agg` value read `b -> X`). **Aggregation atoms are not special**: a reactive
read `b -> X` is a read (an edge *source*, like a match); a weighted
contribution `^b … -> w` / `+b … -> w` is a produce whose mark is set by its
`^`/`+`/`~` marker, exactly as above. This is the "same for aggregation atoms"
line of the seed.

Why `=` for `^` is the conservative-correct choice: `^b`'s left endpoint is the
anchor = the overlap (max of left endpoints) of all the rule's reads, so `b`
coincides with the *latest* read. Marking the edge `=` says "`b` *may* share a
moment with `a`," which is sound for any read `a` (it is exact when `a` is the
binding/latest read, conservative otherwise).

> **This analysis is a heuristic over-approximation, not an exact one.** The
> `=` mark records that `^c` *can* coincide with a read, never that it *must*.
> In `a, b, ^c`, the anchor is `max(a_l, b_l)`, so `^c` coincides with `a` only
> when `a` is the latest read; if at runtime `b` *always* starts strictly after
> `a`, then `c` is strictly after `a` and the true edge is `a <→ c` (time-
> separated, no stratum constraint) even though we mark it `a =→ c`. The
> over-approximation only ever *adds* within-moment ordering, so it stays sound
> — but it can serialize, or flag as a same-moment `=`-cycle, a program that is
> actually temporally stratified. Tightening the mark to `<` when a read is
> provably strictly-prior to the anchor is a later refinement (open question 2).

### Same-moment dependency = an all-`=` path

`b` can depend on `a` *at one moment* iff there is a path `a → … → b` whose
edges are **all `=`**. Any single `<` edge on the path puts `b` at a strictly
later moment than `a`, so the dependency is time-separated, not same-moment.

So define the **`=`-subgraph**: the dependency graph keeping only `=` edges.
Same-moment dependency is reachability in the `=`-subgraph.

### Transitivity through plain relations

The chain can pass through non-reactive relations, which is why nodes are *all*
relations, not just reactive ones:

```
p X Y -> 1, ^c X Y      # read reactive p, produce plain c via ^   → p =→ c
c X Y, ^q -> 1          # read plain c,    contribute reactive q   → c =→ q
```

The all-`=` path `p =→ c =→ q` means `q` same-moment-depends on `p` even though
no single rule mentions both. (The same-rule-only analysis missed this and
folded `q` against a still-growing `p`, producing ambiguous same-left `_aggval`
rows — the concrete bug this plan closes.)

## The stratum algorithm

Operate on the `=`-subgraph only; `<` edges are *ignored for stratum* (they are
the moment scheduler's job).

1. **Build** the time-marked graph from the rules (one pass).
2. **`=`-reachability**: transitive closure over `=` edges.
3. **`=`-SCCs**: relations mutually `=`-reachable form one component (a
   same-moment recursion cluster — see next section). A self-`=`-loop (`p =→ p`,
   e.g. transitive closure) is a singleton same-moment-recursive SCC.
4. **Level** = longest path in the `=`-SCC condensation (`A =→ B` with distinct
   SCCs ⇒ `level(B) > level(A)`). This integer is the relation's **stratum**.
5. Relations with no `=` edges (only `<`, or none) get stratum `0` and are never
   serialized against anything — correct, since they share a moment with a
   dependant only via an all-`=` path, which they have none of.

Only reactive relations actually need a stratum (only they are finalized), but
the `=`-paths feeding them may traverse plain relations, so compute reachability
over all nodes and read off strata for the reactive ones.

### Outer-loop use (already in place)

Unchanged from the reactive-aggregates plan: within the earliest-moment tier,
finalize only the items whose relation is in the **lowest stratum present**,
re-enter the inner loop, repeat. With strata now coming from the `=`-subgraph:

- `=` dependency `A =→ B`: `stratum(A) < stratum(B)`, so at a shared moment `A`
  finalizes (and, if recursive, reaches fixpoint) before `B` is folded.
- `<` dependency `A <→ B`: same stratum is *allowed*; `B` lives at a strictly
  later moment, so the moment-primary tier ordering already finalizes `A` first.
  No false serialization, and (critically) no false "recursion" — see below.

## Cycle safety: `<` breaks a same-moment cycle

This is the heart of the refinement:

- **A cycle containing ≥1 `<` edge is safe.** Time strictly advances once around
  the loop, so the recursion unfolds across *distinct, increasing moments* — it
  is temporally stratified. It is **not** an `=`-SCC (the `<` edge is absent from
  the `=`-subgraph), so the analysis does not collapse it, does not co-stratify
  its members, and does not flag it. Example (mutual recursion via `+`):

  ```
  a -> X, go, +b ...      # a <→ b
  b -> Y, go, +a ...      # b <→ a
  ```

  `a`,`b` get independent strata; each finalizes freely at its own moment.

- **A cycle of all `=` edges is same-moment recursion.** The whole cluster lives
  at one moment and must be driven to a fixpoint there (the residual-driven
  re-finalization of the reactive-aggregates plan). This is sound **iff the
  fixpoint is monotone** — each group reaches a single final value by
  accumulation, never changing an already-emitted value. Transitive closure
  (`p =→ p`, bool, each derived pair a *fresh group key*) satisfies this: groups
  are only added, never revalued. A scalar self-accumulation at one moment
  (`s -> X, ^s -> (X+1)` — one group, value changes every round) does **not**:
  successive values share the breakpoint's left endpoint and `last`-read cannot
  disambiguate them. Such non-monotone `=`-cycles are rejected / flagged
  (sharpens open question 5 of the reactive-aggregates plan).

So the well-formedness condition is precisely: **every dependency cycle either
contains a `<` edge (time-stratified, always fine) or is an all-`=` cycle whose
aggregates are monotone (same-moment fixpoint).** Equivalently: the
`=`-subgraph's nontrivial SCCs must be monotone.

Because the `=` mark is heuristic (open question 2), an SCC flagged as all-`=`
may in truth be time-stratified — so the monotonicity requirement is itself
*conservative*: it can demand monotonicity of a loop that the moment order would
have separated anyway. Phase 1 accepts that; any rejection should therefore be a
warning the user can override, not a hard error, until the mark is tightened.

### Why ignoring `<` for stratum is correct (sketch)

Claim: with lexicographic **(moment, `=`-stratum)** finalization, when reactive
`B`'s breakpoint at moment `m` is finalized, every contributor to `B`'s groups at
`m` is present and final.

A `B`-contributor at `m` is produced by a rule whose reads feed it. Take any read
of a reactive `A`:
- edge `A =→ B`: the contribution is `^B`, so `A` is read at the **same** moment
  `m`; `stratum(A) < stratum(B)` (distinct `=`-SCCs) ⇒ `A` already finalized at
  `m`. If `A`,`B` share an `=`-SCC, they are finalized together to a monotone
  fixpoint at `m`.
- edge `A <→ B`: the contribution is `+B`/`~B`, so `A` was read at a moment
  `m' < m`; `A` is finalized in an earlier tier by the moment-primary key.

Plain-relation reads are derivations of the above through intermediate nodes;
the `=`/`<` mark of each hop composes (`=` ∘ `=` = `=`; any `<` ⇒ `<`), so the
two cases are exhaustive. ∎

## Files to change

- `scheduler.ts:computeAggStrata` — replace the unmarked all-edge reachability
  with the time-marked version:
  - classify each produced head's marker into `=` (`anchor`) vs `<`
    (`fact`/`episode`/`ask`); skip `constrain` (a filter, produces no consumable
    relation) for now.
  - build edges read→produce as today, but keep **only `=` edges** in the graph
    used for SCC + level. (`<` edges may be recorded separately for the
    well-formedness check / diagnostics, but do not enter the stratum graph.)
  - the SCC + longest-path-level code is reused verbatim on the `=`-subgraph.
- `scheduler.ts` / `fixpoint.ts` — the outer-loop lowest-stratum filter is
  already implemented (reactive-aggregates plan, phase 1); no change beyond the
  strata now being `=`-only.
- **Well-formedness check (new, optional first cut):** after computing
  `=`-SCCs, for each nontrivial SCC (size > 1, or a self-`=`-loop) whose members
  include a `#reactive` relation with a non-monotone aggregator, surface a
  diagnostic. Monotone set for phase 1: `bool` (and `count`/`sum` only when the
  recursion refines the group key — left as a documented restriction rather than
  a static check initially). Runtime gas remains the backstop.

## Tests

- **`=` chain through a plain relation:** the `p =→ c =→ q` program above; assert
  a single unambiguous `_aggval q` (the bug regression).
- **`<` cycle is not collapsed:** mutual `+` recursion `a ↔ b`; assert `a` and
  `b` get independent strata and the (bounded) run terminates with correct
  values at increasing moments — i.e. the analysis does **not** treat it as
  same-moment recursion.
- **`=` self-loop, monotone:** transitive closure (`p =→ p`, bool); full closure
  incl. self-loops (already covered in `v2_reactive_aggregate.test.ts`).
- **Mixed cycle `A =→ B <→ A`:** assert the `=`-subgraph is acyclic (`stratum(B)
  > stratum(A)`), so the within-moment order is enforced while the `<` edge
  breaks the recurrence.
- **Marker classification:** unit-test that `^`/`+`/`~`/`?` produce the expected
  edge marks (drive `computeAggStrata` on small rule sets and inspect strata).

## Relationship to the reactive-aggregates plan

That plan introduced strata as "edge `A → B` when a rule contributing to `B`
reads `A`" — implicitly all-`=`, same-rule only. This plan:
- generalizes edges to **whole-program reachability** (through plain relations),
- adds the **`<`/`=` time mark** so only same-moment (`=`) dependencies
  constrain the stratum, and
- sharpens the same-moment-recursion safety condition (open question 5) to "an
  `=`-cycle must be monotone; any `<` in a cycle makes it safe."

Update the reactive-aggregates plan's *single-moment stratification* section to
reference this analysis as the authority for how strata are computed.

## Open questions

1. **Static monotonicity check for `=`-cycles.** Detecting "the recursion only
   adds fresh group keys" (safe) vs "revalues an existing group" (ambiguous)
   precisely is non-trivial. First cut: permit `bool` `=`-cycles, flag others.
2. **The analysis is heuristic — `=` is `may-coincide`, not `must`.** This is
   the central imprecision, worth stating plainly: `^c`'s moment is the anchor =
   `max` of the reads' left endpoints, so it coincides with only the *latest*
   read, but we mark `=` against *all* of them. In `a, b, ^c`, the edge `a =→ c`
   is spurious whenever `b` provably starts strictly after `a` (then the anchor
   is `b`'s moment and the true relationship is `a <→ c`). The consequences of
   the over-approximation are sound but lossy: it can (a) serialize two reactive
   relations within a moment that never actually share one, and (b) — more
   importantly — classify a genuinely time-stratified loop as an all-`=` cycle
   and thus subject it to the monotonicity restriction it doesn't need.
   Tightening requires a *prior* analysis: downgrade `r =→ h` to `r <→ h` when
   some other read of the rule is provably strictly-after `r` in the moment
   order (so `r` is never the anchor). That sub-analysis is itself non-trivial
   (it reasons about which read wins the `max`), so it is deferred — phase 1
   ships the conservative `=`-everywhere mark and accepts the false
   serializations / false `=`-cycles it may produce.
3. **`constrain` / choice (`?`) participation.** Choices interact with the same
   tiered scheduler; whether they belong in this graph (and with which mark) is
   deferred until reactive aggregates and choices are exercised together.
4. **Generality.** The same `<`/`=` analysis characterizes temporal
   well-stratification for any non-monotone construct (not just aggregation). If
   negation or other non-monotone reads are added, they reuse this graph.

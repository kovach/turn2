# Formalizing Turn (v2) in Lean — plan

Status: **definitions and theorem statements only.** `lake build` succeeds, and
every theorem below is stated in Lean with a `sorry` proof (63 in total). No
proofs have been attempted yet. That is the next step.

## 1. What is being formalized

The target is the v2 semantics as the TypeScript engine implements it
(`ts/src/v2`: expand.ts, eval.ts, store.ts, acc.ts, moment-walk.ts,
scheduler.ts, constraint-query.ts). It is read through the existing prose
analyses:

- `discussions/turn-temporal-logic.md` — the semantic table per marker, the
  "three stacked formalisms" view, and five review findings;
- `notes/moment-insertion.md` — the informal subdivision ⇒ lattice proof;
- `plans/v2-acc-relations.md` §2 — the op algebra (η, ⊕, e, ρ);
- `plans/v2-choice-components-by-moment.md`, `plans/v2-moment-walk.md` —
  frontier, settling, and choice components located at their ask moment;
- `discussions/turn-tutorial.md` — the user-facing contract, used for
  example theorems.

The temporal-logic note's summary is the shape of the formalization:

> existential rules over interval structures on a lattice, with bodies in the
> chop fragment of interval logic under homogeneity, evaluated by the Skolem
> chase, with non-monotone operators temporally stratified along the
> lattice order.

## 2. Architecture

```
Turn/Order/Subdivision.lean   moment graphs from bot→top by subdivision; lattice theorem
Turn/Syntax.lean              Val (incl. Skolem terms), Term, Atom, Item (kernel syntax), Program
Turn/Match.lean               environments, one-sided matching, emit instantiation
Turn/Store.lean               Tuple, Fact, Store := Set Fact, Inputs, moment order, Max/Min, alive
Turn/Body.lean                anchor-threaded body semantics: RunI/RunB, ReachI/ReachB, emitFacts
Turn/Chase.lean               T (one round), chase := least model, stages; order-shape theorems; examples
Turn/Acc.lean                 #acc op algebra, contributions at a moment, strata iteration, accAt
Turn/Walk.lean                walk states, frontier, components/options, WStep, causality, stability
```

The layers map onto the three formalisms:

| layer | Lean | standard home |
|---|---|---|
| rule bodies | `Body.lean` | chop-based interval logic (ITL/CDT/HS) over order-intervals |
| rule firing | `Chase.lean` | existential rules / TGDs, Skolem chase |
| moment order | `Order/Subdivision.lean` | causal order; subdivision lattice |
| aggregates | `Acc.lean` | commutative monoids, semilattice fixpoints |
| walk and choices | `Walk.lean` | temporal (XY-)stratification over a partial order |

## 3. Modelling decisions

Each is a deliberate choice; deviations from the implementation are marked.

1. **Kernel syntax.** It is the pre-decomposition marker language: `atom`,
   `sub` `(B)`, `seq` `(B);`, `eq`, `prim`, `accRead`, `episode` `~`, `fact`
   `+`, `here` `^`, `ask` `?`, `constrain` `!`. Dot chains, arity saturation,
   macros and `#type` are assumed already eliminated (they are syntactic).
   Exceptions, `#agg`, `#reactive` and bracket aggregates are left out (§6).
2. **Skolem terms are explicit.** Fresh moments, objects, tuple ids and choice
   terms are `Val.sk rule path kind trace`. Here `trace` holds every value the
   firing consulted. *Deviation:* there is no chain-liveness pruning
   (expand-liveness.ts). Pruning correctness is a separate, implementation-level
   theorem (§6).
3. **Facts are typed.** `Fact.tuple | edge | ask | constr` instead of
   reserved-head tuples (`_choose`, `_constrain`, side-table edges).
   `Store := Set Fact` is a complete lattice, so the chase is `sInf` of the
   closed stores. No proof obligation sits inside a definition.
4. **Inputs are separate.** `is` rows, `_dead-choice` markers, and `#acc`
   rows are not derived by the monotone part. `Inputs` parameterizes the
   chase, and the walk produces them. `is` is a *timeless* primitive. This
   matches the implementation exactly: its rows sit at `(bot, top)`, so a
   match leaves the anchor unchanged.
5. **Split semantics.** An emit fires once the prefix before it succeeds
   (`ReachB`), and the continuation waits until the emitted facts are in the
   store (`RunI.emit` requires `emitFacts ⊆ S`). That is `splitRule` plus the
   paired consumer `Match`, stated directly.
6. **`Max`/`Min` are relational.** `Store.IsMax` succeeds on comparable
   arguments and is monotone in the store. On acyclic stores it is the
   implementation's partial function (`Store.isMax_unique`).
7. **Two semantic switches** on `Ctx`:
   - `strict` (default `false` = implementation): moment-minting emits at a
     point anchor fail instead of asserting a cycle (finding 3);
   - `meet` (default `.pairwise` = implementation): `.lattice` uses
     join/meet in the moment order instead of comparability-gated `Max`/`Min`
     (finding 1).

   Each theorem names the mode it needs, so the cost of each
   implementation choice shows in the hypotheses.
8. **Ghost state.** `Cfg.deps` (everything consulted) and `Cfg.anc`
   (anchoring premises; a `sub` drops its inner ones) exist only to state
   causality.
9. **Walk rounds are abstracted.** A walk state's store is *defined* as the
   chase of its inputs, so inner-loop quiescence is built in. `WStep` has four
   steps: `settle` (acc rows, once per moment), `resolve`, `choose`, and
   `dead`.
10. **Not modelled:** gas and domain errors (η on a bad term, js errors).
    The error statuses (`late-constraint-error`, `empty-fringe-error`) are
    also absent, as are actor priority inside mixed `you`/`rng` components,
    rng seeding, the `#js-def` mode analysis (prims are arbitrary relations),
    and per-atom grouping of `?A B` (one ask fact per variable).
11. **`@last`/`@arg-min` carriers** need the moment order inside the monoid
    (antichains of temporal maxima). The registry returns `none` for them for
    now. Contribution moments use the lub of anchoring premises' starts. The
    moments of acc rows read are not yet tracked.

## 4. Theorem inventory

Difficulty: ★ routine, ★★ real induction, ★★★ main results.

### Phase 0 — matching and order basics (`Match`, `Store`)

| theorem | statement | ★ |
|---|---|---|
| `MatchT.extends` | matching only extends the environment | ★ |
| `MatchL.subst_iff_inst` | on fully bound patterns, match ⇔ equal to the instantiation | ★ |
| `Store.le_mono`, `Store.isMax_mono` | order facts persist as the store grows | ★ |
| `Store.isMax_unique` | on acyclic stores `Max` is functional | ★ |
| `Store.isMax_isSup` | when `Max` is defined it is the lattice join (pairwise refines lattice) | ★★ |

### Phase 1 — the subdivision lattice (`Order/Subdivision`)

This is the cleanest self-contained target and the natural first proof.

| theorem | statement | ★ |
|---|---|---|
| `toWeak`, `finite`, `edge_mem`, `bot_reach`, `reach_top` | bookkeeping | ★ |
| `reach_new_iff_left` / `_right` | ↓v = ↓a ∪ {v}, ↑v = ↑b ∪ {v} (the key structural lemma) | ★★ |
| `reach_old_iff` | insertion is conservative on old vertices | ★★ |
| `antisymm` | strict subdivision graphs are acyclic | ★★ |
| `exists_lub`, `exists_glb` | **lattice theorem** (moment-insertion.md) | ★★★ |
| `lub_stable` | old lubs survive insertion (needed for the infinite chase) | ★★ |
| `lattice` | packaged `Lattice` instance on the vertex set | ★★ |
| `sibling_lub` | two siblings minted in `[a, b]` join at `b` | ★★ |
| `SubdivWeak.point_cycle` | a degenerate insertion breaks antisymmetry | ★ |

The proof plan follows moment-insertion.md exactly. Induction on `Subdiv`,
case split on whether each argument is the new vertex, and the down-set/up-set
lemmas carry the cases. The GLB case is the dual. The best route may be one
`OrderDual`-style symmetry lemma (reverse all edges and swap `bot`/`top`),
proved once, so the dual is not proved again.

### Phase 2 — single bodies (`Body`)

| theorem | statement | ★ |
|---|---|---|
| `RunB.mono`, `ReachB.mono` | evaluation is monotone in the store (pairwise) | ★★ (mutual induction) |
| `RunB.anchor_inv` | running-anchor invariant: `XL ≤ XR`, `XL`↑, `XR`↓ | ★★ |
| `RunB.anc_le` | anchoring premises start no later than the anchor | ★★ |
| `ReachB.emit_after_anc` | **emissions are causal w.r.t. anchoring premises** (peeks excepted) | ★★ |
| `ReachB.functional` | on acyclic stores the configuration at a point is determined by the trace | ★★ |
| `atom_noncomm` | adjacent matches do not commute under pairwise `Max`/`Min` (counterexample) | ★ |
| `atom_comm_lattice` | under the lattice meet they do | ★★ |

### Phase 3 — the chase (`Chase`)

| theorem | statement | ★ |
|---|---|---|
| `T_mono` | one round is monotone (from `ReachB.mono`) | ★ |
| `chase_isModel`, `chase_least`, `chase_fixed` | Knaster–Tarski | ★ |
| `chase_eq_iUnion_stage` | Kleene: the inner loop is complete (T is ω-continuous: firings read finitely many facts) | ★★ |
| `stage_mono` | stages grow | ★ |
| `stage_acyclic` | strict semantics never asserts a cycle | ★★ |
| `stage_subdiv` | every finite stage's order *is* a subdivision graph (strict) | ★★★ |
| `chase_lattice` | the chase's moment order is a lattice (strict) | ★★ (from the above and `lub_stable`) |
| `chase_momL_edge_unique` | a Skolem moment is placed once | ★★ |
| `Examples.point_cycle` | the implementation's `a, (+p); +q` asserts a cycle | ★ |
| `Examples.point_strict` | strict semantics derives no `q` | ★★ (needs an invariant to rule out derivations) |
| `Examples.pins_self`, `pins_no_cross`, `pins_peek_cross` | the tutorial's constructive-overlap puzzle | ★ / ★★ / ★ |
| `Examples.pins_lattice_strict_no_cross` | under lattice + strict the plain join is refused at the point `[s.r, s.r]` | ★★ |

`stage_subdiv` is the crux. Its proof needs three things. First, each fresh
moment is minted by one emit site. Second, by `ReachB.functional`, its anchor
is determined. Third, the insertions of one stage can be sequenced: insert all
`momL`s, then the `momR`s inside `[l, XR]`. Every anchor `XL ≤ XR` was already
true in the previous stage, by `anchor_inv`. The statement compares
*reachability*, not edge sets: an episode's `l → r → XR` edges are a
subdivision up to reach-equivalence. `stage_acyclic` and `ReachB.functional`
are mutually dependent across stages, so prove them by one induction on `n`.

`pins_no_cross` and `point_strict` are negative results about a least
fixpoint. Prove them by exhibiting a model that excludes the fact
(`chase_least`), not by analysing derivations.

### Phase 4 — `#acc` (`Acc`)

| theorem | statement | ★ |
|---|---|---|
| `foldKey_union` | fold is a monoid homomorphism on disjoint contribution sets | ★ |
| `idempotent_fold_dedup` | idempotent ⇒ identity-based dedup is unobservable | ★ |
| `opMin_idempotent`, `opBool_idempotent`, `opSum_not_idempotent` | registry facts | ★ |
| `stratumIter_mono` | contributions accumulate | ★ |
| `stratum_limit_solution` | a settled stratum is a fixed point of one more round | ★★ |
| `accAt_strata_indep` | result independent of the valid topological order of SCCs | ★★ |
| `keyless_count_zero` | keyless zero row = ρ(e) | ★ |
| `Examples.distance_correct` | shortest paths through `@min` settle and are correct | ★★★ |

Still to add here: the `@last`/`@arg-min` carriers (antichain monoids
parameterized by an order; prove comm/assoc). Then the general theorem behind
`distance_correct`: for idempotent ops and rules monotone in the information
order (`a ≤ b ⇔ a ⊕ b = b`), the accumulated iteration reaches the least
fixpoint, and it terminates when that order is well-founded on the reachable
values.

### Phase 5 — walk, causality, choices (`Walk`)

| theorem | statement | ★ |
|---|---|---|
| `peekFree_deps_avail` | syntactic peek-freedom ⇒ tuple/acc parts of causality | ★★ |
| `past_local` | **locality**: for causal programs the causal past of `m` depends only on inputs available by `m` | ★★★ |
| `walk_inv` | `resolved ⊆ settled`; `resolved` is a down-set | ★★ |
| `resolved_final` | nothing derived later is alive at a resolved moment (the "temporal monotonicity" assumption of fixpoint.ts, proved) | ★★★ |
| `options_stable` | options at a blocked moment are stable until chosen; dead stays dead | ★★ (from `past_local`) |
| `internal_diamond`, `internal_determinate` | **confluence**: for fixed choices, frontier order is unobservable | ★★★ |
| `acc_snapshot` | rows at `m` = `accAt` over inputs strictly before `m` (temporal stratification, declaratively) | ★★★ |

Proof strategy. `past_local` is an induction on chase stages. A fact in the
past of `m` was emitted by a causal firing. Its dependencies are available by
`XL ≤ l ≤ m`. So they are in the past of `m` too, and come from the restricted
inputs. This needs the subdivision lemma that order facts among old moments
never change. Everything else in the phase is a corollary of `past_local` plus
the down-set invariant.

## 5. Open semantic questions the formalization forces

These are decisions for the language, not for the proofs; the theorems are
stated so the answer only changes hypotheses.

1. **Point anchors** (`strict`). Every order-shape theorem needs
   `strict = true`. The implementation asserts a cycle instead
   (`Examples.point_cycle`). Recommendation (as in the temporal-logic note):
   make `AssertLt a b` fail when `b ≤ a` already holds.
2. **Pairwise vs lattice meet** (`meet`). Pairwise is what makes the chase
   monotone *unconditionally* (`T_mono`). Under `.lattice`, `IsSup` is not
   monotone in arbitrary stores, only on subdivision stores (by `lub_stable`).
   So switching costs one extra invariant in the chase proofs. In exchange,
   matches commute and the sibling puzzle gets a principled answer.
   (Compare memory note "symbolic max/min decision", which proposes yet another
   variant; it would be a third `MeetMode`.)
3. **Causality is not guaranteed by the language.** `resolved_final`,
   `options_stable` and confluence all assume `Causal C`. Three things break it:
   - peeks `(atom)` of a tuple that starts later than the anchor (finding 2);
   - **acc reads inside a peek** `(…, accrel k v)`. These read at the inner
     anchor's start, which is later than the outer anchor the emission uses.
     Same class as peeks, but not noted before;
   - **timeless `is` reads** by a rule anchored before the choice's ask moment,
     e.g. `game, is C M, +foo`. `+foo` lands inside `game` and can be alive at
     moments the walk already resolved.

   `Causal` is a per-firing check (every consulted dependency available by
   `XL`). So the TS engine could assert it dynamically in a debug mode at
   negligible cost. That would turn the walk's silent assumption into a
   reported error. `Body.PeekFree` is a conservative static check. ttt's
   `(actor P)` peeks are causal but not peek-free, so a sharper static check
   would be welcome.
4. **Identity.** Tuples carry per-firing ids, so the store is a bag at the
   level of visible content. That is load-bearing for `@sum`/`@count`, and
   unobservable for idempotent ops (`idempotent_fold_dedup`). Any statement
   about "the same fact" must say which equality it means.

## 6. Later phases (not yet in Lean)

- **Phase 6 — the flat IR and `expand`.** Define the post-expand IR
  (`Match`/`Emit`/`Le`/`AssertLt`/`Equal` with `Max`/`Min`), its evaluator
  (eval.ts), and `decompose` (expand.ts `decomposeBody`/`decomposeMatch`/
  `decomposeEmit`). Then prove `decompose_correct`: the IR emits the same
  facts as the kernel, up to a bijective renaming of Skolem terms to
  `(*mom …)`/`(*id …)` compound values. Also: `split_correct` (split rules have
  the same chase), `delta_variants_correct` (semi-naive = naive), and
  `pruneChains_injective` (pruned fingerprints still separate distinct
  firings).
- **Phase 7 — exceptions.** Define `applyExceptions` as a source-to-source
  translation into kernel rules plus a `bool` acc/agg flag. State the intended
  meaning ("within the context, `p` tuples matching the LHS are replaced by
  the RHS") and prove the translation achieves it under causality. The sharp
  edges in the memory note (LHS-only RHS variables; temporal interception)
  should come out as hypotheses.
- **Phase 8 — `@last`, `@arg-min`**, and the general idempotent-fixpoint
  theorem (§4, phase 4).
- **Phase 9 — universality.** The chase is a universal model: it maps
  homomorphically into every model of the rules read as TGDs over an arbitrary
  interval structure. This is the formal link to the "existential rules" view.
- **Phase 10 — executable model.** A computable chase for finite programs
  (decidable equality on `Val`, finite prims), run with `#eval` on small
  corpus programs (`pins.t`, a cut-down `ttt.t`), plus differential tests
  against `v2-cli` output. This is the cheapest check that the definitions
  mean what the engine does, and it should come *before* the big proofs in
  phase 5.

## 7. Suggested order of work

1. Phase 1 (subdivision lattice): self-contained, already proved on paper.
2. Phase 0 and phase 2 monotonicity/invariants, then `T_mono` and the
   Knaster–Tarski block.
3. Phase 10, executable model and differential tests on the examples. This
   validates the definitions before investing in phase 3/5 proofs.
4. `stage_subdiv` / `chase_lattice`.
5. Phase 5 `past_local`, then its corollaries.
6. Phase 4, then phases 6–9 as interest dictates.

## 8. Update 2026-10-09: fresh-left `^`, `#acc` + `not`, anchored `is`

The definitions now follow the semantics change implemented in the scratch
fork (plan `v2-caret-fresh-left.md`):

- **`^`** (`emitFacts`/`emitNext` for `.here`) mints a fresh left end and
  continues on `[l, A.r]`. At the initial anchor `[bot, top]` it emits exactly
  there. The model checks this dynamically (`A.l = bot`); the implementation
  checks it statically. `Item.mintsMoment` includes `here`.
- **`Item.notAcc`** is the negated point read of an `#acc` relation (`not r t̄`).
- **`is`** rows are input tuples (`Inputs.tuples`) on `[ask moment, top]`. The
  walk records each commitment's ask moment (`WState.isRows`). `Dep.availBy`
  loses its `is` special case: an `is` read is an ordinary tuple dependency.
  `Inputs.upTo`/`before` restrict input tuples by their start.
- **New statement `snapshot_eq_final`:** the acc rows written when a moment
  settles are what the final store yields there. This is what `not` and choice
  options rely on, and fresh-left `^` is what makes it plausible.

The order-shape theorems (phase 1 and 3) are unaffected: `^` now inserts
subdivisions exactly like `+`. Point-anchor `^` falls under `strict`.

---
Plan and Lean skeleton written by Claude Opus 5.5 (`claude-opus-5-5`), 2026-10-08.

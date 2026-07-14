# exception watchers (amendment to [[v2-exceptions]])

Amends the desugaring in `plans/v2-exceptions.md`. Steps 1–3 and 5–7
are unchanged; step 4 (in-place recognition) is replaced by a context
broadcast plus a detached **watcher rule**.

## Problem

Step 4 of the original desugaring splices `match p' t̄, anchor p_exn
V̄ -> 1` into the host rule `R`'s body. A match gates `;` progression,
so an exception atom stalls the rule until an intercepted tuple
actually shows up:

```
play A

( ~play x, {move X => ~foo X} );
( ~play y, {move Y => ~bar Y} )
```

With no `move` producer, `play y` is never emitted — the spliced
`match _move_prime1 X` in step 1's thread never succeeds. The inline
match conflates "this context is where the override applies" (should
hold unconditionally) with "an intercepted tuple occurred" (should be
optional). A second symptom of the same splice: the LHS variables of
all of `R`'s exceptions share `R`'s namespace, so two exceptions that
both write `{move X => …}` silently unify their `X`s and the second
becomes a filter on the first's binding.

## Design

`R` no longer matches `p'` at all. It *broadcasts its context* with a
plain emit, and a generated watcher rule joins that context episode
with `p'` tuples to set the flag. Per exception `{p t̄ => e}` in `R`,
with `n = |t̄|`:

- **Vt** `= vars(t̄) ∩ vars(prefix(R))` — LHS vars bound by the rule
  context. These preserve the filter semantics of a prefix-bound LHS
  var (misfits' `{move X _ => ~nope}` with `X` bound earlier): the
  watcher re-unifies them with the tuple.
- **Ve** `= (vars(e) ∩ vars(prefix(R))) \ vars(t̄)` — unchanged `V`
  from the original plan; the flag payload.
- **U** `= Vt ∪ Ve` in prefix first-seen order — the ctx payload.

Three fresh names per exception (same `k`): `_<p>_prime<k>`,
`_<p>_exn<k>` (bool, as before), and `_<p>_ctx<k>` (plain relation,
no schema entry).

1. Compute `Vt`, `Ve`, `U` (prefix walk unchanged).
2. Schema: `p_exn : bool` (unchanged).
3. Rewrite arity-exact emits of `p` to `p'` across `S` (unchanged).
4. **Replace** the Exception atom in `R` with the single emit
   `anchor p_ctx U̅` — no match, so nothing gates. An `anchor` emit
   lands exactly on `R`'s running anchor interval at that body
   position, which is the interval the old inline recognition operated
   within.
5. **Add to `S` a watcher rule** `<rule>_watch<j>`:
   `match p_ctx U̅, match p' t̄, anchor p_exn Ve̅ -> 1`.
   The two matches intersect, so the flag is emitted over
   `ctx ∩ tuple` — byte-for-byte the interval the old step 4 produced;
   the exception/default rules and the containment-based mutual
   exclusion are untouched. Shared `Vt` vars unify between the ctx
   match and the `p'` match; LHS vars not in `prefix(R)` stay local
   pattern vars.
6. Exception rule `<rule>_exn<j>` (unchanged):
   `match p' t̄, aggregate p_exn Ve̅ -> 1, e`.
7. Default rule `<rule>_default<j>` (unchanged):
   `match p' W̄, aggregate p_exn _̄ -> 0, anchor p W̄`.
8. Last exception processed → `R` joins `S` (unchanged). Chaining is
   unaffected: the default's `anchor p W̄` is still the emit a later
   exception's step 3 rewrites.

## Semantics changes (decisions, 26/07/13)

- **Exceptions no longer gate progression.** An exception is a
  listener: `R` proceeds past it whether or not any `p'` tuple exists.
  A rule that wants to bind-and-gate on an occurrence writes an
  explicit match itself.
- **Exception LHS variables are local to the exception.** They no
  longer join `R`'s namespace, so (a) two exceptions reusing a
  variable name no longer unify, and (b) a later exception's RHS can
  no longer reference an earlier exception's LHS var — the original
  plan's *V-scoping worked example* (`{q Z => e2 X Z}` reading exc1's
  `X`) is retired. Such a var is now an ordinary local var of `e`
  (dangling if `e` never binds it — same as writing that rule by
  hand; not an error, since a fresh join var in `e` is
  indistinguishable syntactically).
- Prefix-bound LHS vars keep their filter meaning via `Vt` transport
  (see Design). `prefix(R)` for later exceptions now sees the ctx
  emit's `U̅` vars (all already prefix-bound) instead of the old
  in-place match's fresh `t̄` vars.
- `R`'s post-exception steps no longer have their anchor intersected
  with the matched tuple's interval (the old inline match narrowed
  it). Steps now span their full step interval.

## Implementation (`ts/src/v2/expand.ts`, `applyExceptions`)

- Mint `_<p>_ctx<k>` alongside prime/exn (one shared `k`; extend the
  freshness loop and `usedSyms`).
- Compute `U` next to `V` (rename `V` → `Ve` optional): `U =
  prefixVars.filter(n => tVars.has(n) || eVars.has(n))`.
- Step 4: `container.splice(index, 1, ctxEmit)` where `ctxEmit` is
  `{ tag: "Atom", marker: "anchor", atom: { terms: [sym(ctxName),
  ...vars(U)] }, span }` (no weight).
- Push the watcher rule (name `${R.name}_watch${j}`; include it in
  the rule-name collision loop) before the exn/default rules.
- Module doc comment: note the watcher design and point at this plan.

No changes to parse.ts, eval.ts, scheduler.ts, or the post-expand
pipeline.

## Tests (`ts/src/tests/v2_exceptions.test.ts`)

- Tests 1–3, 5b, 6, 7, 7b, 9–14 keep their assertions (behavior
  preserved); structural tests updated:
  - **4 (structural)**: rewrite for the watcher shape. Retire the
    cross-exception V-scoping source (`e2 X Z` → `e2 Y Z`, a genuine
    prefix var). Expect rule set `r, r_watch1, r_exn1, r_default1,
    r_watch2, r_exn2, r_default2`; `r`'s body ends each exception
    with `anchor _p_ctx1` / `anchor _q_ctx1 Y`; watchers as in
    Design step 5.
  - **4b (end-to-end)**: same source change; assert `e2 yv zv`.
  - **5 (structural)**: `r`'s body has ctx emits with payload `X` /
    `Y` (prefix-bound LHS vars → `Vt`); `r_default1`'s tail still
    rewritten to `_move_prime2` (chaining unchanged).
  - **8 (naming)**: expect `f, f_watch1, f_exn1, f_default1,
    f_watch2, f_exn2, f_default2`.
- New tests:
  - **15 (stall regression)**: the Problem program with no `move`
    producer — assert both `play x` and `play y` are emitted, and
    nothing else changes. Variant with a `move` producer (`play A,
    ~move A`): assert `foo x` and `bar y` (per-step interception,
    distinct or same LHS var names — both spellings now equivalent).
  - **16 (LHS var locality)**: the previous-turn program with both
    exceptions spelling their LHS var `X`; assert `foo x` *and*
    `bar y` (no accidental unification).
  - **17 (prefix-bound LHS var still filters)**: `first a` context,
    `{move X _ => ^nope}` after `first X`. With only a non-matching
    producer `^move c d`, the watcher must NOT set the flag (`move c
    d` survives, no `nope`) — without `Vt` transport the watcher's
    `X` would bind `c` and intercept. Positive companion: `^move a b`
    is intercepted. (Interception is temporal — two tuples sharing
    one moment share one flag, per the containment note on test 9 —
    so value-level discrimination *within* one moment is out of
    scope, same as the original design.)

## First-pass findings (26/07/13)

- **CHAR 12(c) diagnosed** (after-`;` placement intercepting nothing).
  The watcher makes the geometry visible: the ctx episode spans
  `phase1_r .. world_r`. The phase1 tuple touches it only at the
  shared endpoint, giving a degenerate flag interval that contains
  nothing (arguably correct — that tuple predates the window). The
  phase2 tuple lies strictly inside the window by transitivity
  (`phase1_r < phase2_l < phase2_r < world_r`), yet the watcher join
  never fires — and a hand-written equivalent reproduces it without
  exceptions at all:

  ```
  ~world
  world, ~phase1; ~phase2
  phase2, ^q b
  #def r
    world
    (phase1); ^ctx2
  ctx2, q X, ^flag X        -- flag b is never derived
  ```

  So the evaluator does not derive overlap between a post-`;` anchor
  interval and a tuple minted under another rule's later step — a
  general moment-order/join question, not an exceptions one. Fixing
  it fixes CHAR 12(c) for free.

## Docs

- `ts/src/v2/overview.md`: update the `applyExceptions` bullet
  (watcher rule, `_<p>_ctx<k>`, `<rule>_watch<j>`, non-gating).
- `plans/v2-exceptions.md`: add a pointer line at top: step 4
  superseded by this plan.
- `ts/data/v2/exceptions.t`: add a no-producer stall example.

No new source files, so no other overview.md structure changes.

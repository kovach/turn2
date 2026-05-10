# v2 — explicit anchor manipulations in the IR

## Motivation

Today the v2 evaluator (`ts/src/v2/eval.ts`) carries an `anchorStack` and
implicitly does the moment-arithmetic of v2:

- `evalMatch`: overlap-test the matched tuple's `(l, r)` against the
  current anchor (`intervalsOverlap`), and intersect (`max/min`) the
  anchor for the rest of the body.
- `evalAssert` (`~`/`+`/`^`): mint fresh moments, `addOrder` them to
  the anchor endpoints, and intersect the anchor.
- `evalSeq` for `Sub`: push a copy of the anchor; on `);` slide the
  outer anchor's left endpoint to the inner's right.

Hidden in the evaluator, this means any new temporal connective grows
the marker enum and the dispatch in `eval.ts`. We want it in the IR so
new connectives are an `expand`-only change, the evaluator stays a flat
dispatch over small primitives, and `lessThan` / `addOrder` calls
become explicit and grep-able.

## End state — IR

### New `RuleAtom` constructors

```ts
// Stored-tuple lookup. No anchor / overlap logic; no lLit/rLit. Just a
// pattern lookup whose endpoints unify with the supplied l, r terms.
{ tag: "Match"; atom: Atom; l: Term; r: Term;
  constraint?: MatchConstraint;        // semi-naive bucket
  span: Span; }

// Emit a stored tuple with the given endpoints. No marker variants —
// `~ / + / ^` are decomposed by expand into the right combination of
// fresh moments + AssertLt + Emit.
{ tag: "Emit"; atom: Atom; l: Term; r: Term;
  span: Span; }

// Moment-order *check* (read-only). Succeeds iff a ≤ b in the current
// closure. Both ground.
{ tag: "Le"; a: Term; b: Term; span: Span; }

// Moment-order *insert*. Records the edge a < b (calls `addOrder`).
// Both ground.
{ tag: "AssertLt"; a: Term; b: Term; span: Span; }

// Bind `out` to the larger / smaller of `a` and `b` under the current
// moment order. `a`, `b` ground; `out` an unbound `Variable` (or `_`).
// Incomparable args fail relationally — the evaluator backtracks past
// the atom, matching today's incomparable-anchor → failed-overlap
// behavior. Never throws.
{ tag: "Max"; a: Term; b: Term; out: Term; span: Span; }
{ tag: "Min"; a: Term; b: Term; out: Term; span: Span; }
```

`Equal` stays unchanged. `Sub` is a *pre-expand only* node — the
decomposition pass eliminates it (see "Sub elimination"). After
expand, every body is a flat list of
`Match | Emit | Le | AssertLt | Max | Min | Equal`. The `Marker` enum
(`match | episode | fact | anchor | ask | constrain`), `weight`,
`lLit`, and `rLit` all live only on the parser-side legacy `Atom`
case: `splitRule` consumes `weight` by folding it into the consumer
`_agg-result` pattern's terms; the decomposition pass consumes
`lLit`/`rLit` by emitting `Equal`s and `marker` by emitting the right
desugaring. None survive into the post-expand IR.

### `id` is gone from the post-expand IR

Today's `RuleAtom.id` carries three things: `id.l`, `id.r` (slot Variables
the runtime binds to the matched/emitted endpoints) and `id.chain` (a
template the runtime instantiates against the trail to build fresh-id /
fresh-mom / fresh-choose terms for subsequent atoms).

In the new IR all three are subsumed:

- `id.l` / `id.r` *are* the `Match.l` / `Match.r` (or `Emit.l` /
  `Emit.r`) terms. For a `Match`, the matched tuple's endpoints unify
  into those Variables; for an `Emit`, the `Equal`s emitted by
  decomposition bind them to fresh moment templates. The slot lookup
  the runtime did via `bindIdSlots` is just trail unification now.
- `id.chain` is consumed at *expand time* by the shared template
  builder. Each downstream atom's fresh-id / fresh-mom / fresh-choose
  template is materialized as an `Id` term with the chain Variables
  (the `_l_<k>` / `_r_<k>` of earlier matches plus user vars in
  scope) baked in, then bound via `Equal` at the synthesis site. The
  evaluator's existing `Equal` path resolves those chain Variables
  through the trail and produces the same hashconsed values.

So `Match` and `Emit` carry no `id` field. `bindIdSlots`, `bindUnbound`,
`instantiatedIdTerms`, `freshIdTerm`, `freshChooseId`, `freshMoment`
all leave `eval.ts`.

### Anchor as ordinary variables

The implicit anchor stack is replaced by SSA-style running-anchor
variables threaded through the body. Each rule body opens with `XL₀`
bound to `bot` and `XR₀` bound to `top` (the evaluator binds these on
the trail before walking). Each constraint that updates the running
anchor (a `Max` / `Min` for the new endpoint) introduces fresh
`XL_k` / `XR_k`. Subsequent atoms textually reference whichever pair
is currently in scope.

### Moment / chooseId templates at expand time

Today's `freshMoment(a, ctx, "l"|"r")`, `freshChooseId(a, ctx)`, and
`freshIdTerm(a, ctx, varName)` instantiate `id.chain` against the trail
at eval time. We move construction of the *template* (the `Id`-tagged
term whose body still contains `Variable`s) to expand, and bind it via
`Equal` whose RHS is that template. The evaluator's existing `Equal`
path resolves the embedded `Variable`s through the trail and produces
identical hashconsed values — fingerprint identity is preserved.

These three helpers should be unified into one shared template builder
in expand, parameterized on head sym (`*mom` / `*choose` / `*id`) and
optional trailing discriminator (`l`/`r`/varName). They differ only in
those two pieces.

## End state — desugaring rules

Notation:
- `XL/XR` = the running anchor variables in scope.
- `<l>, <r>` = fresh `Variable`s synthesized by expand (one pair per atom).
- `<m>` = fresh `*mom` template — an `Id` term `(*mom rule lexPos V1 …
  Vk side)` with the chain `Variable`s left in place; bound via `Equal`.

### Match `- a`

```
[<l>, <r>] a            -- bind matched tuple's endpoints
le XL <r>
le <l> XR
max XL <l>  -> XL'
min XR <r>  -> XR'
```

For a chain `a, b`:

```
[al, ar] a
le XL ar
le al XR
max XL al -> XL1
min XR ar -> XR1

[bl, br] b
le XL1 br
le bl XR1
max XL1 bl -> XL2
min XR1 br -> XR2
```

### Match with literal endpoints (`lLit` / `rLit` today)

`lLit` / `rLit` are removed from `Match`. Today's prefix-elision
emission becomes an `Equal` against the literal:

```
[<l>, <r>] a
= <l> <litL>
= <r> <litR>
```

### Emit `+ a` (fact)

```
= bl <m_l>              -- fresh-moment template
assert-lt XL bl
assert-lt bl XR
emit [bl, top] a
max XL bl -> XL'
min XR top -> XR'
```

### Emit `~ a` (episode)

```
= el <m_l>
= er <m_r>
assert-lt XL el
assert-lt el er
assert-lt er XR
emit [el, er] a
max XL el -> XL'
min XR er -> XR'
```

### Emit `^ a` (anchor)

```
emit [XL, XR] a
```

(No fresh moments, no anchor edges, no anchor update.)

### Ask `? a` and Constrain `! a`

Endpoint construction decomposes like a `+`. The wrapped row is built
in expand using the shared template builder: `<chooseId>` is a `*choose`
template, and any unbound user variables in the wrapped atom are bound
via `Equal`s to `*id` templates (matching today's `bindUnbound`-at-eval
behavior, just hoisted).

```
= cl <m_l>
assert-lt XL cl
assert-lt cl XR
emit [cl, top] (_choose <chooseId> <wrappedAtom>)
max XL cl -> XL'
min XR top -> XR'
```

`Constrain` is the same shape, emitting `(_constrain <wrappedAtom>)`.

The "is this row a choose / constrain?" check the scheduler does is
unchanged — it inspects stored row terms.

### Sub-rule `(...)` and `(...);` — Sub elimination

`Sub` is consumed by the decomposition pass and does not appear in the
post-expand IR. The pass uses `Sub` purely as a traversal guide; once
the right `Le` / `Max` / `Min` / `AssertLt` items are spliced in, the
`Sub` wrapper is dropped and its body is inlined into the outer atom
list.

The pass is a recursive function

```
decompose(body, XL_in, XR_in) -> { atoms, XL_out, XR_out }
```

For non-Sub atoms it emits the desugaring above and returns the new
running anchor. For a `Sub { body, sequence }` at running anchor
`(XL, XR)`:

1. Recurse: `decompose(body, XL, XR) -> { innerAtoms, XL_in_end,
   XR_in_end }`. The inner inherits the outer's running anchor; no
   copy needed.
2. Splice `innerAtoms` into the outer output. There is no `Sub` in
   the result.
3. Determine the running anchor for the next outer atom:
   - **`)` (non-sequence).** Continue with the pre-Sub `(XL, XR)`. The
     inner's anchor updates were scoped to fresh SSA vars and don't
     leak; outer atoms textually reference the pre-Sub `XL`/`XR`.
   - **`);` (sequence).** Slide the left endpoint to the inner's exit
     right. Emit `max XL XR_in_end -> XL_seq` after `innerAtoms`, and
     return `(XL_seq, XR)`. The right endpoint is unchanged.

`);` is a one-shot `Max` at expand time, immediately after the inner
atoms — there's no runtime "Sub exit" event. User-named variables
bound inside the inner body still leak as today (the trail is shared);
only the *anchor* state is scoped.

## End state — evaluator

`evalSeq` becomes a flat dispatch:

```
case "Match":     evalMatchPrim(a, ctx, next)
case "Emit":      evalEmit(a, ctx, next)
case "Le":        if (lessEq) next() else fail
case "AssertLt":  addOrder; next()
case "Max":       if (!comparable(a,b)) fail; bind out := lessThan(a,b) ? b : a; next
case "Min":       if (!comparable(a,b)) fail; bind out := lessThan(a,b) ? a : b; next
case "Equal":     unifyTerms(lhs, rhs); next     -- unchanged
```

- `evalMatchPrim` is `evalMatch` with the gen filter, head-index
  lookup, and `unifyAtoms` body, *minus* `intervalsOverlap`,
  `lLit`/`rLit`, the marker dispatch, and the `anchorStack`
  mutation. After `unifyAtoms` succeeds it `unifyTerms`-es the
  tuple's `l`/`r` with the atom's `l`/`r`.
- `evalEmit` interns the atom (whose terms are all already trail-bound
  by upstream `Equal`s), calls `addTuple` with the supplied (ground)
  `l`/`r`. No marker switch, no anchor intersection, no `addOrder`,
  no `bindUnbound`, no `bindIdSlots`.

`anchorStack`, `topAnchor`, the `Sub` push/pop, the marker switch,
`bindIdSlots`, `bindUnbound`, and the fresh-* helpers all leave
`eval.ts`. `Ctx` loses `anchorStack`.

`Max` / `Min` on equal hashconsed args bind `out` to that arg.

## Plan of work

1. **Types.** Add the new `RuleAtom` cases in `ts/src/v2/types.ts`.
   Keep the legacy `tag: "Atom"` case alongside (parser still produces
   it pre-expand). Mark it "pre-expand only".

2. **Shared template builder.** Lift the `*mom` / `*choose` / `*id`
   construction out of `eval.ts` into `expand.ts` as one helper
   parameterized on head sym + optional discriminator. Used by the
   decomposition pass.

3. **`expand.ts` — anchor decomposition.** New pass after `splitRule`
   and `generateDeltaVariants`, before `assignIds`:
   - Recursive `decompose(body, XL, XR)` per the algorithm above.
   - Generate fresh `Variable` names with a per-rule counter
     (`_xl_<k>`, `_xr_<k>`, `_l_<k>`, `_r_<k>`).
   - For Subs: recurse, splice, and emit the post-Sub `Max` for
     `sequence: true`.
   - For each `Emit`'s fresh moments: `Equal` against a `*mom`
     template from the shared builder.
   - For Ask/Constrain: build the `_choose` / `_constrain` row's
     terms in expand using the shared builder.

4. **`assignIds` is gone.** Its job is folded into anchor decomposition
   — the same scope walk that thread the running anchor also numbers
   `Match`/`Emit` atoms (assigning their `_l_<k>` / `_r_<k>` Variables
   directly into `Match.l` / `Match.r` / `Emit.l` / `Emit.r`) and
   accumulates the chain that the template builder uses to materialize
   fresh-* templates. Synthetic vars introduced by decomposition itself
   (anchor vars, etc.) are not part of any chain.

5. **`eval.ts`.** Add the new dispatch cases. Rip out `anchorStack`,
   `topAnchor`, the Sub push/pop, and the marker switch. The legacy
   `evalAsk` / `evalConstrain` / `evalAssert` paths can stay
   *temporarily* alongside as a safety net during migration; delete
   once tests pass.

6. **Stats.** `candPassedOverlap` becomes meaningless — drop it (or
   rename to `candPassedEndpointUnify` if we want a counter for the
   step where bound endpoint vars unify with the tuple's `l`/`r`).
   Other counters move into `evalMatchPrim` unchanged.

7. **Tests.** `./run-tests.sh`. The `v2_click` test plus the ttt
   example exercise Ask / Constrain / episodes / facts / overlap, so
   passing those is a strong signal.

## Migration

Two-phase to avoid a giant single PR. Phase 1 lands all the new IR
cases, the expand pass, and the new evaluator dispatch alongside the
legacy paths. Phase 2 deletes the legacy `tag: "Atom"` case, the
marker switch in eval, and the leftover assert helpers once tests are
green end-to-end.

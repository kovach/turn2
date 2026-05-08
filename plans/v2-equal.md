# v2 `= A B` equality / unification atom

Add v1's `=` line construct to v2. `= A B` is a body entry that unifies two
terms against the current substitution, succeeding (and possibly binding
variables) or failing the current branch. It does not match a stored tuple,
emit one, or modify the anchor.

Ref: v1 implementation in `ts/src/parse.ts:92-102`, `ts/src/types.ts:63,144,223`,
`ts/src/lower.ts:32,50-53`, `ts/src/unify.ts:343-349`.

## Surface syntax

A body entry whose first non-space char is `=` is an equality atom. It must
contain exactly two terms.

```
play-card E
it E Card
= Card (the-card)        -- pin Card to a specific compound
~ move Card play-area
```

Multiple per line via `,` works the same as other atoms:
`it E C, = C foo, ~ move C play-area`.

Equality is a leaf — no `Sub` body, no `weight`, no nested children. It can
appear anywhere a regular atom can, including inside `( ... )` sub-rules.

## IR

Extend `RuleAtom` in `ts/src/v2/types.ts` with a third variant:

```ts
export type RuleAtom =
  | { tag: "Atom"; ... }
  | { tag: "Sub"; ... }
  | { tag: "Equal"; lhs: Term; rhs: Term; span: Span };
```

No `id`, `marker`, `weight`, `l/rLit`, or `chain` — Equal carries no
identity, doesn't participate in moment construction, and doesn't pin a
matched tuple.

Update the type predicates `isMatchAtom` / `isAssertAtom` (file:`types.ts`):
both return `false` for `tag: "Equal"`.

## Parser changes — `ts/src/v2/parse.ts`

1. **`isMarkerChar`** (line 34): add `ch === "="`. (Note: this only fires when
   `=` is the *first* char of an atom-text, so `(=...)` inside a term is
   unaffected — `=` is not a term token.)
2. **`markerOf`** (line 38): map `"="` → a sentinel marker, e.g. `"equal"`.
   Adding `"equal"` to the `Marker` union solely for parser dispatch is
   acceptable; the eval-time `Marker` only matters for `tag: "Atom"` so the
   union grows but stays well-typed if we keep the variant tagged differently.
   Alternative (preferred): keep `Marker` unchanged and detect `=` directly in
   `tokenize` — emit a distinct token `{ tag: "equal"; text: string; line }`.
   The distinct-token route avoids polluting `Marker`; the rest of this plan
   assumes it.
3. **`tokenize`**: when `atomStart && ch === "="` (and the next char is whitespace
   or end-of-text — i.e. not part of a longer symbol), read the rest of the
   atom (same balanced-paren scan as the existing atom-text reader, stopping
   at top-level `,` or `)`), and emit `{ tag: "equal", text, line }`.
4. **`parseProgram`**: when consuming tokens for a rule body, on a token of
   tag `"equal"` call a new `parseEqualText(text, line)` and push the result
   onto the current `stack[stack.length - 1]`.
5. **`parseEqualText`**: tokenize the text via `tokenizeTermText`, run
   `parseTerms`, require exactly two terms, return
   `{ tag: "Equal", lhs, rhs, span: { line } }` or a `ParseError`.
6. No reserved-head-sym check (Equal has no head sym position).
7. No weight: reject `->` inside `=` text with a `ParseError`
   (`"'=' line cannot carry a '-> weight'"`).

### Errors

- `"'=' atom must have exactly two terms, got <n>"`
- `"'=' atom cannot carry '-> weight'"`

## Expand changes — `ts/src/v2/expand.ts`

1. **`assignIds`** (line 52): in `walk`, when `a.tag === "Equal"`, do not
   advance `lexPos` and do not assign `id`, but **do** collect free
   variables from `lhs` and `rhs` via `collectVars`. This is what makes
   downstream `id.chain` templates include any user variables that an Equal
   may have introduced (or referenced for the first time). Same for-loop
   shape as the `Sub` case but using `collectVars` instead of recursing into
   a body.
2. **`splitRule`** / **`findTopWeightedMatch`** (lines 110, 168): Equal is
   never a weighted match — skip it (the `if (a.tag === "Atom" && ...)`
   guard already does the right thing; just confirm the branch types compile
   with the new variant).
3. **`containsWeightedMatch`** (line 179): same — skip the Equal variant.

## Eval changes — `ts/src/v2/eval.ts`

In `evalSeq` (line 48), add a branch before the `marker` switch:

```ts
if (a.tag === "Equal") {
  const added: string[] = [];
  if (unifyOne(a.lhs, a.rhs, ctx, added)) {
    next();
  }
  revert(ctx, added);
  return;
}
```

`unifyOne` (line 276) already implements the trial-substitution merge that
v2 needs: walk both terms under the current `subst`, structurally unify, and
on success commit only the *new* bindings into `ctx.subst` so `revert` can
undo them on backtrack. No anchor change, no `bindIdSlots`, no `addTuple`.

### Bindings semantics

`unifyTerms` (line 288) already handles the cases we need:

- `= X foo` with `X` unbound — binds `X := foo`.
- `= X Y` both unbound — aliases (`subst.set(X, Y)`).
- `= foo foo` — succeeds without binding.
- `= foo bar` — fails (Symbol/Symbol mismatch).
- `= (f X) (f bar)` — structural unify, binds `X := bar`.
- Hashconsed `Ref` terms compare by id; mixed `Ref`/`Atom` walk one level via
  `expandSeq`. Same behavior as match-atom unification.

Wildcards (`_`) succeed silently and bind nothing — consistent with `unifyTerms`.

## Print / formatter

If a v2 surface-syntax printer is added later (currently `print.ts` only
renders terms, not rule bodies), render an Equal entry as `= <lhs> <rhs>`.
No change needed today.

## Tests — `ts/src/tests/v2_eval.test.ts`

Add cases:

1. **Bind via equality**: rule `foo X, = X bar, + saw X` against a store with
   `foo bar` and `foo baz`. Expect exactly one `saw bar` row.
2. **Aliasing**: `foo X, foo Y, = X Y, + same X` over `foo a, foo b`. Expect
   `same a`, `same b` (only the diagonal pairs).
3. **Failure prunes branch**: `foo X, = X bar` over `foo baz` produces no
   downstream effects.
4. **Structural unification**: `foo X, = X (a Y), + got Y` over `foo (a 1)`,
   `foo b`. Expect `got 1` only.
5. **Equal inside Sub**: `foo X ( = X bar, + ok )` — Equal scoped inside a
   sub-rule still binds and the binding is visible to subsequent atoms in
   the same sub-rule.
6. **Chain inclusion**: an Equal that introduces a fresh user variable used
   later by an `id.chain` should make the resulting `*id` term depend on
   that binding. (Construct a rule where two distinct `=` bindings would
   otherwise collide chooseIds, and assert the resulting `*choose` ids
   differ.)
7. **Parser errors**: `= X` (one term), `= X Y Z` (three), `= X -> 2`
   (weighted). All return `ParseError` with the expected line number.

## Out of scope

- Disequality (`!=`) — not in v1 either.
- Unification across `Ref` boundaries with binding propagation into the
  hashconsed body. The existing `expandSeq` traversal already does as much
  as match-atoms do; extending it is a separate refactor.

## Ambiguities / open questions

1. **`=` as the very first char of a Symbol token.** v1's tokenizer reads
   `=` only at line-prefix; in v2 the marker is detected at *atom-start*
   inside `tokenize` (after `(`, after `,`, or at line start). Need to
   confirm that no current term syntax begins a top-level atom with `=`. If
   a future Symbol like `=foo` is ever wanted, the `=` marker would shadow
   it; that seems fine (matches v1's restriction) but worth flagging.

   symbols like `=foo` are fine; only parse as equality if `= ` includes space

3. **Binding-order semantics with later Equals.** v1 treats Equal as part
   of the matching prefix (lower.ts:50-53), which means it runs in
   tree-order alongside Match/Before/Overlap. v2's `evalSeq` is already
   left-to-right, so Equal at body position `i` runs after atom `i-1` and
   before atom `i+1`. This matches v1's intent — no special re-ordering
   needed. Worth a comment in `eval.ts` near the new branch so future
   readers don't try to "optimize" Equal earlier or later.

5. **Should `=` accept `_` on either side?** `unifyTerms` makes wildcards
   succeed unconditionally; `= _ _` is a vacuous success and `= _ X` binds
   nothing. v1 has the same property. Probably fine; document it in the
   commit message rather than reject at parse time.

   sure

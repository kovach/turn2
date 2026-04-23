# Eliminate `Variable` terms in asserted output

## Motivation

Rules can assert atoms that mention a variable which has no prior binder in
the pattern. At runtime the unifier happily substitutes whatever bindings
are known, and any free variable survives into the reference store as a
literal `Variable` term. That's observable in the output tree, confuses
hashconsing (two distinct asserts both contain `Variable("V")`, wrongly
comparing equal), and makes no semantic sense — a free variable in an
assertion denotes "some value I never pinned down."

The narrowest fix: at rule-build time, detect any variable whose first
pre-order mention is inside an `Assert` (`+`) or `Ask` (`?`) node, and
replace it with a fresh id atom that is guaranteed ground at match time
(because its tail is the positive's own `previousVars`).

## Analysis: which variables to rewrite

The helper lives today in `ts/src/ask.ts` as `varsBoundByAssertOrAsk`.
Move the logic into `ts/src/expand.ts` (delete `ask.ts`), extend it to
return the *binder node* alongside the variable name, and apply it after
`expand` has produced its per-target rules.

Scoping rules (same as the earlier draft):

- A node's `id` is **not** consulted — ids are constructed by `idExpand`
  and are either ground (positive id atoms) or bound by the tree shape
  at match time (auto-`X` vars on Match/Before/Overlap).
- For `Aggregate` nodes, only `info.out` counts as an "outgoing" binding;
  `info.args` and `atom.terms` are ignored, and the aggregate's children
  are not descended into (their bindings are scoped to the fold).
- For every other node, scan `literal.atom.terms`.

A pre-order walk tracks a `seen: Set<string>` of variables already
mentioned earlier in the tree. At each node, the set of *newly* mentioned
variables is the variables in its scanned terms minus `seen`. If the node
is `Assert` or `Ask`, those newly mentioned variables are the ones we need
to rewrite. Add all mentions (new or not) to `seen` before descending.

Return value shape (rough):

```ts
interface UnboundAtNode {
  node: Tree;           // the Assert/Ask (or Aggregate) binder
  vars: string[];       // variable names first mentioned here
}
function findUnboundInPositives(rule: Tree): UnboundAtNode[]
```

The caller gets everything it needs to rewrite in one pass.

### Aggregate caveat

The rewrite cares about `Assert` and `Ask` specifically. An unbound
variable whose first mention is `info.out` of an `Aggregate` is a
different problem (and probably a user error — the fold has no value to
emit). First pass: ignore it; second pass: optionally diagnose. Note in
code which case we're punting.

## Rewrite: fresh id atoms

For each unbound variable `V` attached to a binder node `N`:

- Do **not** parse `N.id` to recover `previousVars`. Instead, factor the
  previousVars-collecting walk out of `idExpand` into a shared helper
  and re-run it on the expanded rule, stopping when it reaches `N`. The
  helper walks pre-order, pushes `bindsId` node ids into the list, and
  yields the snapshot at each positive — same contract as `idExpand`'s
  `previousVars` today. This keeps the previousVars definition in one
  place and tolerates user-provided non-auto ids (`+[myId] …`) because
  those are never read off the id here.
- Synthesize a fresh `lineSym'` via a new module-level `rewriteCounter`,
  reset alongside `expandCounter` inside `expandAll`. (Separate from
  `expandCounter` to keep the rewrite decoupled from expand's counter
  discipline; global uniqueness per compile is all we need.)
- Build the replacement atom:
  ```ts
  const idAtom: Term = {
    tag: "Atom",
    atom: { terms: [sym("id"), name, freshLineSym, ...previousVars] },
  };
  ```
  where `previousVars` comes from the helper above and `name` is
  recovered by scanning the rule for any positive-id atom and reading
  its `terms[1]` (the rule name is constant across all positives in a
  rule; reading `name` off an id is fine — the user's restriction is
  specifically about `previousVars`). Reusing the rule name keeps
  rewritten atoms in the same namespace (`(id r1 …)`) as everything else
  asserted by the rule — no downstream code distinguishes the fresh
  lineSym from the original `idN`.

- Substitute `V → idAtom` in `N.literal.atom` using `substAtom` (same
  mechanism `idExpand` uses at line 32). A single-entry trail suffices;
  the invariant note at `expand.ts:28` applies — this trail is local and
  doesn't participate in fixpoint matching.

- Add `V → idAtom` to a running substitution so that any *later* node in
  the rule that references `V` sees the same id atom. In practice each
  expanded rule has one positive target as a leaf, so this collision is
  rare; but `buildAggRule2` produces rules with both a Match target and
  an `aggBinding` Assert child, so we do need to propagate.

Important: each distinct unbound variable gets its **own** fresh lineSym.
Two different unbound vars within one node must not collapse to the same
id atom. Two occurrences of the *same* variable must collapse (so we
substitute once, everywhere).

## Where to invoke

`expandAll` / `expandAllWithDeltaVariants` produce the final rule set
consumed by the fixpoint. Add a post-pass:

```ts
function rewriteUnboundAssertVars(rule: Tree): Tree { ... }

export function expandAll(patterns: Tree[]): Tree[] {
  expandCounter = 0;
  return patterns.flatMap(expand).map(rewriteUnboundAssertVars);
}
```

Run *after* `expand`, *before* `generateDeltaVariants`. Delta variants
only touch `literalType.constraint`, so their atoms and ids are already
final; running the rewrite before delta expansion means it executes
N times instead of N × matchCount.

## Tests

Add to `ts/src/expand.test.ts`:

1. **Baseline rewrite**: a pattern like
   ```
   - a X
     + b Y
   ```
   after expansion has `+ b Y` as the target. `Y` is never mentioned
   before, so the rewritten rule has `+ b (id <name> <lineSym'> X1)` in
   place of `Y` (where `X1` is the auto-id for the `- a X` Match node).
2. **Multiple unbound vars**: `+ b V W` gets two *distinct* fresh id
   atoms.
3. **Repeated occurrence**: `+ b V V` substitutes once, producing two
   identical id-atom occurrences (so they unify to the same runtime ref).
4. **Already bound**: `+ b X` where `X` is bound by an earlier Match
   stays untouched.
5. **Aggregate arg**: a rule from `buildAggRule2` whose `aggBinding`
   references a variable bound by a preceding `localPattern` Match —
   confirm no rewrite is applied (the var is already in `seen`).
6. **Ask**: same as (1) but with `? b Y`.

End-to-end in `ts/src/fixpoint.test.ts`: write a rule whose naive output
would contain a `Variable` term; after the fix, assert that
`refStoreToTree` produces no Variable-tagged terms anywhere under the
root.

## Order of work

1. Delete `ts/src/ask.ts`.
2. Add `findUnboundInPositives` and `rewriteUnboundAssertVars` to
   `ts/src/expand.ts`.
3. Thread them through `expandAll` / `expandAllWithDeltaVariants`.
4. Tests (expand-level first, then fixpoint-level).

## Decisions (folded in)

- **Counter scope.** New `rewriteCounter`, module-level, reset alongside
  `expandCounter` in `expandAll`.
- **`name` symbol reuse.** Reuse the rule name; no downstream code
  distinguishes fresh lineSyms from `idExpand`'s `idN`.
- **Non-auto ids** (`+[myId] …`). Don't parse `previousVars` off any id;
  always recompute via the extracted-from-`idExpand` helper. This path
  handles user-provided ids transparently.
- **`Equal` / `Constrain`.** Out of scope. `Equal` is negative; `Constrain`
  is a check, not an assertion — if it mentions an unbound variable that's
  a user error to diagnose, not silently patch. Rewrite applies to
  `Assert` and `Ask` only.
- **Aggregate `info.out` unbound.** Out of scope for first pass; flag as
  a follow-up (likely a user error anyway).
- **`buildAggRule2`'s synthesized `aggBinding`.** Treated uniformly with
  user-written Asserts. Its `info.args` are bound by `localPattern`
  siblings that precede it in the child list, so the pre-order walk sees
  them in `seen` before reaching `aggBinding` and the rewrite is a
  correctness no-op. Covered by test case (5).

## Remaining ambiguities

None material. One minor item worth confirming at implementation time:
after the rewrite substitutes `V → idAtom` in the positive's atom, the
running substitution should also apply to any later node in the rule
that references `V`. In practice expanded rules have at most one Assert
(the target, or `buildAggRule2`'s `aggBinding`) and it's effectively a
leaf, so the "later node" case is vacuous; still, implementing it as a
running trail (rather than a single-node local rewrite) is cheap and
forward-compatible.

do that (substitute into any following atoms)

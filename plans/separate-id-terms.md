# Separate id terms from Atom

## Goal

Introduce a distinct `Id` Term constructor for the synthetic `(id …)`
atoms produced by expansion, so that "this term is an opaque id" becomes
a *type* fact rather than a *string-shape* fact. The immediate payoff is
that walkers across the codebase can choose, per-call, whether to
descend through ids — and the structural-walk sites that currently risk
exponential traversal (because id bodies share their `previousVars`
chain) can stop at the `Id` boundary safely.

This plan merges two previously separate goals:

1. **Term-type refactor** (notes/overview.md "separate id terms from
   atom"): add `| { tag: "Id"; atom: Atom }` to the `Term` union.
2. **`unresolvedTermsTouched` fix**: stop descending into id atoms when
   collecting unresolved choice keys from a Constrain row's terms.
   Goal #2 falls out of goal #1 once walkers learn the new tag.

## Why merge

The standalone "fix `unresolvedTermsTouched`" plan was going to inline a
custom walker that pattern-matches on a string-headed `(id …)` shape.
That works as a point fix but encodes the distinction in *one* place,
leaves `walkTermDeep` and `fringeOf` exposed to the same hazard, and
makes it harder to reason about which walks are id-safe. Doing the
type-level split first turns "is this an id?" into a tag check that
every walker can ask, and makes id-descent an explicit per-call choice
rather than the silent default.

## Current shape

- `Term` is `Symbol | Variable | Atom | Ref | Wildcard | …` (see
  `ts/src/types.ts`).
- Id atoms are constructed in `expand.ts:458` as
  `{ tag: "Atom", atom: { terms: [sym("id"), sym(name), sym("id"+N), …previousVars] } }`.
- They get hashconsed like any other Atom (`hashconsTerm`), so in the
  store they appear as `Ref`s whose `refToAtom` body's first term is
  `(Symbol "id")`.
- The only place that recognises them today is `web.ts:46`'s private
  `isIdHeaded(atom)` helper, which string-compares
  `atom.terms[0]` against `Symbol "id"`. Other callers descend
  blindly.
- `walkTermDeep` (`fringe.ts:16`) recurses through every `Atom` and
  `Ref` body without checking whether it's an id, which is what
  motivates the `unresolvedTermsTouched` fix.

## Target shape

- `Term` gains a new variant: `| { tag: "Id"; atom: Atom }`. The body
  layout (`(id name idN previousVars…)`) is unchanged; only the tag
  differs from the regular `Atom` case.
- Every site that currently constructs an id-headed atom builds it with
  `tag: "Id"` instead of `tag: "Atom"`. The convention "no `Atom` is
  built with `(Symbol "id")` as `terms[0]`" is kept as a code-hygiene
  rule but is *not* load-bearing for hashcons correctness — see §3.
- Hashcons stores id bodies in the same `refToAtom` map but the *value*
  type widens from `Atom` to `Atom | Id`. A `Ref`'s body therefore
  carries the original tag, and walkers that look up a Ref's body get
  the discriminator for free.
- Walkers are updated to discriminate:
  - `walkTermDeep`: by default, descend into `Atom`/Atom-bodied `Ref`,
    visit-but-don't-descend on `Id`/Id-bodied `Ref`. Add an explicit
    `descendIntoIds: true` opt-in for any caller that genuinely needs
    full depth.
  - `unresolvedTermsTouched` (`constraint-query.ts:67`): inherits the
    new default — no further changes needed beyond the tag check.
  - `fringeOf` (`fringe.ts:35`): no callers — delete during step 5.
  - Anywhere else that recursively unfolds a `Term` (`substAtom`,
    `applySubst`, `compressRefs`, `expandTerm`, `renderTerm`, …): audit
    individually; most should treat `Id` like `Atom` for descent (these
    operate on user terms during pattern matching, where ids appear as
    leaves), but each call site must be reviewed.
- `isIdHeaded` is deleted. Where the predicate was needed, check
  `term.tag === "Id"` (or `body.tag === "Id"` when looking at a
  `Ref`'s body via `refToAtom`).

## Migration steps

Each step keeps the build green so we can stop after any one.

1. **Add the type, no constructors yet.** Extend `Term` in
   `types.ts` with the new `Id` case. Add a helper `idTerm(atom)`
   constructor and a type-guard `isId`. Run typecheck — exhaustive
   `switch (term.tag)` blocks now error; add `case "Id":` placeholders
   that fall through to the same behaviour as `case "Atom":`. This is
   a no-op semantically; it just opens the surface area.

2. **Flip the construction site.** In `expand.ts:458`, replace the
   `{ tag: "Atom", … }` literal with the `Id` constructor. Now id
   bodies enter `hashconsTerm` as `Id` terms.

3. **Widen hashcons.** Update `refToAtom` to store `Atom | Id`. The
   `Term` value on the heap keeps its real `tag: "Atom" | "Id"`
   discriminator; the change here is purely about how the *hashcons
   key* is derived so two terms with the same body but different tags
   never collide.

   **Keying scheme (symmetric prefix).** When `hashconsTerm` computes
   the key for the body it prepends a synthetic head sym derived from
   the term's tag:
   - regular `Atom` body `(foo bar)` → keyed as `(*atom* foo bar)`
   - `Id` body `(id x …)` → keyed as `(*id* id x …)`

   The exact spelling of the prefix syms (`*atom*` / `*id*`) is an
   implementation detail; what matters is that they cannot collide
   with any user-writable symbol. Pick names containing a character
   the parser rejects in symbol positions so a future regression
   can't synthesise them by accident.

   This keeps a single `refToAtom` map and a single Ref id-space —
   `Ref.id` is unchanged — and the on-the-heap `Term` retains its real
   tag. Only the bytes that feed the hash function gain the prefix.

   No leak guard is needed under this scheme: an `Atom` whose first
   term is literally `(Symbol "id")` would key as `(*atom* id …)` and
   stay distinct from `(*id* id …)`. (Still worth keeping the
   construction-site invariant — "no `Atom` is built with `(Symbol
   "id")` as `terms[0]`" — as a code-hygiene rule, but it's no longer
   load-bearing for hashcons correctness.)

4. **Delete `isIdHeaded`** and rewrite each call site to test
   `term.tag === "Id"` or `body.tag === "Id"`.

5. **Update `walkTermDeep` and delete `fringeOf`.**
   - Flip `walkTermDeep`'s default to "stop at `Id`". If any caller
     genuinely needs full depth, add an explicit `descendIntoIds: true`
     opt-in (audit current callers — likely none need it).
   - Delete `fringeOf` and its associated comment block (no callers in
     `ts/src/`).

6. **Audit other walkers.** Specifically:
   `substAtom`, `applySubst`, `compressRefs`, `expandTerm`,
   `renderTerm`, `renderTerm`-like helpers in `web.ts`, anything in
   `unify.ts` that destructures a `Term`. For each, decide and
   document whether it should descend into `Id`. Default expectation:
   id bodies are opaque tokens at this layer, so most callers stop.

7. **Verify the original motivating fix.** With the walker default
   flipped, `unresolvedTermsTouched` automatically no longer recurses
   through id atoms. Confirm by inspection that the function body now
   contains zero references to id-related logic — it just delegates to
   `walkTermDeep`. Add a focused test that builds a Constrain row
   referencing a choice term wrapped in an id atom whose
   `previousVars` chain also references *another* choice term, and
   asserts that only the surface choice term is returned.

8. **Performance check** (optional but cheap given step 7's test
   shape). Run the ttt profile before and after: any program with deep
   `previousVars` chains should show a measurable drop in
   constraint-query / fringe time.

## What this does *not* change

- `Atom` semantics for non-id terms. User compound values like
  `(cell R C)` keep their `tag: "Atom"` and behave identically.
- The hashcons protocol for non-id atoms.
- The textual / parser surface — `id` atoms are never written by the
  user, so no syntactic change.
- The `Tree` type or any per-row `tag` (Assert/Constrain/etc.).

## Open questions / ambiguities

- **Round-tripping id bodies through `Atom`.** Need a grep before
  step 2 for code that builds `{ tag: "Atom", atom: ... }` from
  arbitrary `Term[]` (e.g. a generic substitutor that strips and
  rewraps without preserving tag). The symmetric-prefix keying makes
  this *correctness*-safe — an id body re-wrapped as `Atom` would
  hashcons to a different Ref and stay distinct — but it's still a
  *semantic* bug if it happens, since the rewrapped term loses its
  "opaque to walkers" status. Each such site needs to learn `Id`.

  do the grep

- **`fringeOf` is unused.** Confirmed via `grep`: no callers in
  `ts/src/`. Dead code; delete it as part of step 5 (or sooner).
  This dissolves the "does anything depend on id-interior descent"
  question — the only consumer of `walkTermDeep` that still descends
  blindly is `unresolvedTermsTouched`, which is the motivating fix.

  yep, remove it

- **Migration ordering risk.** Steps 1 and 2 leave the codebase in a
  state where `Id` terms exist but most walkers still treat them as
  `Atom` (via the fall-through case added in step 1). That's
  intentionally a no-op so the build stays green, but it means the
  performance / correctness wins from this refactor only land after
  step 5. Worth a single commit boundary at step 5 so a bisect can
  cleanly attribute behaviour changes.

  do it all at once, no need for separate commit

- **Naming of the predicate replacement.** `isIdHeaded(atom: Atom)` was
  awkward (it took an Atom, but the question really wanted a Term).
  After the refactor the natural form is `t.tag === "Id"`. Consider
  whether to add a thin `isId(t: Term): t is { tag: "Id"; atom: Atom }`
  type guard for readability at call sites, or inline the comparison.
  Mild preference for the helper to keep grep-ability.

  ok

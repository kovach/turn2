# v2 — tag compiler-generated identity terms as `Id`

## Goal

Make the "ids are opaque to execution" invariant from `notes/v2-design.md`
hold by construction. Today every compiler-generated identity term in v2
is built as `{ tag: "Atom", … }` and so is indistinguishable from a data
atom at the unifier and at every traversal site. Switch the tag to `Id`
at the point of construction so that:

1. The unifier's existing Atom-vs-Id refusal does the right thing for
   identity terms without any per-call discipline at call sites.
2. Traversals that need to stop at id boundaries (currently:
   `activeTokensIn`; later: anything else that walks compound bodies)
   can do so via a one-line `refTagOf(...) === "Id"` check.
3. Future code can't reintroduce exponential unfolding by accident —
   the type tag carries the invariant.

## Construction sites to convert

All of these currently produce `{ tag: "Atom", … }` and should produce
`{ tag: "Id", … }` instead, then immediately go through `hashconsTerm`
so the resulting `Ref` carries the `Id` backing tag.

1. `ts/src/v2/eval.ts`
   - `freshIdTerm` (line 314) — `(*id …)` for unbound assert/ask/constrain vars.
   - `freshChooseId` (line 323) — `(*choose …)` for choice correlation.
   - `freshMoment` (line 331) — `(*mom …)` for fresh interval endpoints.

2. `ts/src/v2/expand.ts`
   - The `id.chain` template attached to each rule-body atom in
     `assignIds` (line 102) — currently `{ tag: "Atom", atom: { terms: chainTerms } }`.

3. `ts/src/v2/expand.ts` aggregate split
   - `aggIdVar` is a `Variable` (line 130) — leaves the evaluator bound
     to whatever `bindUnbound` produces for it. Once `freshIdTerm` emits
     `Id`, the variable will resolve to an `Id`-tagged ref naturally;
     no change needed here.

4. `ts/src/v2/scheduler.ts`
   - `expandRef` (line 122) reconstructs an `Atom`-tagged term from a
     `Ref`. After the refactor it must read `refTagOf(store.hash, term.id)`
     and reconstruct with the same tag. (Today it always uses `"Atom"`,
     which silently changes id terms into atom terms when a caller
     destructures them.)
   - `closeDoAgg` (line 285) builds the `inner` term (`agg-result`'s
     payload). This is the *user-visible* aggregated atom — keep it
     `Atom`-tagged. No change.

5. `ts/src/v2/parse.ts`
   - User-written `(…)` parses to `Atom` (line 322). User syntax is
     data; no change. If we ever want a literal-Id form in source,
     add it as a separate parse production.

## Traversal / consumer sites to audit

Wherever code descends into a compound term's `.atom.terms` (or
unfolds a Ref via `refToAtom`), confirm one of:

- The traversal is execution-relevant → it must stop at `Id` boundaries.
- The traversal is purely presentational (pretty-print) → mark it as
  such with a comment; allow but don't recurse blindly.

Sites to check:

- `ts/src/v2/eval.ts`
  - `bindUnbound` (line 283) — recurses through `Atom`/`Id` sub-terms.
    User-rule patterns can contain `Id` constructors only if the parser
    grows literal Id syntax, so today this path doesn't fire on ids.
    After the refactor, leave the `Id` branch in but never recurse into
    it — fresh-id atoms aren't passed to `bindUnbound`.
  - `instantiatedIdTerms` (line 304) — uses `substTerm` from v1, which
    deep-substitutes through both `Atom` and `Id`. Acceptable: the
    chain template terms are constructed by `expand.assignIds` from
    user-rule variables; we want those variables resolved before
    hashconsing. Note the substitution happens once per chain and
    bottoms out at `Ref`s after binding, so it doesn't trigger
    exponential walks.
- `ts/src/v2/constraint-query.ts`
  - `activeTokensIn` already stops at `Id` Refs. Verify after the
    refactor that the literal-`Id` branch is also handled (currently
    the `Atom`/`Id` literal branch was collapsed to `Atom` only;
    extend to skip `Id` literals too).
  - `unwrapAtom` (around line 108) — used by `gatherConstrainRows`
    to strip the `Atom` wrapper around a constrain row's payload.
    This wrapper stays `Atom`-tagged (it's data); confirm nothing
    in the call chain walks past it into id territory.
- `ts/src/v2/scheduler.ts`
  - `expandRef` — see above.
  - Any other site that reconstructs a literal term from a `Ref`
    must preserve the tag.
- `ts/src/v2/print.ts` — must also respect the id-opacity invariant.
  Render `Id`-tagged refs/literals as an opaque handle (token or
  short hash) and stop the walk. **TODO:** add a folded display
  mode that resolves ids to human-readable labels via lookup
  (e.g. choose-id → originating rule var name) without unfolding
  the id body. Track that work separately from this refactor.
- `ts/src/v2/store.ts` `addTuple` (line 88) — hashconses the outer
  tuple-as-term wrapper. The outer wrapper for a stored tuple is
  fine as `Atom` (it's the data row); sub-terms keep whatever tag
  they were constructed with, which is what we want.

## Step-by-step

1. **Add helpers.** In `ts/src/v2/eval.ts` introduce a tiny
   `idTerm(terms): Term` and use it in `freshIdTerm` /
   `freshChooseId` / `freshMoment`. (Or call `idTerm` from
   `ts/src/types.ts` directly — it already exists at line 197.)

2. **Flip the construction sites in `eval.ts`** (3 returns).

3. **Flip the `id.chain` template in `expand.ts`** (1 site). Update
   any code that pattern-matches on `id.chain.tag === "Atom"` to also
   accept `"Id"`. `instantiatedIdTerms` is the main one; `substTerm`
   handles both tags so it's a single `id.chain.tag !== "Atom" && id.chain.tag !== "Id"` guard.

4. **Fix `scheduler.expandRef`** to read `refTagOf` and rebuild with
   the matching tag.

5. **Re-audit `activeTokensIn`** — extend the existing `Id`-Ref skip
   to also skip literal `Id` terms (drop the descent for `term.tag ===
   "Id"`, keeping it only for `term.tag === "Atom"`).

6. **Run the v2 test suite** — semantic-preserving for everything that
   doesn't accidentally rely on Atom-vs-Id unification of ids and
   data. Expect no regressions.

7. **Spot-check the profile script** — tuple count should not change
   (these are tag-only metadata changes; the unifier already refused
   Atom-vs-Id even though no production code currently constructs
   `Id` ids).

8. **Add a regression test** that asserts the tag of a
   `freshChooseId` / `freshMoment` / `freshIdTerm` after interning is
   `Id` (via `refTagOf` on the resulting `Ref`).

## Risks / open questions

- **Hashcons key collisions.** Hashcons keys include the tag (see
  `tokenOfId` in `ts/src/hashcons.ts`), so two terms with identical
  bodies but different tags get distinct ids. Flipping construction
  tags will give all existing fresh-* terms new hashcons ids. This is
  fine within a single run, but any persisted token (test golden
  files, serialized stores) will shift. Audit the test suite for
  hardcoded token integers; expect none, but check.
- **Print / display fallout.** The web UI currently formats stored
  tuples by walking term bodies. If it can't tell `Id` from `Atom`
  it may render fresh ids in places it didn't before. Confirm
  `print.ts` and `ts/data/v2/ttt-display.js` handle `Id` and degrade
  gracefully (e.g., show a stable short hash for ids).
- **Scope of "compiler-generated".** The plan above lists three
  evaluator helpers and one expand template. If new compiler stages
  appear (e.g. a future seminaive index, an MIR for choice
  enumeration) they should add their own `Id` construction sites —
  the invariant in `notes/v2-design.md` is the source of truth.
- **Ambiguity: aggregate `aggId`.** `expand.splitRule` introduces
  `aggIdVar` as a `Variable`. The producer rule binds it via
  `bindUnbound` → fresh-id, so it ends up `Id`-tagged automatically
  once `freshIdTerm` is flipped. Worth confirming in step 8's test.
- **Ambiguity: choose-row payload.** A `(choose <chooseId> <wrapped>)`
  tuple stores the wrapped data atom (`Atom`-tagged) and the
  correlation id (`Id`-tagged after refactor). Anything that walks
  the *payload* (`activeTokensIn`, etc.) must not descend into the
  id position by accident. The current code accesses `t.atom.terms[1]`
  for the chooseId and `terms[2]` for the wrapped — fine — but a
  generic walker would see both. Document the row layout invariants
  somewhere alongside the wrapper-row schema (probably in the design
  doc once the first walker actually trips on this).

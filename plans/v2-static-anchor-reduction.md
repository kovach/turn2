# v2 static anchor reduction

Simplify `decomposeRule` (ts/src/v2/expand.ts) by removing the `Max`/`Min`
anchor-update atoms whose results are statically determined: the pair
emitted after every fact/episode emit, and the `Max` closing a sequence
(`;`) sub-block. Only `decomposeMatch` keeps its `Max`/`Min` — a matched
tuple's endpoints genuinely have no static ordering relationship to the
running anchor.

## Why the results are static

**Running-anchor validity invariant.** On any trail that reaches a given
body position, `X_L <= X_R` holds for the running anchor, `X_L` is
non-decreasing and `X_R` is non-increasing over the body:

- Initially `(bot, top)`.
- `decomposeMatch` first passes the `Le(X_L, r)` / `Le(l, X_R)` overlap
  guards (failing trails die before the Max/Min run); with the stored
  tuple's own `l <= r`, the intersection `(Max(X_L,l), Min(X_R,r))` is
  again a valid interval, and both updates go through Max/Min that
  include the current value.
- Emits `AssertLt` their fresh moments strictly inside the anchor
  *before* the anchor moves onto them — and `evalAssertLt` calls
  `addOrder`, i.e. it *imposes* edges on the order store rather than
  testing them, so the ordering holds by construction.
- The aggregate consumer's interval equals the prefix anchor by the
  `closeDoAgg` invariant (already exploited: `decomposeAggregate` emits
  no scaffolding).

**Emit case.** After `AssertLt(X_L, l_k)` (fact) the subsequent
`Max(X_L, l_k)` can only pick `l_k`; `Min(X_R, top) = X_R`. After the
episode asserts `X_L < l_k < r_k < X_R`, the pair picks `(l_k, r_k)`.
The anchor case already skips the update.

**Sequence-sub case.** `Max(X_L, inner.X_R)` where `inner` ran starting
from `(X_L, X_R)`: by the invariant, outer `X_L <= inner final X_L <=
inner.X_R`, so the Max always picks `inner.X_R`.

**Comparability check is dead too.** `evalMaxMin` kills the trail on
incomparable arguments, so removing an atom removes that check. It can
never fire here: `lessThanTok` (store.ts:279) answers by DFS
reachability over `orderFwd`, so every true `lessEq` fact corresponds to
a graph path and the composed facts above are found by path
concatenation — the arguments are always comparable when the trail is
alive. (The emit case doesn't even need transitivity: the assert just
added the direct edge.)

## Changes

All in `ts/src/v2/expand.ts`:

1. **`decomposeEmit`**: delete the `updateAnchor` block (the two
   `freshAnchorVar` mints and the `Max`/`Min` pushes). Return statically:
   - fact / ask / constrain: `{ XL: lVar, XR }`
   - episode: `{ XL: lVar, XR: rVar }`
   - anchor: `{ XL, XR }` (unchanged — the `updateAnchor` flag goes away)

   `lVar`/`rVar` are already pushed onto the chain and marked essential,
   so cross-split recovery of the new anchor needs nothing extra; the
   `_xl_k`/`_xr_k` entries simply stop existing.

2. **`decomposeBody`, sequence-sub arm**: replace the `freshAnchorVar` +
   `Max(X_L, inner.X_R)` with `XL = inner.XR`.

3. Keep `freshAnchorVar` (still used by `decomposeMatch`); its comment's
   Sub-closing-`Max` example is gone — reword to reference the match
   intersection.

4. Record the invariant argument as a comment where the code used to
   emit the atoms, so the next reader doesn't re-add them defensively.

## Knock-on effects

- **idTpl fingerprints change.** Every chain snapshot downstream of an
  emit or sequence-sub loses `_xl_k`/`_xr_k` entries, and surviving
  match-minted anchor vars renumber (`anchorCounter` advances less
  often). Ground ids, `--stage` dumps, and any golden/snapshot test
  output containing printed IR or ids will diff. Expected diffs are
  purely: removed `Max`/`Min` lines, shorter `(*chain ...)` templates,
  renumbered `_xl`/`_xr`. Anything else is a bug.
- **`pruneChains` / expand-liveness.ts**: unaffected functionally (it
  now just finds fewer dead anchor-SSA defs to remove); update its
  header comment if it names the emit-generated `Max`/`Min` as a source
  of dead defs.
- **Stale comments**: `types.ts:26-27` lists the per-marker lowering as
  `... + Emit + Max/Min` — update. `DecState.essential`'s comment
  mentions anchor SSA `_xl_K`/`_xr_K` as chain entries; still true (the
  match case mints them) but re-check the wording.
- **`ts/src/v2/overview.md`**: the expand section describes lowering
  markers "into the right combination of Match/Emit/Le/AssertLt/Max/Min/
  Equal" and the `decomposeRule` bullet — adjust to note Max/Min now
  appear only at matches.

## Testing

- Full suite via `./run-tests.sh` (sandbox: `node --import tsx`).
- Update golden outputs; review each diff against the expected-diff
  shape above.
- Sanity-check with the v2-cli `--stage decomposed` dump on a program
  exercising fact, episode, anchor, nested `;(...)` and plain `(...)`
  subs, and an aggregate — confirm the running anchor threads to the
  same *values* as before (endpoints of emitted tuples unchanged modulo
  id-slot contents).

Non-goal: changing `decomposeMatch`'s Max/Min or the `Le` guards — those
are the genuinely dynamic intersection.

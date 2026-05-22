# Default GUI

A bundled `DisplayModule` the v2 editor falls back to when a program
has no `-- display: <file>` directive. It interprets two special
relations (`icon`, `at`) to draw a containment tree, and presents
active choice components as selectable groups whose clicks resolve the
currently *selected* component.

Supersedes the earlier sketch at `plans/v2-default-display.md` (the
shape is the same; this plan adds component selection / per-component
moment rendering and replaces the menu UI with explicit group
highlighting).

## Inputs

Per `run()`, the display receives:

- `store: Store` — current fixpoint store.
- `ctx.components: ComponentOptions[]` — present iff
  `status.kind === "active-choices"`. Each component carries
  `activeTerms: Term[]` and `options: Term[][]` (rows aligned by index).
- We additionally need the **choice component moment** `M_i` for each
  component. `constraint-query.ts:choiceComponentMoment` already
  computes this internally. Expose it: include `moment: Term` on
  `ComponentOptions` (one extra field; computed where `runComponent`
  builds the result).

## Special relations

- `icon T` — render a `<div class="icon">` for term `T`.
- `at X -> L` — if `icon L` also holds, attach `X`'s div as a child of
  `L`'s div. Multiple `at` rows for the same `X` produce multiple
  copies (one per parent). If `L` has no `icon`, attach `X` to the
  top-level container and warn.

Both `icon T` and `at X -> L` are filtered to rows whose interval
contains the selected component's moment `M` (same restriction the
constraint query already applies to `_constrain` rows). Use the
existing helper from `constraint-query.ts` / store indexing.

`L` is the **parent** (container); `X` is rendered inside `L`'s div.

## Layout

Two passes:

1. Walk `byHead.get("icon")` once. For each `icon T` tuple:
   - Find all live `at T -> L` rows (filtered by selected `M`, see
     below). If none, create one top-level div.
   - Otherwise create one div per `at` target.
   - Click handlers are attached identically to every copy.
2. Walk again to attach each div to its parent's div (or the
   top-level container if no parent / parent missing an icon).

Cycle detection: gray/black DFS over the `at`-induced parent edges. On
back-edge, promote the offending icon to top level and warn. Cycles
should be rare; this just prevents the renderer from looping.

Icon ordering inside a parent: by tuple insertion order in
`byHead.get("icon")`.

## Choice components: selection & rendering

When `ctx.components` is non-empty:

- Pick a **selected** component `C_sel`. Default: `components[0]`
  (deterministic, since the array is already ordered by hashcons token
  id). Selection state lives in module scope and is **reset on every
  fixpoint re-run** (i.e. every source edit). Between edits, clicking
  a different group header swaps selection — pure UI state, no
  fixpoint re-run.
- Use `C_sel.moment` as the `M` for the `at` filter described above.
  The DB picture the user sees is the slice the selected choice is
  actually evaluated against.

Per component, render a small *group header* (one row) listing its
active-term labels. Headers stack above the icon container.

- The selected group's header gets `.choice-group.selected`.
- Clicking an unselected group's header sets it as selected and
  re-renders (no fixpoint re-run needed — selection is pure UI state).

## Click → commit

For each rendered icon term `T`, compute candidates against `C_sel`
only:

```ts
candidates(T, C_sel) = { i : exists row r in C_sel.options
                            with tokensEq(r[i], T) }
```

(indices into `C_sel.activeTerms`).

- `|candidates| === 0` → plain icon, no listener.
- `|candidates| === 1` → click emits a length-1 `ClickIntent`
  `{ activeTerms: [C_sel.activeTerms[i]], optionTuple: [T] }`. The
  host's existing `handleClick` inserts `^ is v T` at the cursor.
- `|candidates| ≥ 2` → first click marks the icon "pending" (apply
  `.icon.ambiguous`) and highlights the corresponding active-term
  chips in the group header. A second click on one of those chips
  commits. Clicking the pending icon again clears the pending state.

Pending state lives in module scope alongside `selectedComponent`,
and is cleared on the same trigger: any fixpoint re-run resets it.
Switching selection between components also clears pending (it
belongs to the previously selected component).

Hover (`mouseenter`/`mouseleave`) on any icon with
`|candidates| ≥ 1` toggles `.icon.hot` so the user can see at a glance
which icons satisfy the selected choice.

## Visual states / CSS

- `.icon` — base box.
- `.icon.container` — has at least one child icon.
- `.icon.clickable` — `|candidates| === 1`.
- `.icon.ambiguous` — `|candidates| ≥ 2`.
- `.icon.pending` — first click in a 2+ candidate flow.
- `.icon.hot` — hover highlight.
- `.choice-group` / `.choice-group.selected` — group header rows.
- `.choice-chip` / `.choice-chip.matchable` — active-term chips in
  the header (matchable when a `pending` icon's candidates include
  that chip's variable).

CSS goes in `index-v2.html` alongside the existing display styles.

## Net diff

- `ts/src/v2/default-display.ts` (new): icon iteration, `at` layout,
  candidate computation, render + click wiring, selection state
  (~150 lines — bigger than the prior sketch because of selection/
  pending UI).
- `ts/src/v2/constraint-query.ts`: include `moment: Term` on the
  `ComponentOptions` it returns (one line at the construction site,
  one field in `types.ts`).
- `ts/src/v2/types.ts`: extend `ComponentOptions` with `moment`.
- `ts/src/v2/print.ts`: export shared `tokensEq` (Ref by hashcons id,
  Symbol by name). Refactor `ttt-display.js` to use it.
- `ts/src/web-v2.ts`: `loadDisplay(null)` returns the bundled module
  rather than `null` (~3 lines).
- `index-v2.html`: CSS for the classes above.

No changes to `ClickIntent`, `handleClick`, `compressRefs`, fixpoint.

## Out of scope (deferred)

- Per-component, per-slot menu labels (the `:varName`-in-choose-ID
  trick from the earlier plan). The 2-step ambiguous-click flow makes
  that unnecessary for the common case; revisit if multi-variable
  components feel awkward in practice.
- Animated transitions between selected components.
- Customizing icon ordering beyond insertion order.

## Open questions

- Should `at` cycles ever be legal? Current proposal: treat as a
  warning and promote to top level. Easy to tighten later.
- For very wide groups (many active terms), does the chip header need
  wrapping / scrolling? Defer until we see one.

## Non-issues (resolved)

- Zero-row components: program error, not handled here.
- `at` direction: `L` is the parent.
- Multi-arity candidate semantics: independent rows, candidate sets
  computed per-slot is fine; post-commit feasibility falls out of the
  next fixpoint run.

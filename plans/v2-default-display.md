# Default display

A bundled `DisplayModule` the v2 editor uses when a program has no
`-- display: <file>` directive. Renders any term marked `icon`, lays
them out using `at`, and turns icon clicks into choice commits.

## Special relations

- `icon T` — render a `<div class="icon">` for `T`. All visible things
  are icons; no separate `location` concept.
- `at X -> L` — `#acc` binary relation. If `icon L` holds, render the
  div for `X` inside `L`'s div. Multiple `at` rows for the same `X`
  render `X` once inside each target. If `icon L` is missing, warn and
  render `X` at the top level.

## Layout

Two passes so containers exist before children attach:

1. For every icon `X`, create one div per `at` target (or one top-level
   div if `X` has no `at` row). Click handlers are identical across
   copies.
2. Append each div to its parent icon's div, or to the top-level
   container.

Nesting falls out of the two-pass walk. Detect cycles via a gray/black
DFS; on cycle, promote the offending member to top level and warn.

## Click → commit

For an icon term `T`, compute the **set of choice variables** `T`
could bind:

```ts
candidates(T) = { v ∈ c.activeTerms[i]
                | c ∈ components, opt ∈ c.options, tokensEq(opt[i], T) }
```

Keying by variable (not by `(component, slotIndex)` row) dedups
duplicate option tuples automatically.

- `|candidates| === 0` → plain, non-interactive icon.
- `|candidates| === 1` → click emits the length-1 `ClickIntent`
  `{ activeTerms: [v], optionTuple: [T] }`; `handleClick` inserts
  `^ is v T` at the cursor.
- `|candidates| ≥ 2` → render the icon as a *menu*: one row per
  candidate variable, each carrying its own length-1 `ClickIntent`.

`ClickIntent` and `handleClick` already accept length-1 intents for one
slot of a wider component, so partial commits work with no host
changes. The "click → narrow → click again" iteration falls out of the
existing fixpoint re-run on edit.

## Menu row labels

To make multi-arity menu rows readable, embed the source variable name
into the choose ID, mirroring `freshIdTemplate`. Today's
`freshChooseTemplate` (`ts/src/v2/expand.ts:202`) produces
`(*choose rule lexPos ...chain)` with no trailing variable tag; extend
it to take a `varName` and append `variableToSymbol({Variable, varName})`
as the trailing element, identical to `freshIdTemplate`.

The chain length is variable, but the layout has fixed offsets *from
both ends*:

- `terms[0]` = head symbol (`*choose`)
- `terms[1]` = rule name Symbol
- `terms[2]` = lex pos Symbol
- `terms[terms.length - 1]` = `:varName` Symbol (new)

Add an exported extractor in `ts/src/v2/expand.ts` (or `print.ts`):

```ts
// Given an Id template produced by freshChooseTemplate, return
// { rule, varName } extracted from the known offsets.
export function chooseIdParts(t: Term): { rule: string; varName: string } | null;
```

It returns `null` for non-template terms. The default display calls it
on each candidate variable's owning choose-ID and renders the menu row
as `${rule}:${varName}`.

No separate slot-name field on `ComponentOptions`; the info lives on
the choose ID and is recovered by the extractor.

## Visual states

- plain icon
- clickable (one candidate)
- menu (≥2 candidates, expanded inline)
- container (has children attached via `at`)

Any icon with `|candidates| ≥ 1` gets a `mouseenter` / `mouseleave`
listener pair that toggles a background highlight (e.g.
`.icon.hot { background: ... }`), so the user can see at a glance
which icons would resolve a current choice.

CSS in `index-v2.html`.

## Net diff

- `ts/src/v2/default-display.ts` (new): icon iteration, `at` layout,
  `candidates`, render + click wiring (~80 lines).
- `ts/src/v2/print.ts`: export shared `tokensEq` (Ref by hashcons id,
  Symbol by name). Refactor `ttt-display.js` to use it.
- `ts/src/v2/parse.ts` / expander: embed `:C` in choose IDs.
- `ts/src/web-v2.ts`: have `loadDisplay(null)` return the bundled
  module instead of `null` (~3 lines).
- `index-v2.html`: CSS for `.icon`, `.icon.clickable`, `.icon.menu`,
  `.icon-menu-row`, `.icon.container`.

No changes to `ClickIntent`, `handleClick`, `compressRefs`, fixpoint.

## Open questions

- **Icon ordering.** Start with tuple insertion order.
- **Duplicate `icon T`.** Dedup by `termKey`.
- **Label overflow.** Wrap or truncate rule for long terms — TBD.

# v2 editor keybindings

`web-v2.ts` currently has no `keydown` handler. This plan ports the
keybindings from `web.ts` to v2, dropping or repurposing those that no
longer apply.

## 1. Catalogue of keybindings in `web.ts`

Defined in `onKey` (web.ts:867–917) plus event listeners on `patternsEl`
and `resultEl`.

**Editor mechanics**
- `Tab` / `Shift+Tab` — indent / dedent line or region (`handleTab`,
  `dedent`)
- `Enter` — smart return: weak-line erase, otherwise preserve indent +
  leading marker (`handleReturn`)
- Marker keys (`-`, `<`, `,`, `+`, `?`, `!`, `#`, `=`, `/`, `:`) on a
  weak line — insert/replace marker prefix (`handleMarkerKey`)
- `Ctrl+X` — cut current line plus its indented subtree, else native
  cut (`cutSubtree`)
- `Ctrl+B/F/A/E/P/N` — Emacs cursor movement (char / line / start /
  end)

**Server / file**
- `Ctrl+S` — flush pending PUT, or POST a new file in detached mode
  (`handleCtrlS`)
- `Ctrl+]` / `Ctrl+[` — cycle to next/prev file in `fileList`
  (`cycleFile`)
- `Ctrl+Space` — detach and clear the textarea

**Source ↔ result linking** (key-driven via `keyup`, not in `onKey`)
- `keyup` / `click` on textarea → `updateCursorLine` →
  `highlightResultNodes` (highlights tuples produced by the cursor's
  rule line)
- `resultEl` `mouseover` → highlight source line + sibling outputs;
  `mouseout` clears
- `resultEl` `click` on Ask/Assert → select-then-bind UX that injects
  an `is` row (paired with `assertClick`)
- `scroll` on textarea clears the source-line highlight overlay

## 2. What's missing in `web-v2.ts` and whether each still makes sense

| Binding | Still useful? | Notes |
|---|---|---|
| Tab / Shift+Tab | Yes | v2 source is indent-structured (rule bodies, sub-rules) — same need. |
| Enter (smart) | Yes | Same need. Marker set differs but logic is identical. |
| Marker keys | Yes, with revised set | v2's marker chars are `-`, `~`, `+`, `^`, `?`, `!` (per `parse.ts:isMarkerChar`), plus `%` for schema and `--` for comments. Drop `<`, `,` (which v2 uses as a separator, not a line marker), `#`, `=`, `:`, `/`. |
| Ctrl+X subtree cut | Yes | Indent semantics are the same. |
| Ctrl+B/F/A/E/P/N | Yes | Pure terminal habit; user-leaning. |
| Ctrl+S | Partially | v2 already auto-PUTs debounced. Worth keeping as an explicit "flush now". v1's "POST a new file in detached mode" doesn't apply (v2 always attaches to one fixed file via `bootstrap`). |
| Ctrl+] / Ctrl+[ cycle files | No (yet) | v2 server has `/api/v2-file/<name>` but no list endpoint, and the page hardcodes `ttt.t`. Skip until v2 grows multi-file support. |
| Ctrl+Space detach+clear | Marginal | Detached mode isn't really a thing in v2. Could be repurposed as "reset choices" (duplicating the button) or dropped. |
| Source ↔ result linking (cursor highlight, hover-to-highlight) | Yes, but needs porting | v2 has no result tree, but tuples carry an `*id <rule> <lexPos> …` chain via the expand pass, so the same span-index lookup is feasible against the new DB pane. |
| `assertClick` (Ask + Assert select-to-bind) | No | v2 already has structured choice resolution via the info-panel options and display-module clicks; reproducing the v1 select-tuple workflow would be redundant. |

## 3. Implementation plan

**Phase A — port editor mechanics (independent of v2 semantics).** Lift
`onKey`, `handleTab`, `dedent`, `handleReturn`, `handleMarkerKey`,
`cutSubtree`, `moveLineDir`, `execReplace`, `isWeak`, and the MARKER
tables out of `web.ts` into a new module (`ts/src/editor-keys.ts`)
parameterised on a `<textarea>` plus a marker config:
`{ chars: string[], extraChars: string[] }`. Both `web.ts` and
`web-v2.ts` import it. v2 passes the v2 marker set; v1 keeps its
existing set. Wire `keydown` → `onKey` in `web-v2.ts`.

**Phase B — Ctrl+S flush.** Add an explicit-save path in `web-v2.ts`:
cancels the debounce timer and awaits `putCurrentFile` immediately
(same shape as v1's `handleCtrlS` minus the POST branch). Drop the
new-file POST since v2 has no detached mode today.

**Phase C — source ↔ DB linking.**
1. Track `currentLine` from cursor position (port `updateCursorLine`).
2. Build a `lineToRuleAtoms` index from the parsed `Program` (mirrors
   `buildSpanIndex`, walking `RuleAtom.span.line` and the `id` chain
   assigned by `expand`'s `assignIds`).
3. In `renderDatabase`, for each tuple, attempt to extract the rule
   name + lex position from any `*id` Atom-tag term in
   `t.atom.terms` (or recover it from the row's identity chain), look
   up the source line, and emit `data-source-line="…"` on the row
   span.
4. Port the source-line overlay (`sourceHighlightEl`) and bidirectional
   highlight handlers (textarea cursor → DB rows; DB hover → source
   line + sibling DB rows).

**Phase D — defer.** Skip Ctrl+]/Ctrl+[ until v2 gets a
`/api/v2-files` list, and skip Ctrl+Space until detached mode is
meaningful. Skip the Ask/Assert click flow entirely — the info-panel
component options already cover it.

## 4. Ambiguities to resolve before writing code

- **Marker char set.** Do we want `,` to act as a marker key on weak
  lines? In v2 syntax `,` is the *intra-line* atom separator (used
  inside `~ game ( ~ setup );` constructs), not a line-leading marker,
  so it should be excluded from `handleMarkerKey` even though it's a
  structural character.
- **Ctrl+Space.** Drop, or rebind to "reset choices"? The reset button
  already covers that, so dropping is the lower-friction choice unless
  there's a reason to want a keyboard equivalent.
- **Source linking granularity.** v2 tuples are flat, not
  tree-structured — should hover highlight only tuples whose
  *immediate* producing rule line matches the cursor, or also tuples
  produced by sub-rules whose span overlaps? v1's `buildSpanIndex`
  keys on `Tree.span.line`; v2's analogue would key on the
  `RuleAtom.span.line` of the asserting atom, which is the closer
  match.
- **Internal rows.** Should `data-source-line` attach to internal-only
  rows (`choose`, `constrain`, `_*`)? Probably yes for completeness,
  even when they're hidden by the toggle, so toggling doesn't break
  highlighting.

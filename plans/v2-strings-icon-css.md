# String literals, `icon:css`, display kit in the default display, icon names in the choice strip

## 1. String literals

`"font-size: 32px; color: #f87171"` is a term. **Representation: a Symbol
whose name is the literal's canonical source text, quotes included**
(`{tag: "Symbol", name: "\"a b\""}`), not a new Term tag.

Why: Symbols already hashcons by name, compare by token, unify, match,
print and round-trip through `renderTerm` / `compressRefs` (saved `is` rows,
scenario `-- expect:` lines). A new tag would touch every `switch (t.tag)`
in the engine, the Lean model's `Val`, and js-values. The cost is that a
string is distinguished from a symbol only by its leading `"`, so code that
wants the *value* asks `stringValue(t)` (term.ts). `"a"` and `a` are
different terms.

- **Escapes:** `\"` and `\\` only; any other backslash is a parse error.
  The name is the source text as written (it is already canonical: the only
  spellings are the two escapes).
- **Lexing:** a string literal is a token of the lexer (parse.ts `lex`),
  which reads each line once into words, strings and punctuation; every
  later stage works on tokens, so `--`, `,`, `.`, `(`, `/`, `;`, `{` inside a
  string mean nothing. `#js` bodies are read raw. (The first version masked
  each literal to a same-length placeholder naming a slot in a side table,
  which capped a program at 6399 literals; replaced by the lexer — see the
  amendment below.)
- **`#js` boundary (js-values.ts):** a string decodes to its JS value; a JS
  string encodes as a plain Symbol when it is a valid bare symbol token (as
  today), else as a string literal.
- **Highlighting:** a `str` class (`.t-str`, the number colour).
- **Tutorial:** a short section.
- **Lean model:** `Val.sym : Sym → Val` already covers it; no change.

## 2. `icon:css I S`

The default display sets `S` (a string's value, or a symbol's name) as the
icon element's inline style (appended to the default style). Plain tuples
(last writer wins, like `icon:name`) or `#acc icon:css : e (@last css)`;
read through the same moment-aware, acc-aware row source as the other
display relations.

## 3. Display relations module: `display-rows.ts`

DOM-free, shared by the default display and the choice strip so both agree:
`DISPLAY_RELATIONS`, `displayRows(store, M, accAt)` → rows of a relation at
`M` as `KitRow`s (a computed acc row has `idx: -1`), `iconNames`,
`iconStyles`, `iconLabel` (a string shows its value).

## 4. Display kit in the default display

Each icon is a kit entity: label = icon name (and `(free)` / choice note),
rows = every display-relation row whose first column is the icon. Computed
acc rows show as `(#acc)` (the kit's existing fallback); the kit's "Show in
timeline" skips `idx < 0`. A clickable icon passes `choice`. Right-click
gives the kit menu.

## 5. Choice strip

`renderChoices` labels each option value with its `icon:name` at the
component's moment (via `displayRows` with the run's `accAt`), falling back to
`renderTerm`; the full term moves to the option's tooltip.

## 6. ttt-display.t

Uses `icon:css` for 60px square cells, a big font, and x/o colours, close to
ttt-display.js.

## Tests

- parse/print round trip of strings (spaces, `--`, `,`, `(`, escapes),
  equality/matching, escape errors, unterminated, `#js` decode/encode.
- `display-rows`: plain vs acc rows at a moment, names (string value), css.
- highlight: a `str` token.

## Amendment: a real lexer (2026-10-13)

The masking scheme existed because the parser re-read raw text at several
levels (comment stripping, the structural scan, `{…}` / `[…]` scans,
`tokenizeTermText`, `findTopWalrus`), none of which knew about quotes.
parse.ts now lexes once into positioned tokens and every stage consumes
those: no side table, no placeholder characters, no literal limit, and an
exception's right-hand side is parsed on its own tokens with true columns
(`remapItemLines` is gone). Checked against the previous parser: identical
`Program`s (spans included) on all 116 `.t` files in the repo, and on 20,000
mutated snippets identical results except for error wording where a
mistyped command name runs into punctuation (`#a.cc` now reports `#a`).

---
Claude Opus 5.5 (claude-opus-5-5)

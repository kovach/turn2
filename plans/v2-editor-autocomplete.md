# editor symbol/variable autocomplete

Spec: `notes/overview.md` `# editor auto-complete`.

Add an opt-in autocomplete overlay to the v2 `Editor` (`ts/src/v2/editor.ts`). When the
cursor sits at the right end of a partial token, show a small teal box listing up to 5
candidate completions drawn from the symbols in the current program (or the variables in
the current rule). `<tab>` accepts the first.

## Decisions (from spec discussion)

- **mid-token**: no completion unless there is whitespace (or EOL) immediately to the right
  of the cursor, and at least one non-whitespace char immediately to the left.
- **empty prefix** (cursor after whitespace/marker, no partial token): show nothing.
- **symbol vs variable test**: use canonical parser predicates. These don't exist yet — add
  them in `parse.ts` and refactor existing call sites to use them (see Step 1).
- **dedup**: a candidate that qualifies as both a strict-prefix and a substring continuation
  appears once, in strict-first order.
- **exact match suppresses**: if the prefix exactly equals an existing symbol/variable, show
  nothing — even if longer completions exist (so no "self-suggestion" case can arise).
- **parse failure**: symbol completions still work (symbols come straight from the lexer).
  Variable completions are disabled when the program fails to parse (per overview line 12–14;
  we don't track/guess rule boundaries on a broken parse).

## Step 1 — canonical token predicates in `parse.ts`

There is currently no shared `isSymbol`/`isVariable`. The logic lives inline in two places:

- `isSymToken(tok)` at `parse.ts:935` (module-private)
- the term-tagging branch in `parseTerms` at `parse.ts:975-980` (`>= "A" && <= "Z"` → Variable,
  `length > 1 && tok[0] === "_"` → Variable, else Symbol; bare `_` → Wildcard)

Add and export canonical predicates, then route both existing sites through them:

```ts
// a non-empty token that is a legal Symbol (lowercase/punct start, not _, not uppercase)
export function isSymbolToken(tok: string): boolean { ... }   // == current isSymToken
// a non-empty token that is a legal Variable (uppercase start, or _ followed by more)
export function isVariableToken(tok: string): boolean { ... }
```

Keep `isSymToken` as a thin alias (or replace its body with `isSymbolToken`) so the term
parser keeps the exact current behavior. Rewrite the `parseTerms` branch to call the new
predicates rather than open-coding the char checks (bare `_` Wildcard case stays as-is, checked
first). This is a behavior-preserving refactor; existing parser tests must still pass.

These predicates are what the autocomplete uses to (a) classify the partial token under the
cursor and (b) filter candidate sets.

## Step 2 — completion data sources

New module `ts/src/v2/autocomplete.ts` (pure, unit-testable, no DOM):

### symbols of a program (works even on parse failure)
Tokenize the raw editor text leniently and collect every token for which `isSymbolToken`
holds, into a `Set<string>`. Reuse the existing lexer rather than re-implementing splitting:
`tokenizeTermText` (`parse.ts:931`) already splits on whitespace and parens — expose a small
helper that runs it per line (or over the whole text) and filters with `isSymbolToken`.
Exclude tokens starting with `*` (compiler-generated id heads) and `#`/`@`-command tokens.

### variables of a rule (parse required)
Given a successful `parse()` (`parse.ts:32` → `Program`), and the rule containing the cursor:
walk that rule's `body` (pre-expand `RuleAtom`s of tag `"Atom"`, whose `atom.terms` are
`Term[]`), collecting every `Term` with `tag === "Variable"` by `name` into a `Set<string>`.
Identify the containing rule via `Rule.span` (`types.ts:174`) against the cursor offset.

If `parse()` returns a `ParseError`, variable completions are simply unavailable; symbol
completions still run.

### completion strategy (shared)
```ts
function completions(prefix: string, candidates: Iterable<string>): string[]
```
- If any candidate equals `prefix` → return `[]` (exact match suppresses the box).
- **Strict pass**: candidates that `startsWith(prefix)`.
- **Subsequence pass**: candidates where `prefix` is a subsequence (chars in order, gaps
  allowed) but which were *not* strict-prefix matches. Hyphens are **not** treated specially —
  just ordinary chars in the subsequence scan (per user decision; the original "substring"
  wording in the spec meant subsequence).
- Concatenate strict ++ subsequence (each in candidate insertion order), cap at 5. Since
  `startsWith ⇒ subsequence`, excluding strict matches from the subsequence pass dedups.

This reproduces the spec examples (symbols `foo`,`fbar`,`foo-b-ar` in document order):
`fo`→`foo`,`foo-b-ar`; `fb`→`fbar`,`foo-b-ar`; `ba`→`fbar`,`foo-b-ar`; `foo`→`[]`.

Order within each pass: stable over insertion order of the program's tokens (left-to-right,
top-to-bottom), which is deterministic and matches the examples.

## Step 3 — cursor / token helpers in `Editor`

Add private helpers on `Editor` (alongside the existing `lineBoundsAt` style helpers):

- `tokenLeftOfCursor(): { text: string; start: number; end: number } | null`
  - Let `pos = ta.selectionStart`; require `selectionStart === selectionEnd` (no selection).
  - Require the char at `pos` is end-of-text or whitespace (right-edge rule). Otherwise null.
  - Scan left from `pos` over the maximal run of token chars (non-whitespace, non-paren); the
    run must be non-empty. Strip a leading literal-type marker / `(` if the run starts at a
    line marker. Return the run and its `[start,end)`.
  - Return null if the run is empty (empty-prefix case → no box).
- `ruleTextContainingCursor()` / cursor offset → used to pick the rule for variable lookup.
  (Spec helper "determine prefix of rule text of rule containing cursor".) Implement via the
  parsed `Program` rule spans; fall back to symbol-only if no parse.

Classify the token with `isSymbolToken` / `isVariableToken` to choose the candidate set:
symbol token → program symbols; variable token → current-rule variables (only if parsed).
If the token is neither (e.g. starts with `_` only, or is `*…`), show nothing.

## Step 4 — the overlay box (DOM)

- Gate everything behind a new `EditorOptions.enableAutocomplete?: boolean` (Step 6). When
  false, none of the box code runs and no listeners beyond what's needed are attached.
- The box is a single absolutely-positioned `div.editor-autocomplete` appended inside
  `this.wrap`. `.editor-wrap` is currently `display:flex` with no positioning context — add
  `position: relative` to `.editor-wrap` in `styles/editor.css` so the box can anchor to it.
- Recompute only on the `keyup` of a token-building keystroke: a bare character key (no
  Ctrl/Meta/Alt) or Backspace. We deliberately do not recompute on paste or caret movement
  (arrow keys, clicks) — the box is not required there, and this keeps the O(document)
  parse/tokenize off the `input` path. Hide on `blur`, `scroll`, and `Escape`.
- Position: compute the caret's pixel coordinates. A textarea has no caret-rect API, so use
  the standard mirror-div technique: a hidden div that mirrors the textarea's font/padding/
  wrapping, containing text up to the token start, with a marker span whose `offsetLeft/Top`
  give the anchor. Place the box just below the token. (Keep the mirror element cached and
  rebuilt on value change.)
- Render up to 5 rows; first row gets an `is-first` style. Text color = the db-view teal
  `--syn-pred` (`#4ec9b0` dark / `#007a5a` light, defined in `ts/index-v2.html:8-27`,
  applied as `.pred` in the db view). Define `.editor-autocomplete { color: var(--syn-pred); }`
  in `styles/editor.css` so it inherits the same variable.
- Hide the box when: completions empty, token is exact match, no token, editor frozen
  (`this._frozen`), or autocomplete disabled.

## Step 5 — `<tab>` acceptance

In `onKeyDown` (`editor.ts:157`), **before** the existing `Tab` → `indentSelection` branch
(`editor.ts:171`): if the box is currently visible and non-empty, `<tab>` instead accepts the
first completion and consumes the event.

- Accept = `replaceRange(tokenStart, tokenEnd, firstCompletion, tokenStart + firstCompletion.length)`
  using the existing `replaceRange` helper (`editor.ts:150`) so it lands on the native undo
  stack, then hide the box.
- No other key selects a non-first entry (per spec). `Escape` hides the box (and, since the
  box was visible, should *not* also blur — special-case: if box visible, Escape just hides).
- Tab with no visible box keeps current indent behavior unchanged.

## Step 6 — wiring the constructor flag

- Add `enableAutocomplete?: boolean` to `EditorOptions` (`editor.ts:3`).
- **index-v2**: `web-v2.ts:595` `new Editor({ existing: sourceEl, saveBackend: "none" })`
  → add `enableAutocomplete: true`.
- **pres**: `pres/render.ts:472` editor construction → add `enableAutocomplete: false`
  (default off). Since the field is optional, omitting it = off; set it explicitly here for
  clarity.
- Treat `enableAutocomplete ?? false` as the effective default inside `Editor` (so pres and any
  other caller that omits it get no autocomplete), while index-v2 opts in explicitly.

## Step 7 — tests

`ts/src/tests/v2_autocomplete.test.ts` (run via `./run-tests.sh v2_autocomplete`), DOM-free,
covering the pure layer:

- `completions()` against the spec table (`fo`,`fb`,`ba`,`foo` over `foo`/`fbar`/`foo-b-ar`).
- dedup: a substring hit that is also a strict hit appears once.
- exact-match → `[]`; empty prefix path handled by caller (token = null), not `completions`.
- 5-item cap.
- symbol extraction from text that does **not** parse (still returns symbols; `*`/`#`/`@`
  tokens excluded).
- variable extraction: for a parsed multi-rule program, variables are scoped to the rule
  containing a given offset (a `Y` in another rule is not offered).
- `isSymbolToken`/`isVariableToken` truth table, including `_`, `_X`, `Foo`, `foo`, `foo-bar`.

The DOM/overlay (Steps 3–5 caret math, box, tab) is verified manually in index-v2; keep that
logic thin and delegate all decisions to the tested pure functions.

## Touch list
- `ts/src/v2/parse.ts` — add/export `isSymbolToken`/`isVariableToken`; refactor `isSymToken`
  + `parseTerms` to use them.
- `ts/src/v2/autocomplete.ts` — new: symbol/variable extraction + `completions()`.
- `ts/src/v2/editor.ts` — `EditorOptions.enableAutocomplete`; token/cursor helpers; overlay
  box; tab acceptance; show/hide lifecycle.
- `styles/editor.css` — `.editor-wrap { position: relative }`; `.editor-autocomplete` styles.
- `ts/src/web-v2.ts:595` — `enableAutocomplete: true`.
- `ts/src/pres/render.ts:472` — `enableAutocomplete: false`.
- `ts/src/tests/v2_autocomplete.test.ts` — new tests.

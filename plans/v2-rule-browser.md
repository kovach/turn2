# Rule browser for the web editor

status: steps 1–4 implemented (26/10/12); step 5 (causal past) not started

## Goal

A second way to view and edit the program in `index-v2`. The parsed program
is split into its rules, and the browser shows chosen rules as separate
cards. Editing a card becomes an edit of the source text, so the source
stays the single source of truth and the browser is a view of it.

First demo: type or click a predicate and see exactly the rules that use it,
grouped by how they use it (asserted by / matched by / ...), with each use
highlighted. Clicking another relation name inside a card switches the query
to that relation.

Second piece: the syntax highlighting from the Spirit Island report
(`si/report/turnhl.py` + the `--t-*` palette in `si/report/style.css`),
ported to TS and used both in rule cards and in the main source editor.

Mockups built from si-game.t with the report's highlighter (lexical
segmentation, so not exact):
`slide2-rule-browser-mock-explore.png`, `slide2-rule-browser-mock-exploring.png`
in the image log.

## 1. Segments: rules as source ranges

The parser already splits the program by the offside rule (a column-0 line
starts a new definition, indented lines continue it, and inside an open `(`
the boundary is ignored). But a `Rule` records only its start line
(`span: { line }`), so we can't recover its text.

Add a source range to every top-level item the parser produces:

```ts
interface SourceRange { start: number; end: number }  // char offsets, end exclusive
```

- `Rule.range`, `AccRule.range`, `AccDecl.range`, `JsDef.range`, `JsRelDef.range`
- the range starts at `#def <name>` when there is one, and ends after the
  last non-blank line of the body (trailing blank lines and comments are left out)
- the tokenizer already emits a `ruleEnd` token at every column-0 line, so it
  can record line → offset as it goes, and `parseProgram` computes each
  item's range from its first and last tokens

A DOM-free `segments.ts` turns that into the list the browser works with:

```ts
interface Segment {
  kind: "rule" | "acc-rule" | "acc-decl" | "js" | "js-def";
  name: string;          // r62, or the #def name, or the relation name
  range: SourceRange;    // the code itself
  doc?: SourceRange;     // the comment block directly above, no blank line between
  firstLine: number;     // 1-indexed, for the card's gutter
}
```

**Comments.** A comment block counts as a rule's doc only when it sits
directly above the rule, with no blank line between. Otherwise it belongs to
no rule and the browser doesn't show it. The mockup gets this wrong: it
attaches a trailing comment (si-game.t:384) to the rule above it. Doc
comments are editable: a card edits `doc.start .. range.end` (§3).

**Broken programs.** While the source doesn't parse, the browser keeps the
last good segments and index, shown as stale. An edit that breaks the parse
still splices, because a card's range stays valid until the next good parse
(see §3). We could add a lexical fallback with the same boundary rules later,
like `rename.ts`, but it isn't needed for the demo.

## 2. Predicate index

The index is built from the pre-expand parse, not the expanded rules,
because it should describe what the user wrote. `applyExceptions` renames
and generates rules, and splitting multiplies them. A quick prototype on
si-game.t found 200 predicates and 1080 uses; for `explore` it gave exactly
the 4 rules the mockup shows.

```ts
type Role =
  | "assert"     // ~p  +p  ^p  ~>p
  | "match"      // p  >p  (also acc-rule bodies)
  | "not"        // not p
  | "ask"        // ?   (no head; not indexed by predicate)
  | "constrain"  // !(... p ...)
  | "intercept"  // {p ... => ...}
  | "acc-head"   // body / p ...   (contributes to an #acc relation)
  | "declare";   // #acc p : ...  /  #js-def p ...

interface Use { segment: number; role: Role; span: Span }
type PredicateIndex = Map<string, Use[]>;
```

- A walk over `Rule.body` (`Atom`, `Sub`, `Exception`, `subAtoms`),
  `AccRule.body` / `head`, and the declarations.
- `Span` already has columns for almost every atom, so a card can highlight
  the exact use. Gaps found by the prototype: an acc rule head has only a line
  (70 of the 1080 uses), and an `Exception` span covers the whole `{…}` block.
  Both are small parser fixes.
- Dot chains (`A.p X`) and arity saturation happen in the parser, so they're
  already ordinary atoms by this point. Their spans should be checked in a
  test.
- A relation symbol used as a value (e.g. `explore` in `card-at N explore C`)
  is not a use. This is where parse-based beats lexical matching.
- A variable-headed match (plans/v2-variable-head-match.md) can read any
  predicate. List these as a separate "may match (variable head)" group
  under every query, rather than leaving them out.

The demo groups the uses into columns: **Asserted by** (assert, acc-head),
**Matched by** (match, not, constrain), and **Intercepted by** (intercept).
The mockup lumps the exception at si-game.t:391 under "matches", which is
misleading. A rule that both asserts and matches `p` appears in both
columns.

## 3. Editing a card

Each card is an editor over the slice `source.slice(doc?.start ?? range.start, range.end)`:
the doc comment and the code, edited together. Deleting the doc comment, or
adding one, is just an edit of the slice.

- **Splice.** On input, replace the card's range in the main editor's
  textarea with the card's text, using select + `execCommand("insertText")`.
  The main editor's undo stack and autosave/run then work unchanged, and
  undo in the source view reverts card edits too. The card updates its own
  `range.end` by the length change, and every other card shifts its range
  by the same amount.
- **Reparse.** After the usual debounced run, segments and the index are
  rebuilt. The focused card keeps its DOM and caret. Its new range is the
  segment whose start equals its old start; if the rule was deleted or
  merged, the old range is kept until blur. Other cards re-render.
- **Splits.** Typing a column-0 line inside a card makes two rules. The card
  keeps showing its whole edited text until blur, and then the query
  re-runs, so the new rule shows up only if it still uses the predicate.
  This is the honest behavior, and it's simple.
- **Indentation.** The card's first line is at column 0 and its
  continuation lines are indented, the same as in the file. The card doesn't
  re-indent anything.
- **Source edits** made while the browser is open just re-run the query
  after the next parse.

Card editor: reuse `Editor` (editor.ts) with two new options:
`firstLineNumber` (the gutter shows file line numbers) and `onChange` in
place of a save backend. Autocomplete and rename come for free. Rename must
act on the whole file, not the card, so the card's context menu delegates it
to the main editor.

## 4. Syntax highlighting

Port `turnhl.py` to `v2/highlight.ts`, DOM-free:

```ts
type HlClass = "c" | "d" | "sl" | "sa" | "sq" | "ex" | "op" | "p" | "ag" | "n" | "v" | "b" | "r" | "s" | "js";
function highlightLines(src: string): { cls: HlClass; start: number; end: number }[][];
```

- Same classes and the same `--t-*` CSS variables, with light and dark
  palettes. The page already has a theme toggle. Copy the variables into
  index-v2's CSS rather than importing `si/` (tracked code must not depend
  on `si/`).
- Lexical, so it works while the program doesn't parse. When a parse is
  available, upgrade the head classes from the index: `r` for relations
  that have uses, plus optional marks for `#acc` relations, `#js-def`
  relations, and relations that are matched but never asserted. That last
  one is a cheap lint for typos.
- Parity test: on every `.t` file in `ts/data/v2`, the TS port produces the
  same class sequence as `turnhl.py`, run once to generate fixtures.
  Alternatively, `build.py` could switch to the TS port so there's only one
  highlighter.

The main editor is a `<textarea>`, which can't style its text. Put a
highlight layer under it: a `<pre>` with the same font, padding, tab size and
no wrapping, scrolled in sync. The textarea's text is transparent and its
caret visible (`color: transparent; caret-color: var(--fg)`). editor.ts
already positions overlays this way (the line highlight, the live-value
notes and the caret mirror), so the metrics code exists. Re-highlight on
input, line by line: only lines whose text changed, carrying the `#js` brace
state across lines.

Rule cards use the same layer, so they look the same as the source.

## 5. Queries

Queries will grow beyond a single predicate, so the browser is built around
a query module, not around "uses of p":

```ts
type Query =
  | { kind: "uses"; pred: string; roles?: Role[] }   // the demo
  | { kind: "and" | "or"; args: Query[] }            // later
  | ...;                                             // e.g. rules inside an episode
interface QueryResult {
  groups: { title: string; cards: { segment: number; marks: Span[] }[] }[];
}
function runQuery(q: Query, segs: Segment[], index: PredicateIndex): QueryResult;
```

- The query bar is text with a small parser (`queries.ts`, DOM-free). For
  now the only syntax is a bare predicate name, which means
  `{ kind: "uses", pred }`. The URL fragment stores the text.
- A result is a list of titled groups of cards, each with the spans to
  mark. "Uses of p" produces the three columns of §2; other queries choose
  their own groups. The view only renders groups, so a new query kind needs
  no UI change.
- Clicking a relation name in a card replaces the query with that name.

**Example (from the user): the rules in the causal past of an output.**
Pick an output episode (a timeline bar or a db row), or an `at` value in the
display, and list every rule whose firings led to it, transitively. That
query needs the last run as well as the source, so `runQuery` takes a
context:

```ts
interface QueryCtx { segs: Segment[]; index: PredicateIndex; run?: { store: Store } }
type Query = ... | { kind: "past"; tuple: number }   // a store tuple index
```

What it needs from the engine (not recorded today):
- **Tuple parents.** The store records which emit made each tuple
  (`store.tupleSource`, a span), but not which tuples the firing matched.
  Proposed: while a firing runs, `evalMatch` pushes the matched tuple index
  on a stack in `Ctx`, and when `evalEmit` adds a *new* tuple it records a
  copy as `store.tupleParents[idx]` (first derivation only, as with
  `tupleSource`). Splitting at emits is no problem: a consumer half matches
  the producer half's tuple, whose own parents carry the prefix.
- **Acc rows.** An `at X L` value is an `#acc` row (`@last`), with no span
  and no parents. The acc handler would record, per row, the contributions
  that made it and the tuples/rows each contribution's firing matched
  (`evalAccContribute` already computes the firing identity from those).
- The closure over parents gives tuples; each tuple's span gives its rule
  (span line → segment), and an acc row gives the acc rules that
  contributed. Groups: one per segment, ordered by distance from the
  output, with the spans of the atoms that fired marked.
- Recording costs memory per tuple, so it runs only when the page asks
  (an option to `runFixpoint`, on in the web editor).
- Tuple ids already nest the ids of what they matched (that's why ids are
  never printed in full), but `pruneChains` drops chain variables that
  aren't needed for identity, so the id isn't a reliable record of the
  derivation.

## 6. UI

- The left pane gets a **Source | Rules** toggle (decided). Rules shows a
  query bar (with completion from the index's keys, and use counts) above
  the result groups, laid out as columns.
- There are back/forward buttons through the query history.
- From the source editor: a context-menu item, "Show rules using `p`", next
  to rename.
- Each card header shows the role, `file:line` and the rule name, plus
  "open in source", which switches to Source with the caret on the use.
- Source links: cards are output roots for `source-link.ts` in reverse.
  Hovering a db row or a timeline bar can highlight the card holding its
  emitting atom, by matching the span line.

## 7. Steps

1. `highlight.ts` + parity test; the highlight layer in `Editor`.
2. Parser source ranges + `segments.ts` + the predicate index, with headless
   tests (si-game-sized program, comments, `#def`, acc rules, exceptions,
   dot chains, a broken parse).
3. Read-only Rules view: query module, groups, cards, navigation, open in source.
4. Editing through cards (§3).

5. Tuple parents in eval and acc, and the "causal past" query, started from
   a db row, a timeline bar or a display icon.

Steps 1 and 2 are independent of each other; step 5 needs only step 3.

## Decisions (26/10/12)

- Placement: a Source | Rules toggle on the left pane.
- Doc comments are part of a card's editable text.
- Queries will grow: the browser is built on a query module (§5).
- Results appear at once as editable cards (no "open" step), in one
  full-width column: the groups stack.
- Each card has a pin: a pinned card stays visible whatever the query (in
  its group while the query picks it, else in a "Pinned" group on top).
- Focusing or pinning a card never moves it.
- Edits (source or cards) no longer run the program: Ctrl/Cmd+Enter does.
  The rules view still follows edits by parsing (parse only). Edits the page
  makes itself (appended `is` rows) still re-run at once.

## Notes from the implementation

- The source textarea's native undo doesn't cover card edits (they assign
  `value`); each card has its own undo.
- Highlight rows take the gutter rows' measured height: line boxes of a
  row with bold/italic runs came out 1/64 px taller, a full line off by
  line 1400 of a long file.

Claude Opus 5.5 (claude-opus-5-5)

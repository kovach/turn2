# recursive `[% %]` parsing + formatted titles

Goal: let `[slide]` titles (and `metadata.title`) carry the same inline
formatting as body text — `*italic*`, `**bold**`, and `[%code%]`. The
enabling change is a parser refactor: replace the two ad-hoc `[%`/`%]`
scanners with a single recursive quote-reader that yields a structured
body (a list of text/quote parts) instead of a depth-counted flat string.
Once a body is structured, "format a title" and "format a paragraph"
become the same operation, and nested `[% %]` needs no special case
anywhere.

This refactor is in `ts/src/pres/{parse,types,render}.ts` only. The v2
language parser (`ts/src/v2/parse.ts`) and the `[code]` evaluation path
are untouched.

## Background: why titles can't see `[%...%]` today

`[%`/`%]` is handled in two places with two behaviors:

- `tokenize` (`parse.ts:8-62`) pulls a *bare* `[%...%]` out as its own
  `inlineCode` token, but a `[%...%]` that immediately follows a `[name]`
  head is captured as that command's **body**.
- `readBody` (`parse.ts:64-79`) depth-counts nested `[%`/`%]` only to find
  the matching close, and **flattens the nesting back into a raw string**
  (`out += "[%"`, `parse.ts:70`).

So inside a captured body (e.g. a slide title), nested `[%...%]` survives
as literal characters that no scanner re-tokenizes. Bold/italic happen
*later* in `emitFormattedText` (`parse.ts:107-134`), which only knows `*`
and `**` — it never sees code. The result: paragraph text gets code via
the top-level `inlineCode` token, but a title (a body) does not.

## Target structure (s-expression-like)

One recursive reader produces a small tree. Commands are *not* recognized
inside a body, which matches today's behavior (`[bar]` in a title is
literal), so the recursion is total:

```
Part    := Text | Quote | Command
Quote   := '[%' (Text | Quote)* '%]'        // nesting is just children
Command := '[' name ']' Quote? Opts?
```

`Quote` does double duty by **attachment**, not by syntax:

- a standalone `Quote` is inline code;
- a `Quote` immediately following a `[name]` head is that command's body.

That single attachment decision stays at the command level (it is the real
distinction between `[%x%]` and `[slide][%x%]`). The `[% %]` *scanner*
itself becomes context-free.

## Pieces

### 1. New body-parts type (`types.ts`)

Add a structured body representation used by the tokenizer and command
bodies:

```ts
export type BodyPart =
  | { kind: "text"; text: string }
  | { kind: "quote"; parts: BodyPart[] };   // a [%...%] region, recursive
```

`Slide.title` and the title-slide model change from `string` to `Span[]`.
`metadata.title` likewise becomes `Span[]` (author/date stay plain strings
— they are rendered with `textContent`, see step 5). Audit every read of
`.title`:

- `render.ts:79` (title-slide construction), `render.ts:146`,
  `render.ts:154` (the two `<h1>`s) — now render spans.
- `render.ts:75` `hasMeta` truthiness check on `metadata.title` — switch to
  a non-empty-spans check.
- `parse.ts:336` (`slides.push`), `parse.ts:368-369` (`openSlide` title),
  `parse.ts:435` (empty-leading-slide drop, currently `title === ""`) —
  switch the emptiness test to "no non-blank spans".

### 2. Recursive reader replacing `readBody` (`parse.ts`)

Replace `readBody` with `readQuote(src, start): { parts: BodyPart[]; next }
| null`. It assumes `src[start..]` begins `[%`, recurses on nested `[%`,
and returns `null` on an unterminated quote (preserving today's
fall-back-to-literal behavior at `parse.ts:38`). A nested `quote` part
records that a `[%...%]` appeared; it does **not** re-flatten markers into
text.

Provide the inverse for consumers that want raw source:

```ts
export function flattenBody(parts: BodyPart[]): string;  // re-emits [% %]
```

`flattenBody` must be the exact inverse of `readQuote` for round-tripping
(`[code]`/`[svg]`/`[metadata]` bodies rely on it). Add a focused
round-trip test (step 6).

### 3. Rework `tokenize` to emit structured bodies (`parse.ts:8-62`)

`Tok` body fields become `BodyPart[] | null` instead of `string`. A bare
`[%...%]` becomes a standalone token whose payload is `BodyPart[]`
(replacing today's `inlineCode` string token). A `[name]` head optionally
followed by a quote attaches that quote's `parts` as the command body;
`bodyOffset` is still recorded for `[svg]` source-splicing (it points just
past the opening `[%`, unchanged).

### 4. Shared "parts → spans" formatter (`parse.ts`)

Introduce one function used by both titles and body text:

```ts
function emitParts(target: Span[], parts: BodyPart[], reveal: number): void
```

- `text` part → existing `emitFormattedText` (untouched `*`/`**` logic).
- `quote` part → `pushInlineCode(target, flattenBody(part.parts), reveal)`
  — i.e. nested `[%...%]` inside a code span stays literal, matching the
  old behavior where `readBody` kept inner markers.

Body-text handling in `handleLine`/`feedText` currently threads `Frag`
items (`text`/`code`). Re-express those `Frag`s as `BodyPart`s so the body
path and the title path call the same `emitParts`. The per-line buffering,
bullet detection, and reveal bookkeeping are unchanged in spirit; only the
fragment type they carry changes.

For titles: in the `[slide]` handler (`parse.ts:367-370`) build `Span[]`
via `emitParts` over the body parts (reveal is irrelevant for titles —
pass a constant, e.g. `1`), then trim leading/trailing whitespace on the
span sequence the way `flushPara` does (`parse.ts:165-168`). Same for
`metadata.title` in `parseMetadata` — but note metadata values are
currently parsed from flattened *lines* (`parse.ts:92-104`); the title
line must be formatted while author/date stay plain. Simplest: have
`parseMetadata` receive the body parts, flatten for the generic
`key: value` line scan, and re-parse just the `title` value through
`emitParts`. Resolve `[today]` (`resolveMetaValue`) before span-splitting.

### 5. Render spans in the `<h1>`s (`render.ts`)

Replace `escapeHtml(eff.slide.title)` at `render.ts:146` and `:154` with a
title span renderer. Reuse `wrapSpan`'s inner logic (code→em→strong,
`render.ts:86-92`) **without** the `.frag`/`data-reveal` wrapper — titles
are always fully visible. Add a small `titleHtml(spans)` helper that maps
each span through the inner formatting only. `metadata.author`/`date` keep
using `textContent` (`render.ts:307-310`), so they remain plain.

### 6. Tests (`ts/src/tests/`)

Add `pres_parse.test.ts` (none exists yet for the pres parser; `parse.test.ts`
tests the v2 language parser):

- `*`/`**`/`[%code%]` in a `[slide]` title produce the expected `Span[]`
  (bold/italic/code flags).
- Nested `[%a [%b%] c%]` in a title round-trips: the inline-code span text
  is `a [%b%] c`.
- `flattenBody(readQuote(...))` round-trips for code/svg-style bodies
  containing nested quotes.
- Regression: a plain title (no markers) yields a single unstyled span;
  the empty-leading-slide drop still fires for a blank title.
- Body-text formatting (existing `emitFormattedText` cases) is unchanged
  after the `Frag`→`BodyPart` refactor — add a couple of paragraph/list
  span assertions to lock this.

Run via `./run-tests.sh` (skill: run-tests).

## Caveat (out of scope)

This does **not** fix the underlying `[%`/`%]` delimiter ambiguity: a
`[code]` or `[svg]` body whose content literally contains `[%` or `%]`
still confuses the depth counter. That is a property of the delimiter
alphabet, not the parse structure, and is exactly as (un)handled as today.
Named here so the refactor isn't mistaken for solving it.

## Docs

No new files, but `Slide.title`'s type changes and the pres parser gains a
recursive body model. The `ts/src/pres` sub-project is explicitly outside
`ts/src/v2/overview.md` (per CLAUDE.md), so no overview update is required;
update this plan's status line in `notes/overview.md` if one is added.

# Presentation software

Lightweight slide renderer for Turn talks. Plain-text source → small
IR → single-page web app with bullet- and slide-level navigation.
Code blocks can embed a live Turn evaluator (timeline / tuples) with
an editable program.

The user-facing format and example live in `docs/overview.md`.

## Source format (compiler view)

Three token shapes:
- `[name]` — bare command.
- `[name][%body%]` — body delimited by `[%`/`%]`, **nesting-balanced**
  (the only balanced rule in the grammar). Bodies may contain blank
  lines, brackets, anything.
- `[name][%body%][opts]` — comma-separated keyword list in `[opts]`,
  flat read up to `]`.

Recognized commands:
- `[slide][%Title%]` — opens a new slide. Everything until the next
  `[slide]` or EOF is its content.
- `[metadata][%key: value ...%]` — populates `Doc.metadata`. Produces
  no rendered block. `title`, `author`, `date` recognized; `[today]`
  in a metadata value resolves to the render-time date.
- `[code][%...%][opts]` — block-level code embed. `opts` keywords:
  `timeline`, `tuples` (both optional, any order; unknown → warn).
- `[pause]` — zero-width reveal cut. Legal anywhere, including inside
  code bodies, mid-paragraph, or mid-bullet.

Within slide content:
- Lines starting `- ` are list items; runs of such lines form one list.
- Everything else is paragraph text, ended by a block command or list.

Escape for literal `%]` deferred until needed.

## IR

`ts/src/pres/types.ts`:

```ts
export type Doc = {
  metadata: { title?: string; author?: string; date?: string };
  slides: Slide[];   // auto title slide is rendered, not stored
};
export type Slide = { title: string; blocks: Block[]; overlayCount: number };
export type Block =
  | { kind: "para"; spans: Span[] }
  | { kind: "list"; items: Span[][] }
  | { kind: "code"; segments: Segment[]; opts: CodeOpt[] };
export type Span    = { text: string; reveal: number };
export type Segment = { text: string; reveal: number };
export type CodeOpt = "timeline" | "tuples";
```

Every leaf carries the 1-indexed overlay it appears on. Pre-first-pause
content is reveal 1.

## Parser (`ts/src/pres/parse.ts`)

One pass, two layers:

1. **Tokenize** into `Text` runs and `Cmd(name, body?, opts?)`. Body
   reader tracks `[%`/`%]` depth.
2. **Assemble** blocks. Maintain `currentSlide` and `revealCounter`
   (resets to 1 per slide). Each `[pause]` increments the counter.
   When emitting a text run / list item / code segment, tag it with
   the counter's current value. Block-level commands flush any
   pending paragraph or list.

Text before the first `[slide]` is appended to the auto title slide's
body.

## Renderer (`ts/src/pres/render.ts`)

Vanilla DOM:

```
.pres
  .slide.current
    h1.title
    .body
      .block.(para|list|code)
        .frag[data-reveal="N"] ...
```

Current slide gets class `r-N`; CSS hides `.frag[data-reveal>N]` with
`visibility: hidden` so layout doesn't reflow. Auto title slide
(`.slide.title-slide`) is prepended only if `Doc.metadata` is
non-empty. State (`s`, `r`) round-trips through the URL hash.

### Code blocks

Each code block renders a `<textarea>` (seeded with concatenated
segment text, pauses stripped) plus an output area per opt. Edits are
kept in an in-memory `Map<(slideIdx, blockIdx), string>` that survives
slide changes but not reload. A "run" button parses the textarea
contents with the v2 parser, runs `fixpoint`, and feeds the store into
the opt panels.

Segment-by-segment reveal happens by toggling `data-reveal` on
overlays of the rendered text *display* (a `<pre>` sibling of the
textarea, shown until the slide is fully revealed; then the textarea
takes over as the editable view).

### Evaluator integration

Out of scope here. See `plans/pres-evaluator-integration.md` for the
follow-up that wires `timeline` / `tuples` opts to the v2 evaluator,
factors shared helpers/CSS out of `web-v2.ts`, and handles the live
editor lifecycle.

## Navigation

Document-level keys:
- `Right` / `Space` — advance one reveal; past `overlayCount`, go to
  next slide reveal 1.
- `Left` — reverse.
- `Down` / `Up` — whole-slide next/prev (lands on reveal 1).
- `Home` / `End` — first / last slide.

Pure `nextStep` / `prevStep` helpers compute new `{slide, reveal}`;
one update site syncs hash + DOM.

## Entry point

- `ts/index-pres.html` — `<div id="pres"></div>`, query `?doc=foo.pres`.
- `ts/src/pres/main.ts` — fetch, parse, mount.
- Serve via the existing static dev server (`scripts/`).

## Layout

```
ts/src/pres/{types,parse,render,main}.ts
ts/index-pres.html
docs/example.pres
```

## Out of scope

Math; speaker notes; persisting edits; theming; `%]` escape.

## Milestones

1. Parse + render `[slide]`, paragraphs, lists, `[pause]`. Key nav.
2. `[metadata]` + auto title slide.
3. `[code]` rendering with editable textarea and segment reveal.
4. Hash sync, stylesheet, edge cases.

Evaluator integration (`timeline` / `tuples` opts) is tracked in
`plans/pres-evaluator-integration.md`.

Each milestone ends compileable and demoable.

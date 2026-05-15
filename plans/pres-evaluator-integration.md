# Pres evaluator integration

Wire Turn evaluator output into `[code][%...%][opts]` blocks in the
presentation renderer. Companion to `plans/presentation-software.md`,
which implemented parse/render of `[code]` as static monospace.

## Scope

- Only two opts: `timeline` and `tuples`. Anything else is ignored.
- `timeline` → horizontal timeline view only. `tuples` →
  `renderDatabase(store)` table.
- No display modules (`-- display:` directive ignored in pres).
- No choice handling. If a program reaches `active-choices`, render
  the panels for whatever store state we have; no clickable options.
- **At most one `[code]` block per slide.** The parser enforces this
  with a parse error on the second `[code]` of any slide.

## Code-block behavior

- Acts like the web-v2 editor: live re-run on input (per-block
  debounce), tab/return/shift-tab indent keybindings.
- Editor + output panels mount only when the slide is at its final
  reveal (`state.reveal === slide.overlayCount`). Before then, the
  segment-by-segment `<pre>` is shown read-only as today.
- At the final reveal, the `<pre>` is replaced by an Editor seeded
  with the concatenated segments (with `[pause]` already stripped at
  parse time) or with the in-memory edit map's text if present. An
  **initial run** fires immediately so output panels aren't blank.
- Output panels render in opt order directly below the editor:
  `[timeline,tuples]` → timeline above DB; `[tuples,timeline]` →
  reverse.
- Edits never propagate back to the `.pres` file. The pres renderer
  owns a `Map<(slideIdx, blockIdx), string>` that survives
  mount/teardown for the session.

### Mid-reveal vs final-reveal display

The static `<pre>` (mid-reveal) shows the *original* parsed segments;
the editor (final reveal) shows the *edited* text if any. This
mismatch is intentional — `[pause]` segmenting is a property of the
source file, not the user's working text — and is not displayed back
to the user explicitly.

## Editor class

New file `ts/src/v2/editor.ts`. A reusable textarea wrapper used by
both web-v2 and pres.

```ts
type SaveBackend = "none" | "server" | "url-param";

interface EditorOptions {
  host: HTMLElement;             // container; Editor builds the textarea inside
  initial: string;
  saveBackend: SaveBackend;
  saveTarget?: string;           // filename for "server", param name for "url-param"
  onChange?: (value: string) => void;  // fires on every keystroke (post-keybinding)
}

class Editor {
  constructor(opts: EditorOptions);
  get value(): string;
  set value(v: string): void;
  focus(): void;
  destroy(): void;             // remove DOM, drop listeners
}
```

Responsibilities:

- Builds the `<textarea>` inside `host`.
- Installs keybindings: tab/shift-tab indent (selection-aware),
  return auto-indent. These are universal across all three backends.
  Web-v2-specific bindings (ctrl-s save, ctrl-]/[ file cycle,
  ctrl-space detach) stay in `web-v2.ts` and attach a *separate*
  listener after the Editor is constructed.
- Calls `onChange` on every input event, after any keybinding has
  applied. Pres uses this for live re-run + edit-map snapshot.
- Implements persistence per `saveBackend`:
  - `none`: no durable saves; caller handles everything via `onChange`.
  - `server`: debounced `PUT /api/v2-file/<saveTarget>` mirroring
    web-v2's current `schedulePut`.
  - `url-param`: writes to the `b64url`-encoded URL parameter, mirroring
    web-v2's playground mode.

Web-v2 is rewritten to instantiate an `Editor` for its source
textarea, passing `saveBackend: "server"` or `"url-param"` as
appropriate. Its existing custom-key handlers (save, file cycle, etc.)
attach independently as a sibling keydown listener.

## Shared CSS

Both `index-v2.html` and `index-pres.html` currently inline their
styles. Factor a single stylesheet `ts/styles/shared.css`, served at
`/styles/shared.css` (new server route). Content:

- Timeline SVG / sidebar (`.timeline-svg`, `#timeline-toolbar`, etc.).
- `#db` and its child classes (`.head`, `.interval`, `.ref`, `.sym`,
  `.pred`, `.var`, `.group-heading`).
- Editor textarea base look (font, padding, monospace, tab-size).

The shared sheet ships theme-neutral defaults; concrete colors live
under `.mode-light` / `.mode-dark` rules in each page's own
stylesheet. **`index-v2.html` gains `class="mode-dark"` on `<body>`**
to keep its current look under the new theming scheme.

## Output helpers

New file `ts/src/v2/render-output.ts`:

```ts
export function renderTuples(host: HTMLElement, store: Store): void;
export function renderTimelineH(host: HTMLElement, store: Store): void;
```

Both whole-replace the contents of `host`. No module-level state, no
event listeners owned by the helper. `renderTuples` is the body of
`renderDatabase` from `web-v2.ts` with `dbEl` parameterized.
`renderTimelineH` wraps the existing `renderTimeline` from
`./v2/timeline.js` with hard-coded horizontal options.

Web-v2 keeps its orientation toggle by calling either `renderTimelineH`
or an analogous `renderTimelineV` (factored at the same time).

## Pres code-block lifecycle

Owned entirely by `ts/src/pres/render.ts`. Per slide change:

1. **Entering final reveal of a slide that has a `[code]` block:**
   - Replace the static `<pre>` with a fresh DOM container.
   - Build host divs (one per opt) below it in opt order.
   - Construct `new Editor({ host, initial, saveBackend: "none",
     onChange })`, where `initial` is the edit-map text if present
     else the concatenated segment text.
   - `onChange` does: write to edit map; debounced `runAndRender()`.
   - Immediately call `runAndRender()` once for the initial render.
2. **Leaving final reveal (reveal decreases, slide changes, or doc
   unmount):**
   - Snapshot `editor.value` into the edit map (in case the trailing
     debounced run hasn't fired yet).
   - `editor.destroy()`.
   - Remove the output host divs.
   - Re-mount the static `<pre>` with original segments.

`runAndRender()` is local to the pres code-block module:

```ts
function runAndRender(source: string, hosts: { timeline?: HTMLElement; tuples?: HTMLElement }): void {
  const parsed = parse(source);
  if ("message" in parsed) {
    showError(hosts, `parse error line ${parsed.line}: ${parsed.message}`);
    return;
  }
  const { store, status } = runFixpoint(parsed, GAS, TUPLE_GAS);
  if (status.kind === "gas") {
    showError(hosts, `gas exceeded (${GAS} iter)`);
    return;
  }
  if (hosts.timeline) renderTimelineH(hosts.timeline, store);
  if (hosts.tuples) renderTuples(hosts.tuples, store);
}
```

`showError` replaces *both* output hosts with a single error row spanning
them (`host.innerHTML = '<div class="pres-eval-error">...</div>'` in
each), so the layout doesn't jump on transient errors.

`GAS` / `TUPLE_GAS` reuse the constants from `web-v2.ts`; export them
from a new `ts/src/v2/limits.ts` for sharing.

## Milestones

1. Factor `renderTuples` / `renderTimelineH` (and `renderTimelineV`)
   out of `web-v2.ts` into `ts/src/v2/render-output.ts`. Confirm
   web-v2 still works.
2. Move shared CSS into `ts/styles/shared.css`; add server route;
   `<link>` from both HTMLs. `index-v2`'s `<body>` gains
   `class="mode-dark"`.
3. Build the Editor class (`ts/src/v2/editor.ts`). Migrate web-v2 to
   use it for the source textarea, passing `saveBackend: "server"` /
   `"url-param"`. Confirm web-v2 still works including save behavior.
4. Pres: enforce single-`[code]`-per-slide in the parser. Wire the
   code-block lifecycle (mount/teardown at final reveal, edit map,
   initial run, debounced re-run, error display).
5. Polish: snapshot on slide change, parse/gas error layout, tab-key
   cursor positioning edge cases.

Each milestone leaves both `index-v2` and `index-pres` working.

## Out of scope

- Choice handling (`active-choices` results render output panels with
  whatever store state exists; no clickable options).
- Display modules (`-- display: foo.js` directive ignored).
- Vertical timeline in pres.
- Info pane (components/options listing).
- Persisting pres edits to disk.
- Per-block `gas` override syntax.

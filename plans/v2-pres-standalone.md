# standalone slides

Goal: produce a single self-contained `foo.html` file from `foo.pres` that
opens directly in a browser (no dev server, no fetch). The HTML embeds the
original `.pres` source as a string literal and uses the existing parse +
render pipeline at load time.

This is intentionally a minimal change: we are not pre-rendering slides to
HTML, we are not splitting the bundle, and we are not adding any new
runtime features. We just package what already exists.

## Constraints

- Source-of-truth stays in `ts/src/pres/{types,parse,render,main}.ts`. The
  standalone HTML must run the same code paths as the dev server. No
  forking.
- The output is one file. CSS and JS get inlined. No external CDN, no
  network requests after load.
- The `.pres` source must round-trip: opening `foo.html` and viewing the
  embedded source should give back the exact contents of `foo.pres`.

## Pieces

### 0. Build-time decisions

- **`[today]` resolves at build time, not load time.** Currently
  `parse.ts:87` resolves `[today]` whenever `parse()` runs, which for a
  standalone deck means the viewer's current date. We want the date
  frozen to when the file was built. Implementation: in the CLI,
  substitute `[today]` in the raw `.pres` source string before
  embedding it (same `YYYY-MM-DD` format `todayStr()` produces). The
  embedded source therefore no longer contains `[today]`; `parse.ts`'s
  own substitution becomes a no-op for standalone files and continues
  to work for the dev server.
- **Pre-substitute body mode to avoid a light→dark flash.** Cheap
  pre-parse: scan the `.pres` source for a `mode:` line inside a
  `[metadata][% ... %]` body and, if it says `dark`, emit
  `<body class="mode-dark">` in the standalone HTML instead of the
  template's hardcoded `mode-light`. If absent or `light`, leave the
  default. Don't try to share code with the real parser — a single
  regex over the metadata body is enough.

### 1. Read source from an embedded string (small `main.ts` change)

Currently `ts/src/pres/main.ts:5` resolves the doc name from
`location.search` and fetches it from `/data/pres/`. Add one branch at
the top of `load()`:

```ts
const embedded = (window as any).__PRES_SOURCE__;
if (typeof embedded === "string") return embedded;
// fall through to existing fetch path
```

That preserves the current dev-server workflow (`index-pres.html` keeps
working unchanged) while letting the standalone HTML pre-populate the
source.

### 2. Single-file JS bundle

The dev page loads `/src/pres/main.js` as an ES module that imports
`parse.js`, `render.js`, and several `../v2/*` modules (`editor.js`,
`render-output.js`, `parse.js`, `fixpoint.js`). To inline into one HTML
file we need a bundler step that follows those imports.

Use **esbuild** (already a common dependency; if not present, add it as
a devDependency in `ts/package.json`). One invocation:

```
esbuild ts/src/pres/main.ts \
  --bundle \
  --format=esm \
  --target=es2020 \
  --outfile=ts/dist-pres/pres.bundle.js
```

No minification — keep the output readable so a curious viewer can
inspect it. (`--minify` is an easy follow-up if size matters.)

The existing `tsc`-based build keeps producing per-file `dist/`; we
don't touch it. The bundle is a separate artifact used only by the
standalone build.

### 3. HTML template

The standalone HTML differs from `ts/index-pres.html` in two places:

- the embedded source script tag, placed *before* the bundle so the
  bundle's `load()` sees `window.__PRES_SOURCE__`
- the `<script>` tag points at the inlined bundle, not `/src/pres/main.js`

Rather than maintain a second copy of `index-pres.html`, treat the
existing one as the template and do simple string substitution:

```
<script type="module" src="/src/pres/main.js"></script>
   →
<script>window.__PRES_SOURCE__ = {JSON.stringify(presSource)};</script>
<script type="module">{bundleSource}</script>
```

If the template marker drifts, fail loudly. No regex acrobatics — exact
string match.

The `<title>` should be derived from the `.pres` metadata title if
present, otherwise the input filename. Substitute `<title>Presentation</title>`
similarly. Optional polish; do last.

### 4. CLI

Add `ts/src/pres/build-standalone.ts`:

```ts
// usage: tsx ts/src/pres/build-standalone.ts <input.pres> [<output.html>]
```

Steps:
1. Read input file.
2. Run esbuild via its JS API (`import { build } from "esbuild"`) on
   `ts/src/pres/main.ts` with `write: false`, capturing the bundle
   contents as a string. This avoids a temp file on disk.
3. Read `ts/index-pres.html`.
4. Perform the substitutions described in §3.
5. Write the result to `<output.html>` (default: the input's basename
   with `.pres` replaced by `.html`, written to the current working
   directory — *not* alongside the input).

Wire it into `ts/package.json` scripts as `build:pres`:

```
"build:pres": "tsx src/pres/build-standalone.ts"
```

Per CLAUDE.md, any throwaway TS scripts live under `ts/src/`, not
`/tmp`.

### 5. Test

Manual smoke test:
1. `cd ts && npx tsx src/pres/build-standalone.ts data/pres/example.pres`
2. Open the produced `example.html` (in CWD) directly in a browser
   (file://).
3. Verify slides render, reveals work, code blocks evaluate, and
   `t`/`d` toggles still flip outputs.

Edge cases to eyeball:
- `.pres` source containing `</script>` (would break the embedded
  string tag). Mitigation: `JSON.stringify` already escapes `<`/`>`/`/`
  if we use `JSON.stringify(s).replace(/</g, "\\u003c")`. Apply that
  defensively.
- `mode: dark` metadata — confirm no light-mode flash on load (the
  build pre-substitutes `<body class="mode-dark">`; see §0).
- `[today]` in source — confirm it is replaced with the build date in
  the embedded string, not the viewer's current date.

No automated test is needed for the bundling step itself; a broken
bundle fails loudly at script load.

## Out of scope (call out, don't do)

- Pre-rendering slide HTML at build time (would duplicate the renderer).
- Splitting the editor/eval bundle out from the bare slide viewer
  (would let a "read-only" deck ship much smaller; defer).
- Hosting multiple decks behind one index page.
- Watch mode / auto-rebuild.

## File touch list

- `ts/src/pres/main.ts` — add embedded-source branch in `load()`.
- `ts/src/pres/build-standalone.ts` — new CLI.
- `ts/package.json` — add `esbuild` devDep and `build:pres` script.
- (no changes to `parse.ts`, `render.ts`, `types.ts`, or `index-pres.html`.)

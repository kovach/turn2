// usage: tsx src/pres/build-standalone.ts <input.pres> [<output.html>]
//
// Produces a single self-contained HTML file: embeds the .pres source as a
// string and inlines a bundled JS build of pres/main.ts. See
// plans/v2-pres-standalone.md.

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/pres/build-standalone.ts -> ts/
const TS_ROOT = resolve(__dirname, "..", "..");
const TEMPLATE_PATH = resolve(TS_ROOT, "index-pres.html");
const ENTRY_PATH = resolve(TS_ROOT, "src", "pres", "main.ts");

const TEMPLATE_SCRIPT_TAG = `<script type="module" src="/src/pres/main.js"></script>`;
const TEMPLATE_BODY_TAG = `<body class="mode-light">`;
const TEMPLATE_TITLE_TAG = `<title>Presentation</title>`;

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Cheap pre-scan of the metadata body. Mirrors parse.ts well enough to pick
// out a `theme:` value and a `title:` for HTML head purposes.
function scanMetadata(src: string): { theme?: "light" | "dark"; title?: string } {
  // Find [metadata][% ... %] — first occurrence wins.
  const m = src.match(/\[metadata\]\[%([\s\S]*?)%\]/);
  if (!m) return {};
  const body = m[1]!;
  const out: { theme?: "light" | "dark"; title?: string } = {};
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const km = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (!km) continue;
    const key = km[1]!.toLowerCase();
    const value = km[2]!.trim();
    if (key === "theme" && (value === "light" || value === "dark")) out.theme = value;
    else if (key === "title") out.title = value;
  }
  return out;
}

function escapeForTemplate(s: string): string {
  // Source lives inside a <template> element. Standard HTML entity
  // escaping; the browser decodes `.content.textContent` for us. We only
  // need to escape `&` and `<` — `>` and quotes are safe in text content.
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function substituteOnce(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx < 0) throw new Error(`template substitution failed: did not find ${JSON.stringify(needle)} in index-pres.html`);
  if (haystack.indexOf(needle, idx + 1) >= 0) {
    throw new Error(`template substitution ambiguous: ${JSON.stringify(needle)} appears more than once in index-pres.html`);
  }
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY_PATH],
    bundle: true,
    format: "esm",
    target: "es2020",
    write: false,
    sourcemap: false,
    logLevel: "warning",
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(`esbuild produced ${result.outputFiles.length} output files; expected 1`);
  }
  return result.outputFiles[0]!.text;
}

export function buildStandaloneHtml(
  rawSource: string,
  template: string,
  bundleJs: string,
  today: string,
): string {
  const frozenSource = rawSource.replace(/\[today\]/g, today);
  const meta = scanMetadata(frozenSource);
  const injected =
    `<template id="pres-src">${escapeForTemplate(frozenSource)}</template>\n` +
    `  <script type="module">${bundleJs}</script>`;
  let out = substituteOnce(template, TEMPLATE_SCRIPT_TAG, injected);
  if (meta.theme === "dark") {
    out = substituteOnce(out, TEMPLATE_BODY_TAG, `<body class="mode-dark">`);
  }
  if (meta.title) {
    out = substituteOnce(out, TEMPLATE_TITLE_TAG, `<title>${escapeHtml(meta.title)}</title>`);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    console.error("usage: tsx src/pres/build-standalone.ts <input.pres> [<output.html>]");
    process.exit(2);
  }
  const inputPath = resolve(args[0]!);
  const outputPath = args[1]
    ? resolve(args[1]!)
    : resolve(process.cwd(), basename(inputPath).replace(/\.pres$/, "") + ".html");

  const rawSource = await readFile(inputPath, "utf8");
  const template = await readFile(TEMPLATE_PATH, "utf8");
  const bundleJs = await bundle();
  const out = buildStandaloneHtml(rawSource, template, bundleJs, todayStr());
  await writeFile(outputPath, out, "utf8");
  console.log(`wrote ${outputPath} (${out.length.toLocaleString()} bytes)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}

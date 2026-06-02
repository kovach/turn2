import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Keep ts/src/v2/overview.md in sync with the actual source files:
// every .ts file in the directory must have exactly one `# <file>.ts`
// heading in overview.md, and no heading may name a missing file.

const here = dirname(fileURLToPath(import.meta.url));
const v2Dir = join(here, "..", "v2");

const sourceFiles = new Set(
  readdirSync(v2Dir).filter((f) => f.endsWith(".ts")),
);

const overview = readFileSync(join(v2Dir, "overview.md"), "utf8");

// Top-level `# ` headings (single leading hash) that name a .ts file.
// The document title (`# v2 source overview`) is intentionally excluded.
const headings = overview
  .split("\n")
  .filter((line) => /^# \S/.test(line))
  .map((line) => line.slice(2).trim())
  .filter((h) => h.endsWith(".ts"));

// No duplicate headings.
{
  const seen = new Set<string>();
  for (const h of headings) {
    assert.ok(!seen.has(h), `duplicate heading in overview.md: ${h}`);
    seen.add(h);
  }
  console.log("PASS: overview.md has no duplicate headings");
}

const headingSet = new Set(headings);

// Same set of strings: filenames <-> headings.
{
  const missing = [...sourceFiles].filter((f) => !headingSet.has(f)).sort();
  const extra = [...headingSet].filter((h) => !sourceFiles.has(h)).sort();
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `overview.md headings out of sync with ${v2Dir}\n` +
      `  files without a heading: ${missing.join(", ") || "(none)"}\n` +
      `  headings without a file: ${extra.join(", ") || "(none)"}`,
  );
  console.log(`PASS: ${headings.length} headings match ${sourceFiles.size} .ts files`);
}

console.log("ALL v2 overview tests passed");

import assert from "node:assert/strict";
import { buildStandaloneHtml } from "../pres/build-standalone.js";

// Minimal stand-in for index-pres.html. The builder only needs to find the
// three template-tag strings it substitutes; nothing else matters for these
// tests.
const TEMPLATE = `<!DOCTYPE html>
<html><head><title>Presentation</title>
  <link rel="stylesheet" href="/styles/editor.css" />
</head>
<body class="mode-light">
  <div id="pres"></div>
  <script type="module" src="/src/pres/main.js"></script>
</body></html>`;

const FAKE_BUNDLE = "/* bundle */";
const FAKE_CSS = "/* editor css */";
const TODAY = "2099-01-02";

// 1. [today] freezes to build time.
{
  const src = `[metadata][%\n  title: t\n  date: [today]\n%]\n[slide][%s%]\nhello\n`;
  const out = buildStandaloneHtml(src, TEMPLATE, FAKE_BUNDLE, FAKE_CSS, TODAY);
  assert.ok(out.includes(TODAY), "build date should appear in embedded source");
  // The embedded source lives inside <template> and has < escaped, so the
  // literal `[today]` token (which has no `<`) would survive verbatim if we
  // forgot to substitute. Confirm we did.
  assert.ok(!out.includes("[today]"), "[today] should have been replaced");
}

// 2. `</script>` inside source is escaped so it cannot terminate the page's
//    own bundle <script> tag, and there is exactly one real </script> in
//    the output (the bundle's closing tag).
{
  const src = `[slide][%s%]\n[code][%\nconst x = "</script>";\n%]\n`;
  const out = buildStandaloneHtml(src, TEMPLATE, FAKE_BUNDLE, FAKE_CSS, TODAY);
  // The source's </script> must be defanged.
  assert.ok(out.includes("&lt;/script>"), "source </script> should be HTML-escaped");
  // Exactly one literal </script> in the output: the bundle's closing tag.
  const matches = out.match(/<\/script>/g) ?? [];
  assert.equal(matches.length, 1, `expected 1 real </script>, got ${matches.length}`);
}

// 3. Round-trip: HTML-decoding the <template> contents must reproduce the
//    source byte-for-byte. This is what the browser will do via
//    .content.textContent at load time.
{
  const src = `[slide][%a & b%]\n<not a tag> & ampersand & "quotes"\n[code][%\n</script>\n%]\n`;
  const out = buildStandaloneHtml(src, TEMPLATE, FAKE_BUNDLE, FAKE_CSS, TODAY);
  const m = out.match(/<template id="pres-src">([\s\S]*?)<\/template>/);
  assert.ok(m, "template tag should be present");
  // Mirror image of escapeForTemplate: decode &lt; and &amp;. Order matters
  // — decode &lt; first so that any literal `&amp;lt;` in the source
  // survives correctly.
  const decoded = m[1]!.replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  assert.equal(decoded, src, "decoded template content must equal source");
}

// 4. theme: dark in metadata pre-substitutes the body class.
{
  const src = `[metadata][%\n  theme: dark\n%]\n[slide][%s%]\n`;
  const out = buildStandaloneHtml(src, TEMPLATE, FAKE_BUNDLE, FAKE_CSS, TODAY);
  assert.ok(out.includes(`<body class="mode-dark">`), "body should be mode-dark");
  assert.ok(!out.includes(`<body class="mode-light">`), "mode-light should be gone");
}

// 5. title in metadata flows into <title>.
{
  const src = `[metadata][%\n  title: My Deck\n%]\n[slide][%s%]\n`;
  const out = buildStandaloneHtml(src, TEMPLATE, FAKE_BUNDLE, FAKE_CSS, TODAY);
  assert.ok(out.includes("<title>My Deck</title>"), "title should be substituted");
}

console.log("pres_build: ok");

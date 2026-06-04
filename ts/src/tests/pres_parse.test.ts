import assert from "node:assert/strict";
import { parse, flattenBody } from "../pres/parse.js";
import type { BodyPart, Block, Span } from "../pres/types.js";

// Strip undefined flags so deepEqual can compare against minimal literals.
function spanList(spans: Span[]): Array<Record<string, unknown>> {
  return spans.map(s => {
    const o: Record<string, unknown> = { text: s.text };
    if (s.bold) o.bold = true;
    if (s.italic) o.italic = true;
    if (s.code) o.code = true;
    return o;
  });
}

function firstPara(blocks: Block[]): Span[] {
  const p = blocks.find(b => b.kind === "para");
  assert.ok(p && p.kind === "para", "expected a paragraph block");
  return p.spans;
}

// 1. Bold / italic / inline code in a slide title produce formatted spans.
{
  const doc = parse(`[slide][% plain *i* **b** [%c%] %]\nbody\n`);
  assert.equal(doc.slides.length, 1);
  assert.deepEqual(spanList(doc.slides[0]!.title), [
    { text: "plain " },
    { text: "i", italic: true },
    { text: " " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", code: true },
  ]);
}

// 2. Nested `[% ... [% ... %] ... %]` in a title: the inline-code span keeps
//    the inner markers literal (matching the old flatten-on-read behavior).
{
  const doc = parse(`[slide][%t [%a [%b%] c%]%]\nx\n`);
  assert.deepEqual(spanList(doc.slides[0]!.title), [
    { text: "t " },
    { text: "a [%b%] c", code: true },
  ]);
}

// 3. A plain title with no markers is a single unstyled span; surrounding
//    whitespace is trimmed (titles were previously `.trim()`ed).
{
  const doc = parse(`[slide][%  Hello World  %]\nx\n`);
  assert.deepEqual(spanList(doc.slides[0]!.title), [{ text: "Hello World" }]);
}

// 4. A blank title with no body still drops the leading empty slide.
{
  const doc = parse(`[slide][%   %]\n`);
  assert.equal(doc.slides.length, 0, "blank title + no blocks should be dropped");
}

// 5. metadata `title` carries formatting; author/date stay plain.
{
  const doc = parse(`[metadata][%\n  title: My *deck*\n  author: Ada\n%]\n[slide][%s%]\nx\n`);
  assert.deepEqual(spanList(doc.metadata.title ?? []), [
    { text: "My " },
    { text: "deck", italic: true },
  ]);
  assert.equal(doc.metadata.author, "Ada");
}

// 6. Regression: inline code + formatting in body text is unchanged.
{
  const doc = parse(`[slide][%t%]\nsome *em* and [%code%] here\n`);
  assert.deepEqual(spanList(firstPara(doc.slides[0]!.blocks)), [
    { text: "some " },
    { text: "em", italic: true },
    { text: " and " },
    { text: "code", code: true },
    { text: " here" },
  ]);
}

// 7. Regression: a [code] body containing nested `[% %]` round-trips into the
//    code segment text (flattenBody is the inverse of the recursive reader).
{
  const doc = parse(`[slide][%t%]\n[code][% f([%x%]) %]\n`);
  const code = doc.slides[0]!.blocks.find(b => b.kind === "code");
  assert.ok(code && code.kind === "code");
  const joined = code.segments.map(s => s.text).join("");
  assert.ok(joined.includes("f([%x%])"), `expected nested markers preserved, got: ${JSON.stringify(joined)}`);
}

// 8. flattenBody is a faithful re-serializer of a structured body.
{
  const parts: BodyPart[] = [
    { kind: "text", text: "a " },
    { kind: "quote", parts: [{ kind: "text", text: "b " }, { kind: "quote", parts: [{ kind: "text", text: "c" }] }] },
    { kind: "text", text: " d" },
  ];
  assert.equal(flattenBody(parts), "a [%b [%c%]%] d");
}

// 9. `{ ... }` comments are dropped from the markup stream (incl. multi-line
//    and nested), and may appear in titles' surrounding markup.
{
  const doc = parse(`[slide][%t%]\nbefore {a\nb {nested} c} after\n`);
  assert.deepEqual(spanList(firstPara(doc.slides[0]!.blocks)), [
    { text: "before  after" },
  ]);
}

// 10. Braces inside a `[% %]` body are NOT comments — they belong to the
//     program text (e.g. `#js { ... }`) and must survive verbatim.
{
  const doc = parse(`[slide][%t%]\n[code][% #js f() { return 1 } %]\n`);
  const code = doc.slides[0]!.blocks.find(b => b.kind === "code");
  assert.ok(code && code.kind === "code");
  const joined = code.segments.map(s => s.text).join("");
  assert.ok(joined.includes("{ return 1 }"), `braces in code body must survive, got: ${JSON.stringify(joined)}`);
}

// 11. An unterminated `{` is treated as literal text, not swallowed.
{
  const doc = parse(`[slide][%t%]\nkeep { this\n`);
  assert.deepEqual(spanList(firstPara(doc.slides[0]!.blocks)), [
    { text: "keep { this" },
  ]);
}

// 12. Redundant-[pause] warnings: pause-then-pause and trailing pause.
{
  // Trailing pause: content, then a pause with nothing after.
  const trailing = parse(`[slide][%S%]\nhello\n[pause]\n`);
  assert.equal(trailing.warnings.length, 1, "trailing pause should warn");
  assert.match(trailing.warnings[0]!, /slide "S".*redundant \[pause\]/);

  // Pause immediately followed by pause leaves a dead middle step.
  const doubled = parse(`[slide][%S%]\na\n[pause]\n[pause]\nb\n`);
  assert.equal(doubled.warnings.length, 1, "pause-then-pause should warn");
  assert.match(doubled.warnings[0]!, /reveal step 2/);
}

// 13. No false positives: a pause with content on both sides is fine, and a
//     leading pause (empty base step, content after) is not reported.
{
  assert.deepEqual(parse(`[slide][%S%]\na\n[pause]\nb\n`).warnings, []);
  assert.deepEqual(parse(`[slide][%S%]\n[pause]\na\n`).warnings, []);
  assert.deepEqual(parse(`[slide][%S%]\nno pauses here\n`).warnings, []);
}

console.log("pres_parse: all assertions passed");

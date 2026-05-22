import assert from "node:assert/strict";
import { parse } from "../pres/parse.js";
import {
  scanTags, formatCoord, spliceRange, shiftRangesAfter, type AttrRange,
} from "../pres/svg-index.js";

// 1. parser exposes svg blocks with body + bodyOffset.
{
  const src = `[slide][%s%]\n[svg][%<svg><circle cx="10" cy="20" r="5"/></svg>%]\n`;
  const doc = parse(src);
  assert.equal(doc.slides.length, 1);
  const blocks = doc.slides[0]!.blocks;
  const svg = blocks.find(b => b.kind === "svg")!;
  assert.equal(svg.kind, "svg");
  assert.ok(svg.kind === "svg");
  assert.equal(svg.body, `<svg><circle cx="10" cy="20" r="5"/></svg>`);
  // bodyOffset should point at the first char of the body in src.
  assert.equal(src.slice(svg.bodyOffset, svg.bodyOffset + svg.body.length), svg.body);
  assert.equal(svg.reveal, 1);
  assert.equal(svg.dynamic, false);
}

// 1b. dynamic-svg opt enables drag.
{
  const src = `[slide][%s%]\n[svg][%<svg/>%][dynamic-svg]\n`;
  const doc = parse(src);
  const svg = doc.slides[0]!.blocks.find(b => b.kind === "svg")!;
  assert.ok(svg.kind === "svg");
  assert.equal(svg.dynamic, true);
}

// 2. nested [% inside [svg] body should throw.
{
  const src = `[slide][%s%]\n[svg][%<svg>[%bad%]</svg>%]\n`;
  assert.throws(() => parse(src), /\[svg\] body/);
}

// 3. svg block reveal tracks the surrounding [pause] count.
{
  const src = `[slide][%s%]\nhello [pause]\n[svg][%<svg/>%]\n`;
  const doc = parse(src);
  const svg = doc.slides[0]!.blocks.find(b => b.kind === "svg")!;
  assert.ok(svg.kind === "svg");
  assert.equal(svg.reveal, 2);
}

// 4. scanTags finds coord attribute ranges on circle.
{
  const body = `<svg><circle cx="10" cy="20.5" r="5"/></svg>`;
  const tags = scanTags(body);
  assert.equal(tags.length, 1);
  const t = tags[0]!;
  assert.equal(t.tag, "circle");
  const cx = t.ranges.get("cx")!;
  assert.equal(body.slice(cx.start, cx.end), "10");
  const cy = t.ranges.get("cy")!;
  assert.equal(body.slice(cy.start, cy.end), "20.5");
  const r = t.ranges.get("r")!;
  assert.equal(body.slice(r.start, r.end), "5");
}

// 5. scanTags handles rect, line, ellipse, text and single-quoted attrs.
{
  const body = `<svg>
  <rect x='1' y='2' width='3' height='4'/>
  <line x1="5" y1="6" x2="7" y2="8"/>
  <ellipse cx="9" cy="10" rx="11" ry="12"/>
  <text x="13" y="14">hi</text>
</svg>`;
  const tags = scanTags(body);
  assert.equal(tags.length, 4);
  assert.deepEqual(tags.map(t => t.tag), ["rect", "line", "ellipse", "text"]);
  const rect = tags[0]!;
  assert.equal(body.slice(rect.ranges.get("x")!.start, rect.ranges.get("x")!.end), "1");
  assert.equal(body.slice(rect.ranges.get("height")!.start, rect.ranges.get("height")!.end), "4");
  const ln = tags[1]!;
  assert.equal(body.slice(ln.ranges.get("x2")!.start, ln.ranges.get("x2")!.end), "7");
  const text = tags[3]!;
  assert.equal(body.slice(text.ranges.get("y")!.start, text.ranges.get("y")!.end), "14");
}

// 6. attributes not present yield no range (handles only on present attrs).
{
  const body = `<svg><circle cx="10"/></svg>`;
  const tags = scanTags(body);
  const t = tags[0]!;
  assert.ok(t.ranges.has("cx"));
  assert.ok(!t.ranges.has("cy"));
  assert.ok(!t.ranges.has("r"));
}

// 7. unrelated attributes ignored.
{
  const body = `<svg><circle id="me" class="dot" cx="10" cy="20" r="5"/></svg>`;
  const tags = scanTags(body);
  const t = tags[0]!;
  assert.equal(t.ranges.size, 3);
  assert.ok(!t.ranges.has("id"));
}

// 8. formatCoord rounds + trims.
{
  assert.equal(formatCoord(10), "10");
  assert.equal(formatCoord(10.5), "10.5");
  assert.equal(formatCoord(10.526), "10.53");
  assert.equal(formatCoord(10.0), "10");
  assert.equal(formatCoord(0.1 + 0.2), "0.3");
}

// 9. spliceRange + shiftRangesAfter keep ranges aligned after a commit.
{
  const body = `<svg><circle cx="10" cy="20" r="5"/></svg>`;
  const tags = scanTags(body);
  const t = tags[0]!;
  const cx = t.ranges.get("cx")!;
  const cy = t.ranges.get("cy")!;
  const r = t.ranges.get("r")!;
  // Replace cx="10" with cx="123" — grows by 1 char. cy and r should shift.
  const newVal = "123";
  const newBody = spliceRange(body, cx, newVal).body;
  shiftRangesAfter(t.ranges.values(), cx, newVal.length);
  assert.equal(newBody.slice(cx.start, cx.end), "123");
  assert.equal(newBody.slice(cy.start, cy.end), "20");
  assert.equal(newBody.slice(r.start, r.end), "5");
}

// 10. shrink also works (newVal shorter than old).
{
  const body = `<svg><circle cx="100" cy="200"/></svg>`;
  const tags = scanTags(body);
  const t = tags[0]!;
  const cx = t.ranges.get("cx")!;
  const cy = t.ranges.get("cy")!;
  const newVal = "1";
  const newBody = spliceRange(body, cx, newVal).body;
  shiftRangesAfter(t.ranges.values(), cx, newVal.length);
  assert.equal(newBody.slice(cx.start, cx.end), "1");
  assert.equal(newBody.slice(cy.start, cy.end), "200");
}

console.log("pres_svg ok");

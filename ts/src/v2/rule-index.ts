// DOM-free core of the rule browser (plans/v2-rule-browser.md): splits the
// source into segments — one per top-level item of the parse, as character
// ranges — and indexes every use of every predicate by the segment it occurs
// in and how it is used.
//
// Segments come from the parser's own boundaries (`Span.line..endLine` on
// each top-level item), so they agree with the offside rule as `parse`
// applies it. Two lexical extensions:
//   - indented comment-only lines right after an item are part of it (they
//     sit inside its offside block, but carry no tokens);
//   - the column-0 comment lines directly above an item (no blank line
//     between) are its doc comment.

import type { Program, RuleAtom } from "./types.js";
import type { Atom, Span } from "./term.js";

export interface SourceRange {
  start: number; // char offset, inclusive
  end: number;   // char offset, exclusive (the item's last line, without its newline)
}

export type SegmentKind = "rule" | "acc-rule" | "acc-decl" | "js" | "js-def";

export interface Segment {
  kind: SegmentKind;
  name: string;        // rule name (explicit or auto), or the declared relation/function
  line: number;        // 1-indexed first line of the code (a `#def` line included)
  endLine: number;     // last line of the code, trailing indented comments included
  code: SourceRange;   // `line..endLine`
  doc?: SourceRange;   // the doc comment lines, when present
  docLine?: number;
}

// The text a card shows and edits: doc comment and code together.
export function segmentRange(s: Segment): SourceRange {
  return { start: s.doc?.start ?? s.code.start, end: s.code.end };
}

export function segmentFirstLine(s: Segment): number {
  return s.docLine ?? s.line;
}

export type Role =
  | "assert"     // ~p  +p  ^p  ~>p
  | "match"      // p  >p  (also the body of an acc rule)
  | "not"        // not p
  | "constrain"  // !( ... p ... )
  | "intercept"  // {p ... => ...}
  | "acc-head"   // body / p ...
  | "declare";   // #acc p : ...   #js-def p ...   #js (p ...)

export interface Use {
  seg: number;   // index into `RuleIndex.segs`
  role: Role;
  span: Span;    // the atom's span (columns when the parser has them)
}

export interface RuleIndex {
  segs: Segment[];
  uses: Map<string, Use[]>;
  // Segment index for each source line inside a segment (doc lines included).
  segOfLine: Map<number, number>;
}

// Start offset of each line: `starts[line - 1]`.
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

const isCommentLine = (l: string): boolean => l.trimStart().startsWith("--");
const isBlank = (l: string): boolean => l.trim() === "";

export function buildRuleIndex(text: string, program: Program): RuleIndex {
  const lines = text.split("\n");
  const starts = lineStarts(text);
  const lineEnd = (line: number): number => starts[line - 1]! + lines[line - 1]!.length;

  type Item = { kind: SegmentKind; name: string; span: Span; visit: (seg: number) => void };
  const items: Item[] = [];
  const uses = new Map<string, Use[]>();
  const add = (pred: string, u: Use): void => {
    let us = uses.get(pred);
    if (us === undefined) uses.set(pred, (us = []));
    us.push(u);
  };

  for (const r of program.rules) {
    items.push({ kind: "rule", name: r.name, span: r.span, visit: (seg) => walkBody(r.body, seg, add) });
  }
  for (const r of program.accRules) {
    items.push({
      kind: "acc-rule", name: r.name, span: r.span,
      visit: (seg) => {
        walkBody(r.body, seg, add);
        const h = headOf(r.head);
        if (h !== null) add(h, { seg, role: "acc-head", span: r.headSpan ?? r.span });
      },
    });
  }
  for (const d of program.accDecls.values()) {
    items.push({
      kind: "acc-decl", name: d.relation, span: d.span,
      visit: (seg) => add(d.relation, { seg, role: "declare", span: nameSpan(lines, d.span.line, d.relation) }),
    });
  }
  for (const d of program.jsDefs.values()) {
    items.push({
      kind: "js", name: d.name, span: d.span,
      visit: (seg) => add(d.name, { seg, role: "declare", span: nameSpan(lines, d.span.line, d.name) }),
    });
  }
  for (const clauses of program.jsRels.values()) {
    for (const d of clauses) {
      if (d.builtin) continue;
      items.push({
        kind: "js-def", name: d.name, span: d.span,
        visit: (seg) => add(d.name, { seg, role: "declare", span: nameSpan(lines, d.span.line, d.name) }),
      });
    }
  }
  items.sort((a, b) => a.span.line - b.span.line);

  const segs: Segment[] = [];
  const segOfLine = new Map<number, number>();
  let prevEnd = 0; // last line claimed by the previous segment
  for (const it of items) {
    const line = it.span.line;
    let endLine = it.span.endLine ?? line;
    // Trailing indented comment-only lines belong to the item.
    while (endLine < lines.length) {
      const next = lines[endLine]!;
      if (isBlank(next) || !/^\s/.test(next) || !isCommentLine(next)) break;
      endLine++;
    }
    // Doc comment: column-0 comment lines directly above.
    let docLine = line;
    while (docLine - 1 > prevEnd && lines[docLine - 2]!.startsWith("--")) docLine--;
    const seg: Segment = {
      kind: it.kind, name: it.name, line, endLine,
      code: { start: starts[line - 1]!, end: lineEnd(endLine) },
    };
    if (docLine < line) {
      seg.doc = { start: starts[docLine - 1]!, end: lineEnd(line - 1) };
      seg.docLine = docLine;
    }
    const idx = segs.length;
    segs.push(seg);
    for (let l = docLine; l <= endLine; l++) segOfLine.set(l, idx);
    it.visit(idx);
    prevEnd = endLine;
  }
  return { segs, uses, segOfLine };
}

function headOf(a: Atom): string | null {
  const t = a.terms[0];
  return t !== undefined && t.tag === "Symbol" ? t.name : null;
}

// The span of the first whole-word `name` on `line` (for declarations,
// whose parse spans carry only the line).
function nameSpan(lines: string[], line: number, name: string): Span {
  const text = lines[line - 1] ?? "";
  const re = new RegExp(`(^|[\\s(])(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=[\\s(),]|$)`);
  const m = re.exec(text);
  if (m === null) return { line };
  const startCol = m.index + m[1]!.length;
  return { line, startCol, endCol: startCol + name.length };
}

function walkBody(body: RuleAtom[], seg: number, add: (p: string, u: Use) => void): void {
  for (const a of body) {
    switch (a.tag) {
      case "Atom": {
        if (a.marker === "constrain") {
          for (const s of a.subAtoms ?? []) {
            const h = headOf(s.atom);
            if (h !== null) add(h, { seg, role: s.negated ? "not" : "constrain", span: a.span });
          }
          break;
        }
        if (a.marker === "ask") break; // only variables, no predicate
        const h = headOf(a.atom);
        if (h === null) break;
        const role: Role = a.marker === "match" ? (a.negated ? "not" : "match") : "assert";
        add(h, { seg, role, span: a.span });
        break;
      }
      case "Sub":
        walkBody(a.body, seg, add);
        break;
      case "Exception": {
        const h = headOf(a.left);
        if (h !== null) add(h, { seg, role: "intercept", span: a.leftSpan ?? a.span });
        walkBody(a.right, seg, add);
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- queries

// Queries will grow (plans/v2-rule-browser.md §5); a result is a list of
// titled groups of segments, each with the spans to mark, so the view
// needs no change for a new kind.
export type Query = { kind: "uses"; pred: string };

export interface ResultCard {
  seg: number;
  marks: Span[];
}

export interface QueryResult {
  groups: { title: string; cards: ResultCard[] }[];
}

// The query bar's text. For now a bare predicate name; null when empty.
export function parseQuery(text: string): Query | null {
  const t = text.trim();
  return t === "" ? null : { kind: "uses", pred: t };
}

const USE_GROUPS: { title: string; roles: Role[] }[] = [
  { title: "Asserted by", roles: ["assert", "acc-head"] },
  { title: "Matched by", roles: ["match", "not", "constrain"] },
  { title: "Intercepted by", roles: ["intercept"] },
  { title: "Declared by", roles: ["declare"] },
];

export function runQuery(q: Query, index: RuleIndex): QueryResult {
  const us = index.uses.get(q.pred) ?? [];
  const groups: QueryResult["groups"] = [];
  for (const g of USE_GROUPS) {
    const bySeg = new Map<number, Span[]>();
    for (const u of us) {
      if (!g.roles.includes(u.role)) continue;
      let ms = bySeg.get(u.seg);
      if (ms === undefined) bySeg.set(u.seg, (ms = []));
      ms.push(u.span);
    }
    if (bySeg.size === 0) continue;
    const cards = [...bySeg].sort((a, b) => a[0] - b[0]).map(([seg, marks]) => ({ seg, marks }));
    groups.push({ title: g.title, cards });
  }
  return { groups };
}

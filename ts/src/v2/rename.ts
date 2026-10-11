// Pure (DOM-free) core of the editor's "rename symbol / variable" code action.
// The editor layer (editor.ts) owns the context menu and applies the edit;
// this module decides what is under the cursor and which spans to rewrite.
//
// It works on the source text lexically, not on the parse, so it still works
// while the program has an error, and so every occurrence has an exact column
// (the parser rewrites dots, macros and exceptions, and bracket aggregates
// lose their line breaks). The lexing mirrors `tokenize` (parse.ts) as far as
// renaming needs:
//   - `--` starts a comment to the end of the line.
//   - An identifier is a maximal run of non-separator chars (separators:
//     whitespace and `( ) , . ; [ ] { } |`) with any leading marker chars
//     (`+ ~ ^ ! ?`, and `-` unless a digit follows) stripped. Runs that are
//     not a Symbol/Variable token after stripping (`->`, `=>`, `@js`, `=`,
//     `*internal`) are not identifiers.
//   - Definitions follow the offside rule: a line starting at column 0 opens
//     a new one, except while a `[ ... ]` aggregate is still open.
//
// Scopes:
//   - A Symbol (relation or constant) is renamed everywhere in the file:
//     matches, emits, `!(...)`, exceptions, aggregates, dot chains, and the
//     `#acc` / `#js-def` / `#js` names.
//     Two exclusions: the `#def <name>` rule name (a separate namespace), and
//     `#js` / `#js-def` bodies and parameters (JS code), of which only the
//     relation/function name is renamed.
//   - A Variable is renamed within its definition, which is a rule's scope.
//     Variables inside `#js` / `#js-def` blocks are JS parameters and are not
//     offered.

import { isSymbolToken, isVariableToken } from "./parse.js";

export type RenameKind = "symbol" | "variable";

export interface RenameTarget {
  kind: RenameKind;
  name: string;
  // Offsets of the identifier under the cursor (marker chars excluded).
  start: number;
  end: number;
}

export interface TextRange {
  start: number;
  end: number;
}

const SEP = /[\s(),.;[\]{}|]/;

function isMarkerCh(ch: string): boolean {
  return ch === "+" || ch === "~" || ch === "^" || ch === "!" || ch === "?" || ch === ">";
}

// An identifier occurrence: offsets into the whole text.
interface Ident {
  name: string;
  kind: RenameKind;
  start: number;
  end: number;
}

// The kind of an identifier-shaped token, or null for punctuation-like runs.
function identKind(tok: string): RenameKind | null {
  if (isVariableToken(tok)) return "variable";
  if (!isSymbolToken(tok)) return null;
  // Symbols the user can name: word-ish starts. Excludes `*`-internal
  // symbols, `@js`, `=`, `->`, `=>`, a standalone `/`, etc.
  return /^([a-z0-9:]|-[0-9])/.test(tok) ? "symbol" : null;
}

// Identifiers in `text` between `from` and `to` (a comment-free slice of one
// line), with absolute offsets.
function scanIdents(text: string, from: number, to: number, out: Ident[]): void {
  let i = from;
  while (i < to) {
    if (SEP.test(text[i]!)) { i++; continue; }
    let s = i;
    while (i < to && !SEP.test(text[i]!)) i++;
    // Strip leading markers; `-` is the match marker unless it starts a
    // negative number.
    while (s < i && (isMarkerCh(text[s]!) || (text[s] === "-" && !/[0-9]/.test(text[s + 1] ?? "")))) s++;
    if (s >= i) continue;
    const name = text.slice(s, i);
    const kind = identKind(name);
    if (kind !== null) out.push({ name, kind, start: s, end: i });
  }
}

// A top-level definition: its line range plus the identifiers that take part
// in renaming.
interface Block {
  start: number; // offset of the first line
  end: number;   // offset just past the last line
  js: boolean;   // a `#js` / `#js-def` block
  idents: Ident[];
}

function scanBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let bracketDepth = 0;
  let pos = 0;
  for (const line of text.split("\n")) {
    const lineStart = pos;
    const lineEnd = pos + line.length;
    pos = lineEnd + 1;
    const c = line.indexOf("--");
    const code = c >= 0 ? line.slice(0, c) : line;
    if (code.trim() === "") {
      if (cur !== null) cur.end = lineEnd;
      continue;
    }
    const opens = cur === null || (bracketDepth === 0 && !/\s/.test(code[0]!));
    if (opens) {
      cur = { start: lineStart, end: lineEnd, js: /^#js(-def)?\s/.test(code) || /^#js(-def)?$/.test(code.trim()), idents: [] };
      blocks.push(cur);
      if (cur.js) {
        // Only the name: `#js-def NAME ...` or `#js (NAME ...)`.
        const m = /^#js-def\s+([^\s({]+)/.exec(code) ?? /^#js\s*\(\s*([^\s()]+)/.exec(code);
        if (m !== null) {
          const s = lineStart + m.index + m[0].length - m[1]!.length;
          const kind = identKind(m[1]!);
          if (kind === "symbol") cur.idents.push({ name: m[1]!, kind, start: s, end: s + m[1]!.length });
        }
        continue;
      }
    }
    cur!.end = lineEnd;
    if (cur!.js) continue;
    for (const ch of code) {
      if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    }
    let from = lineStart;
    // `#def NAME`: the rule name is not a relation.
    const def = /^\s*#def\s+(\S+)/.exec(code);
    if (def !== null) from = lineStart + def[0].length;
    scanIdents(text, from, lineStart + code.length, cur!.idents);
  }
  return blocks;
}

// The identifier at offset `pos` (inside it, or with the caret just past its
// end), or null when there is nothing renameable there: whitespace,
// punctuation, a comment, a `#def` rule name, or JS code.
export function renameTargetAt(text: string, pos: number): RenameTarget | null {
  for (const b of scanBlocks(text)) {
    if (pos < b.start || pos > b.end) continue;
    for (const id of b.idents) {
      if (pos >= id.start && pos <= id.end) {
        return { kind: id.kind, name: id.name, start: id.start, end: id.end };
      }
    }
  }
  return null;
}

// Every occurrence the rename rewrites, in text order. Always includes the
// target itself.
export function renameOccurrences(text: string, target: RenameTarget): TextRange[] {
  const blocks = scanBlocks(text);
  const scope = target.kind === "symbol"
    ? blocks
    : blocks.filter((b) => target.start >= b.start && target.start <= b.end);
  const out: TextRange[] = [];
  for (const b of scope) {
    for (const id of b.idents) {
      if (id.kind === target.kind && id.name === target.name) out.push({ start: id.start, end: id.end });
    }
  }
  return out;
}

// Why `newName` can't replace `target`, or null if it can. Rejects names of
// the other kind (a Variable can't become a Symbol), names the lexer would
// split or re-read, and names already in use in the target's scope (a
// rename would merge two relations or capture a variable).
export function renameError(text: string, target: RenameTarget, newName: string): string | null {
  if (newName === "") return "name is empty";
  if (newName === target.name) return null;
  if (SEP.test(newName) || newName.includes("--")) return "name cannot contain spaces, punctuation ( ) , . ; [ ] { } | or '--'";
  const kind = identKind(newName);
  if (target.kind === "variable" && kind !== "variable") return "a variable name must start with an uppercase letter or '_'";
  if (target.kind === "symbol" && kind !== "symbol") return "a symbol name must start with a lowercase letter, digit or ':'";
  const blocks = scanBlocks(text);
  const scope = target.kind === "symbol"
    ? blocks
    : blocks.filter((b) => target.start >= b.start && target.start <= b.end);
  for (const b of scope) {
    for (const id of b.idents) {
      if (id.name === newName) {
        return target.kind === "symbol"
          ? `'${newName}' is already used in this file`
          : `'${newName}' is already used in this rule`;
      }
    }
  }
  return null;
}

// `text` with every range replaced by `newName`. Ranges must be sorted and
// disjoint (as renameOccurrences returns them).
export function applyRename(text: string, ranges: TextRange[], newName: string): string {
  let out = "";
  let last = 0;
  for (const r of ranges) {
    out += text.slice(last, r.start) + newName;
    last = r.end;
  }
  return out + text.slice(last);
}

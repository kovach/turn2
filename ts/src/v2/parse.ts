// v2 parser. Flat-syntax language per notes/turn-program-1.t.
//
// Three stages: `lex` (characters into positioned tokens: words, string
// literals, punctuation; comments dropped), `tokenize` (the structural pass:
// atoms, sub-rules, commands, exception blocks, rule boundaries) and
// parseProgram (the token stream into rules + acc declarations). Only `lex`
// reads source text. Hashconsing is *not* applied here — callers run terms
// through hashcons after parsing.

import type { Atom, Term, Span } from "./term.js";
import type { AccColumn, AccDecl, AccRule, Actor, JsDef, JsRelDef, Marker, Program, Rule, RuleAtom, SubConstrain } from "./types.js";
import { exprTerms, isActor } from "./types.js";
import { accOp, UNIT, type AccOp } from "./acc-ops.js";
import { builtinJsRels, isBuiltinRel } from "./builtins.js";

export interface ParseError {
  line: number;
  message: string;
}

// --- Lexing ------------------------------------------------------------------
//
// `lex` reads the source once, character by character, into positioned
// tokens: a word (a maximal run of characters that are not whitespace,
// punctuation or a quote), a string literal (its source text, quotes and
// escapes included — a string is the Symbol of that name, term.ts), or one
// punctuation character. A `--` outside a string ends the line. Nothing
// after this reads source text again: the structural pass (`tokenize`) and
// the term parser work on these tokens, so punctuation or `--` inside a
// string means nothing to them. Only a `#js` / `#js-def` directive is read
// raw — its body is JavaScript.
//
// Whitespace survives as adjacency: two tokens are glued when one ends
// where the next starts (`adjacent`). The term syntax splits only on
// whitespace and parens, so `termWords` re-glues runs like `a.b` or `x,`
// inside a compound, and markers, `=`, `/`, `>` and `);` are recognized by
// what they touch.

// `col` / `end` are 0-based source columns on `line` (`end` exclusive).
export interface Lex {
  kind: "word" | "str" | "punct";
  text: string;
  line: number;
  col: number;
  end: number;
}

// One non-blank source line's tokens, or a `#js` / `#js-def` directive
// (its body possibly spanning lines up to a column-0 `}`).
type LexLine =
  | { kind: "toks"; line: number; indent: number; toks: Lex[] }
  | { kind: "js"; line: number; indent: number; name: string; sig: string; body: string; endLine: number };

const PUNCT = new Set(["(", ")", ",", ";", ".", "{", "}", "[", "]"]);

function isSpace(c: string): boolean {
  const code = c.charCodeAt(0);
  return code <= 32 ? code === 32 || (code >= 9 && code <= 13) : code >= 128 && /\s/.test(c);
}

function lexLine(src: string, line: number): Lex[] | ParseError {
  const out: Lex[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "-" && src[i + 1] === "-") break;
    if (isSpace(c)) { i++; continue; }
    if (PUNCT.has(c)) {
      out.push({ kind: "punct", text: c, line, col: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === "\"") {
      let j = i + 1;
      for (; j < src.length && src[j] !== "\""; j++) {
        if (src[j] !== "\\") continue;
        const e = src[j + 1];
        if (e !== "\"" && e !== "\\") {
          return { line, message: `bad escape '\\${e ?? ""}' in a string (only \\" and \\\\)` };
        }
        j++;
      }
      if (j >= src.length) return { line, message: "unterminated string" };
      out.push({ kind: "str", text: src.slice(i, j + 1), line, col: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    let j = i + 1;
    while (j < src.length) {
      const d = src[j]!;
      if (isSpace(d) || PUNCT.has(d) || d === "\"" || (d === "-" && src[j + 1] === "-")) break;
      j++;
    }
    out.push({ kind: "word", text: src.slice(i, j), line, col: i, end: j });
    i = j;
  }
  return out;
}

const JS_LINE = /^(\s*)#(js|js-def)(\s|$)/;

// The non-blank lines in order, lexed as they are reached, so the first
// error in the file (lexical or structural) is the one reported. Ends after
// yielding an error.
function* lex(input: string): Generator<LexLine | ParseError> {
  const lines = input.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = li + 1;
    const src = lines[li]!;
    const js = JS_LINE.exec(src);
    if (js !== null) {
      const d = lexJs(lines, li, js[1]!.length, js[2]!);
      yield d;
      if ("message" in d) return;
      li = d.endLine - 1;
      continue;
    }
    const toks = lexLine(src, line);
    if (!Array.isArray(toks)) { yield toks; return; }
    if (toks.length === 0) continue;
    yield { kind: "toks", line, indent: toks[0]!.col, toks };
  }
}

// `#js` (term function) and `#js-def` (relation clause,
// plans/v2-js-relations.md) share the body-collection rules. Two forms,
// neither of which counts braces (so the body may contain arbitrary JS —
// strings, templates, nested braces):
//   - one-liner: `#js (sig) { body }` — `}` is the last char, body is
//     between the first `{` and the last `}` on the line.
//   - multi-line: `#js (sig) {` then *indented* body lines, closed by a `}`
//     at column 0 (the first unindented line after the `{`).
// Read raw (no comment stripping) so the body survives verbatim.
function lexJs(lines: string[], li: number, indent: number, name: string): Extract<LexLine, { kind: "js" }> | ParseError {
  const line = li + 1;
  const rawLine = lines[li]!;
  const sigPart = rawLine.slice(indent + 1 + name.length);
  const bracePos = sigPart.indexOf("{");
  if (bracePos < 0) {
    return { line, message: `'#${name}' signature must be followed by '{'` };
  }
  const sig = sigPart.slice(0, bracePos).trim();
  const afterBrace = sigPart.slice(bracePos + 1);
  const afterTrim = afterBrace.trim();
  let body: string;
  let endLi = li;
  if (afterTrim === "") {
    const bodyLines: string[] = [];
    for (;;) {
      endLi++;
      if (endLi >= lines.length) {
        return { line, message: `'#${name}' body is missing a closing '}' at column 0` };
      }
      const bl = lines[endLi]!;
      const blank = bl.trim() === "";
      const indented = bl.length > 0 && /\s/.test(bl[0]!);
      if (!blank && !indented) {
        if (bl[0] !== "}") {
          return { line: endLi + 1, message: `'#${name}' body must be indented; expected '}' at column 0` };
        }
        break;
      }
      bodyLines.push(bl);
    }
    body = bodyLines.join("\n");
  } else if (afterTrim.endsWith("}")) {
    body = afterBrace.slice(0, afterBrace.lastIndexOf("}"));
  } else {
    return { line, message: `'#${name}' body must close with '}' on the same line, or put '{' last and indent the body below` };
  }
  return { kind: "js", line, indent, name, sig, body, endLine: endLi + 1 };
}

// `a` ends exactly where `b` starts: no whitespace between them.
function adjacent(a: Lex | undefined, b: Lex | undefined): boolean {
  return a !== undefined && b !== undefined && a.line === b.line && a.end === b.col;
}

function isPunct(t: Lex | undefined, text: string): boolean {
  return t !== undefined && t.kind === "punct" && t.text === text;
}

// `toks` without the first `n` characters of its first token (a marker or
// `>` glued to what follows), the token dropped when nothing is left.
function dropChars(toks: Lex[], n: number): Lex[] {
  const first = toks[0];
  if (first === undefined) return toks;
  if (first.text.length <= n) return toks.slice(1);
  return [{ ...first, text: first.text.slice(n), col: first.col + n }, ...toks.slice(1)];
}

// Term-level words of a token run, for `parseTerms`: each paren alone, and
// every maximal run of adjacent other tokens glued into one (the term
// syntax splits only on whitespace and parens). A string literal must
// stand alone.
function termWords(toks: Lex[]): string[] | ParseError {
  const out: string[] = [];
  let run: Lex[] = [];
  const flush = (): ParseError | null => {
    if (run.length === 0) return null;
    if (run.length > 1 && run.some((t) => t.kind === "str")) {
      return { line: run[0]!.line, message: "a string literal must be a term of its own (separate it with a space)" };
    }
    out.push(run.map((t) => t.text).join(""));
    run = [];
    return null;
  };
  for (const t of toks) {
    const paren = isPunct(t, "(") || isPunct(t, ")");
    if (paren || !adjacent(run[run.length - 1], t)) {
      const e = flush();
      if (e !== null) return e;
    }
    if (paren) out.push(t.text);
    else run.push(t);
  }
  const e = flush();
  return e ?? out;
}

// Index of the first token at paren depth 0 satisfying `hit`, or -1.
function findTop(toks: Lex[], hit: (t: Lex) => boolean, open = ["("], close = [")"]): number {
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "punct" && open.includes(t.text)) depth++;
    else if (t.kind === "punct" && close.includes(t.text)) depth--;
    else if (depth === 0 && hit(t)) return i;
  }
  return -1;
}

// A top-level `-> weight` (fed the removed `#agg` / `#reactive`).
function hasTopArrow(toks: Lex[]): boolean {
  return findTop(toks, (t) => t.kind === "word" && t.text.includes("->")) >= 0;
}

// Split at top-level `,` tokens.
function splitTopCommas(toks: Lex[]): Lex[][] {
  const out: Lex[][] = [];
  let depth = 0;
  let cur: Lex[] = [];
  for (const t of toks) {
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) depth--;
    else if (depth === 0 && isPunct(t, ",")) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  out.push(cur);
  return out;
}

// `startCol`/`endCol` on atom / equal / exception tokens are 0-indexed
// source columns covering the token's full extent including the marker /
// `=` / braces (plans/v2-atom-span-provenance.md). Payloads are the lexed
// tokens themselves, so a fragment (an exception's right-hand side) is
// parsed in place, with its true columns.
type Token =
  | { tag: "open"; line: number }
  | { tag: "close"; sequence: boolean; line: number }
  | { tag: "atom"; marker: Marker; after: boolean; toks: Lex[]; line: number; startCol: number; endCol: number }
  // Exception block `{...}` (plans/v2-exceptions.md); `toks` is the inside.
  | { tag: "exception"; toks: Lex[]; line: number; startCol: number; endCol: number }
  // Bracket aggregation `[ … ]` and `#macro … :=` are still tokenized, only
  // so the parser can report that they were removed (in favour of `#acc`).
  | { tag: "aggcomp"; line: number; endLine: number }
  | { tag: "macroDef"; line: number }
  | { tag: "equal"; toks: Lex[]; line: number; startCol: number; endCol: number }
  // `#js` / `#js-def` carry their raw `sig` and `body` (`endLine`: the `}`
  // line of a multi-line body); other commands their argument tokens.
  | { tag: "command"; name: string; argToks: Lex[]; sig?: string; body?: string; line: number; endLine?: number }
  | { tag: "ruleEnd"; line: number }
  | { tag: "dot"; line: number }
  | { tag: "semi"; line: number }
  // Standalone `/` (whitespace on both sides) separating an acc rule's body
  // from its head (plans/v2-acc-relations.md §1.2). `do/rest` stays a Symbol.
  | { tag: "slash"; line: number };

export type { Token };

// Parsed `#<name> ...` line. Consumed in parseProgram and not exposed.
type Command =
  | { kind: "def"; name: string; line: number }
  | { kind: "acc"; decl: AccDecl }
  | { kind: "js"; name: string; params: string[]; body: string; line: number }
  | { kind: "js-rel"; def: JsRelDef; line: number }
  | { kind: "exit"; line: number };

export function parse(input: string): Program | ParseError {
  const toks = tokenize(input);
  if (!Array.isArray(toks)) return toks;
  return parseProgram(toks);
}

function isMarkerChar(ch: string): boolean {
  return ch === "-" || ch === "~" || ch === "+" || ch === "^" || ch === "!" || ch === "?";
}

function markerOf(ch: string): Marker {
  switch (ch) {
    case "-": return "match";
    case "~": return "episode";
    case "+": return "fact";
    case "^": return "anchor";
    case "?": return "ask";
    case "!": return "constrain";
    default: throw new Error(`internal: not a marker char '${ch}'`);
  }
}

// The structural pass: lexed lines into the token stream `parseProgram`
// reads. Offside rule: a line whose first token is at column 0 starts a new
// definition; indented lines continue the enclosing one. Blank lines carry
// no meaning (parseBodyItems additionally ignores ruleEnd inside an open
// `(`-group, so a multi-line sub may return to column 0).
export function tokenize(input: string): Token[] | ParseError {
  const lines = lex(input);
  const tokens: Token[] = [];
  // A `[` still open at the end of a line takes the next lines' tokens.
  const more = (): Lex[] | ParseError | null => {
    const next = lines.next();
    if (next.done === true) return null;
    const l = next.value;
    if ("message" in l) return l;
    return l.kind === "toks" ? l.toks : null;
  };
  for (const l of lines) {
    if ("message" in l) return l;
    if (l.indent === 0 && tokens.length > 0) tokens.push({ tag: "ruleEnd", line: l.line });
    if (l.kind === "js") {
      tokens.push({ tag: "command", name: l.name, argToks: [], sig: l.sig, body: l.body, line: l.line, endLine: l.endLine });
      continue;
    }
    const err = scanTokens(l.toks, tokens, more);
    if (err !== null) return err;
  }
  return tokens;
}

// One line's tokens into structural tokens, appended to `out`. `more`
// supplies the following lines' tokens while a `[` is open (null: none).
function scanTokens(toks: Lex[], out: Token[], more: () => Lex[] | ParseError | null): ParseError | null {
  let k = 0;
  let atomStart = true;
  // Standalone `/`: the acc-rule separator iff whitespace-delimited (`do/rest`
  // and `a/b` stay inside Symbol tokens).
  const slashAt = (i: number): boolean => {
    const t = toks[i];
    return t !== undefined && t.kind === "word" && t.text === "/" && !adjacent(toks[i - 1], t) && !adjacent(t, toks[i + 1]);
  };
  while (k < toks.length) {
    const t = toks[k]!;
    const line = t.line;
    if (t.kind === "punct") {
      if (t.text === "(" && atomStart) {
        out.push({ tag: "open", line });
        k++;
        continue;
      }
      if (t.text === ")") {
        const sequence = isPunct(toks[k + 1], ";") && adjacent(t, toks[k + 1]);
        out.push({ tag: "close", sequence, line });
        k += sequence ? 2 : 1;
        atomStart = true;
        continue;
      }
      if (t.text === ",") {
        k++;
        atomStart = true;
        continue;
      }
      if (t.text === ";") {
        // Bare `;` (not `);` — folded into the `close` token above): a
        // `semi` for parseBodyItems to wrap the line's items into a
        // sequence sub.
        out.push({ tag: "semi", line });
        k++;
        atomStart = true;
        continue;
      }
      if (t.text === ".") {
        // `.` is always a top-level separator: spaced `a . b`, leading-dot
        // `.bar` / `.(sub)`, and the dot side of glued `foo.bar` (the atom
        // scan below breaks on `.`).
        out.push({ tag: "dot", line });
        k++;
        atomStart = true;
        continue;
      }
      if (t.text === "{") {
        // Exception block `{p t1..tn => e}` (plans/v2-exceptions.md),
        // closed on the same line.
        let depth = 0;
        let end = -1;
        for (let j = k; j < toks.length && toks[j]!.line === line; j++) {
          if (isPunct(toks[j], "{")) depth++;
          else if (isPunct(toks[j], "}") && --depth === 0) { end = j; break; }
        }
        if (end < 0) {
          return { line, message: "unterminated '{' (exception block must close on the same line)" };
        }
        out.push({ tag: "exception", toks: toks.slice(k + 1, end), line, startCol: t.col, endCol: toks[end]!.end });
        k = end + 1;
        atomStart = true;
        continue;
      }
      if (t.text === "}") return { line, message: "stray '}'" };
      if (t.text === "[") {
        // Bracket aggregation `[ Q | op V ]` (removed; reported by the
        // parser), continuing across lines to the matching `]`.
        if (!atomStart) {
          return { line, message: "'[' must start a query item (separate it with ',')" };
        }
        let depth = 0;
        let end = -1;
        for (let j = k; end < 0; j++) {
          if (j >= toks.length) {
            const next = more();
            if (next === null) return { line, message: "unterminated '['" };
            if (!Array.isArray(next)) return next;
            toks = toks.concat(next);
          }
          if (isPunct(toks[j], "[")) depth++;
          else if (isPunct(toks[j], "]") && --depth === 0) end = j;
        }
        out.push({ tag: "aggcomp", line, endLine: toks[end]!.line });
        k = end + 1;
        atomStart = true;
        continue;
      }
      if (t.text === "]") return { line, message: "stray ']'" };
    }
    if (slashAt(k)) {
      // Acc rule separator `body / head` (plans/v2-acc-relations.md).
      out.push({ tag: "slash", line });
      k++;
      atomStart = true;
      continue;
    }
    if (atomStart && t.kind === "word" && t.text.startsWith("#")) {
      const nameIdx = t.text === "#" ? k + 1 : k;
      const nameTok = toks[nameIdx];
      const name = nameIdx === k ? t.text.slice(1) : nameTok?.line === line ? nameTok.text : "";
      if (name.length === 0) {
        return { line, message: "'#' must be followed by a command name" };
      }
      if (name === "macro") {
        // `#macro head P1..Pn := [ ... ]` (removed): consume the header
        // through the `:=`; the `[ ... ]` tokenizes as usual.
        const walrus = findTop(toks.slice(nameIdx + 1), (x) => x.kind === "word" && x.text.includes(":="), ["(", "["], [")", "]"]);
        if (walrus < 0) {
          return { line, message: "'#macro' definition requires ':=' on the same line" };
        }
        out.push({ tag: "macroDef", line });
        k = nameIdx + 1 + walrus + 1;
        atomStart = true;
        continue;
      }
      if (name === "js" || name === "js-def") {
        return { line, message: `'#${name}' must start its own line` };
      }
      if (name === "def") {
        // `#def <name>` consumes only the name; the rule body may follow on
        // the same line.
        const defTok = toks[nameIdx + 1];
        const argToks = defTok !== undefined && defTok.line === line ? [defTok] : [];
        out.push({ tag: "command", name, argToks, line });
        k = nameIdx + 1 + argToks.length;
        atomStart = true;
        continue;
      }
      out.push({ tag: "command", name, argToks: toks.slice(nameIdx + 1), line });
      k = toks.length;
      atomStart = true;
      continue;
    }
    // An atom: tokens through balanced parens, ending at a top-level
    // `, ) . ; { } [ ]` or standalone `/`.
    const start = k;
    let depth = 0;
    while (k < toks.length) {
      const c = toks[k]!;
      // Choice-actor group `?[actor]` (plans/v2-choice-actors.md): a `[`
      // glued to a leading `?` is part of the atom, not a bracket
      // aggregation. Consume through the `]`.
      if (depth === 0 && k === start + 1 && isPunct(c, "[") && toks[start]!.kind === "word" && toks[start]!.text === "?" && adjacent(toks[start], c)) {
        let close = -1;
        for (let j = k + 1; j < toks.length && toks[j]!.line === c.line; j++) {
          if (isPunct(toks[j], "]")) { close = j; break; }
        }
        if (close < 0) {
          return { line: c.line, message: "unterminated '[' after '?' (actor group must close on the same line)" };
        }
        k = close + 1;
        continue;
      }
      if (c.kind === "punct") {
        if (depth === 0 && c.text !== "(") break;
        if (c.text === "(") depth++;
        else if (c.text === ")") depth--;
      } else if (depth === 0 && slashAt(k)) {
        break;
      }
      k++;
    }
    const atom = toks.slice(start, k);
    const first = atom[0]!;
    const last = atom[atom.length - 1]!;
    const span = { line: first.line, startCol: first.col, endCol: last.end };
    // `=` is the equality marker only when standing alone (`=foo` stays a
    // Symbol-headed match atom).
    if (first.kind === "word" && first.text === "=" && !adjacent(first, atom[1])) {
      out.push({ tag: "equal", toks: atom.slice(1), ...span });
    } else {
      let marker: Marker = "match";
      let body = atom;
      if (first.kind === "word" && isMarkerChar(first.text[0]!)) {
        marker = markerOf(first.text[0]!);
        body = dropChars(body, 1);
      }
      // `>p` / `~>p`: continue after `p` (see `after` in types.ts).
      const after = body[0] !== undefined && body[0].kind === "word" && body[0].text.startsWith(">");
      if (after) body = dropChars(body, 1);
      out.push({ tag: "atom", marker, after, toks: body, ...span });
    }
    atomStart = false;
  }
  return null;
}

// Temporary per-rule body item. `sub` carries an unresolved inner body
// (still a `BodyItem[]`) so the dot-desugar pass can thread an outer
// fresh var into the sub's first atom across the recursion. Final
// `desugarBody` produces a real `RuleAtom[]`.
type BodyItem =
  | { kind: "atom"; atom: RuleAtom }            // RuleAtom with tag "Atom" or "Equal"
  | { kind: "sub"; inner: BodyItem[]; sequence: boolean; span: Span }
  | { kind: "dot"; line: number }
  // Exception block. `right` is still BodyItems so `desugarBody` can
  // resolve the fragment's dots with the containing rule's shared
  // fresh-name minting (no `_dotN` capture between rule and fragment).
  | { kind: "exception"; left: Atom; leftSpan: Span; right: BodyItem[]; span: Span };

type AtomItem = Extract<RuleAtom, { tag: "Atom" }>;

// Migration message for the removed aggregation forms
// (plans/v2-caret-fresh-left.md §5.4).
const REMOVED_AGG = (what: string): string =>
  `${what} was removed: aggregation is '#acc' (declare '#acc rel : col… @op' and compute it with ` +
  `'body / rel …' rules; negate with 'not rel …') — see the tutorial, "Aggregates"`;

function parseCommand(tok: Extract<Token, { tag: "command" }>): Command | ParseError {
  if (tok.name === "def") {
    const name = tok.argToks[0]?.text;
    if (name === undefined) {
      return { line: tok.line, message: "'#def' requires a rule name" };
    }
    if (!isSymToken(name)) {
      return { line: tok.line, message: `'#def' name must be a lowercase symbol (got '${name}')` };
    }
    if (/^r\d+$/.test(name)) {
      return { line: tok.line, message: `'#def' name '${name}' is reserved for auto-naming` };
    }
    return { kind: "def", name, line: tok.line };
  }
  if (tok.name === "agg" || tok.name === "reactive") {
    return { line: tok.line, message: REMOVED_AGG(`'#${tok.name}'`) };
  }
  if (tok.name === "js") {
    return parseJsCommand(tok.sig ?? "", tok.body ?? "", tok.line);
  }
  if (tok.name === "js-def") {
    return parseJsRelCommand(tok.sig ?? "", tok.body ?? "", tok.line);
  }
  if (tok.name === "acc") {
    const decl = parseAccDecl(tok.argToks, tok.line);
    if ("message" in decl) return decl;
    return { kind: "acc", decl };
  }
  if (tok.name === "exit") {
    if (tok.argToks.length > 0) {
      return { line: tok.line, message: "'#exit' takes no arguments" };
    }
    return { kind: "exit", line: tok.line };
  }
  return { line: tok.line, message: `unknown command '#${tok.name}'` };
}

// Parse a `#js` directive: `sig` is the `(name params...)` text from the
// signature line; `body` is the raw JS between the `{` and the column-0 `}`
// (collected by the tokenizer, verbatim).
function parseJsCommand(sig: string, body: string, line: number): Command | ParseError {
  if (!sig.startsWith("(") || !sig.endsWith(")")) {
    return { line, message: "'#js' signature must be '(name params...)'" };
  }
  const inner = sig.slice(1, -1).trim();
  const parts = inner.length === 0 ? [] : inner.split(/\s+/);
  if (parts.length === 0) {
    return { line, message: "'#js' signature must name the function" };
  }
  const name = parts[0]!;
  if (!isSymToken(name)) {
    return { line, message: `'#js' name must be a lowercase symbol (got '${name}')` };
  }
  if (/^r\d+$/.test(name)) {
    return { line, message: `'#js' name '${name}' is reserved for auto-naming` };
  }
  // Params are ordinary JS identifiers in the function body — not language
  // symbol/variable tokens — so uppercase (`X`) is fine; what matters is that
  // `new Function(...params, body)` accepts them.
  const params = parts.slice(1);
  for (const p of params) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p)) {
      return { line, message: `'#js' parameter must be a valid JS identifier (got '${p}')` };
    }
  }
  return { kind: "js", name, params, body, line };
}

// Parse a `#js-def` directive (plans/v2-js-relations.md): `sig` is the
// unparenthesized `name ±p1 .. ±pn` text between the command name and the
// `{`; `body` is the raw JS generator source between the braces. Each param
// carries a mode: `+` = bound at call (a JS parameter of the generator),
// `-` = enumerated (yielded).
function parseJsRelCommand(sig: string, body: string, line: number): Command | ParseError {
  const parts = sig.trim().length === 0 ? [] : sig.trim().split(/\s+/);
  if (parts.length === 0) {
    return { line, message: "'#js-def' signature must be 'name ±param...'" };
  }
  const name = parts[0]!;
  if (!isSymToken(name)) {
    return { line, message: `'#js-def' name must be a lowercase symbol (got '${name}')` };
  }
  if (/^r\d+$/.test(name)) {
    return { line, message: `'#js-def' name '${name}' is reserved for auto-naming` };
  }
  const params: JsRelDef["params"] = [];
  for (const p of parts.slice(1)) {
    const mode = p[0];
    if (mode !== "+" && mode !== "-") {
      return { line, message: `'#js-def' parameter must be marked '+' (bound) or '-' (enumerated) (got '${p}')` };
    }
    const pname = p.slice(1);
    // `+` params become JS parameters of the generator; validate `-` names
    // the same way for uniformity.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(pname)) {
      return { line, message: `'#js-def' parameter must be a valid JS identifier (got '${p}')` };
    }
    if (params.some((q) => q.name === pname)) {
      return { line, message: `duplicate '#js-def' parameter '${pname}' (in '${name}')` };
    }
    params.push({ mode, name: pname });
  }
  return { kind: "js-rel", def: { name, params, body, span: { line } }, line };
}


// Last source line of the tokens `from..to` (exclusive) of one top-level
// item. A `ruleEnd` belongs to the line that starts the *next* item, so it
// is skipped.
function lastLineOf(tokens: Token[], from: number, to: number): number {
  let last = 0;
  for (let k = from; k < to; k++) {
    const t = tokens[k]!;
    if (t.tag === "ruleEnd") continue;
    const end = t.tag === "aggcomp" ? t.endLine : t.tag === "command" ? (t.endLine ?? t.line) : t.line;
    if (end > last) last = end;
  }
  return last;
}

function parseProgram(tokens: Token[]): Program | ParseError {
  const rules: Rule[] = [];
  const jsDefs = new Map<string, JsDef>();
  // Seeded with the built-in relations (builtins.ts); user clauses join them.
  const jsRels = builtinJsRels();
  const accDecls = new Map<string, AccDecl>();
  const accRules: AccRule[] = [];
  // Ordinary and acc rules in source order, for shared auto-naming.
  const allRules: { name: string; explicitName?: string; span: Span }[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.tag === "ruleEnd") { i++; continue; }
    if (t.tag === "macroDef") {
      return { line: t.line, message: REMOVED_AGG("'#macro'") };
    }
    let explicitName: string | undefined;
    let startLine = t.line;
    const iStart = i;
    if (t.tag === "command") {
      const cmd = parseCommand(t);
      if ("message" in cmd) return cmd;
      i++;
      if (cmd.kind === "acc") {
        if (accDecls.has(cmd.decl.relation)) {
          return { line: t.line, message: `duplicate '#acc' declaration for '${cmd.decl.relation}'` };
        }
        cmd.decl.span.endLine = lastLineOf(tokens, iStart, i);
        accDecls.set(cmd.decl.relation, cmd.decl);
        continue;
      }
      if (cmd.kind === "exit") {
        // Drop every rule/command occurring after this point.
        break;
      }
      if (cmd.kind === "js") {
        if (jsDefs.has(cmd.name)) {
          return { line: cmd.line, message: `duplicate '#js' function '${cmd.name}'` };
        }
        if (isBuiltinRel(cmd.name)) {
          return { line: cmd.line, message: `'${cmd.name}' is a built-in relation and cannot be redefined` };
        }
        if (jsRels.has(cmd.name)) {
          return { line: cmd.line, message: `'#js' name '${cmd.name}' is already a '#js-def' relation` };
        }
        jsDefs.set(cmd.name, {
          name: cmd.name, params: cmd.params, body: cmd.body,
          span: { line: cmd.line, endLine: lastLineOf(tokens, iStart, i) },
        });
        continue;
      }
      if (cmd.kind === "js-rel") {
        const def = cmd.def;
        def.span.endLine = lastLineOf(tokens, iStart, i);
        if (isBuiltinRel(def.name)) {
          return { line: cmd.line, message: `'${def.name}' is a built-in relation and cannot be redefined` };
        }
        if (jsDefs.has(def.name)) {
          return { line: cmd.line, message: `'#js-def' name '${def.name}' is already a '#js' function` };
        }
        const clauses = jsRels.get(def.name);
        if (clauses === undefined) {
          jsRels.set(def.name, [def]);
          continue;
        }
        if (clauses[0]!.params.length !== def.params.length) {
          return {
            line: cmd.line,
            message: `'#js-def ${def.name}' clauses must agree on arity (got ${def.params.length}, expected ${clauses[0]!.params.length})`,
          };
        }
        const modes = def.params.map((p) => p.mode).join("");
        if (clauses.some((c) => c.params.map((p) => p.mode).join("") === modes)) {
          return { line: cmd.line, message: `duplicate '#js-def ${def.name}' mode signature (${def.params.map((p) => p.mode).join(" ")})` };
        }
        clauses.push(def);
        continue;
      }
      // cmd.kind === "def" — attach to the rule that follows. Skip any
      // ruleEnd tokens between `#def` and the rule body.
      explicitName = cmd.name;
      startLine = cmd.line;
      while (i < tokens.length && tokens[i]!.tag === "ruleEnd") i++;
      if (i >= tokens.length) {
        return { line: cmd.line, message: "'#def' must precede a rule" };
      }
      const next = tokens[i]!;
      if (next.tag === "command") {
        return { line: next.line, message: "'#def' must precede a rule" };
      }
    }

    const pos = { i };
    const bodyRes = parseBodyItems(tokens, pos, startLine, false);
    if (!Array.isArray(bodyRes)) return bodyRes;
    i = pos.i;
    const body = bodyRes;
    // Acc rule `body / head` (plans/v2-acc-relations.md §1.2): the body
    // parse stopped at a top-level `/`.
    if (i < tokens.length && tokens[i]!.tag === "slash") {
      const slashLine = tokens[i]!.line;
      i++;
      const headPos = { i };
      const headRes = parseBodyItems(tokens, headPos, slashLine, false);
      if (!Array.isArray(headRes)) return headRes;
      i = headPos.i;
      if (i < tokens.length && tokens[i]!.tag === "slash") {
        return { line: tokens[i]!.line, message: "an acc rule has exactly one '/'" };
      }
      const acc = buildAccRule(body, headRes, startLine, slashLine);
      if ("message" in acc) return acc;
      acc.span.endLine = lastLineOf(tokens, iStart, i);
      if (explicitName !== undefined) acc.explicitName = explicitName;
      accRules.push(acc);
      allRules.push(acc);
      continue;
    }
    if (body.length > 0) {
      const usedNames = new Set<string>();
      collectUsedNames(body, usedNames);
      const counter = { n: 1 };
      const desugared = desugarBody(body, usedNames, counter, undefined);
      if (!Array.isArray(desugared)) return desugared;
      saturateArity(desugared);
      const rule: Rule = { name: "", body: desugared, span: { line: startLine, endLine: lastLineOf(tokens, iStart, i) } };
      if (explicitName !== undefined) rule.explicitName = explicitName;
      rules.push(rule);
      allRules.push(rule);
    } else if (explicitName !== undefined) {
      return { line: startLine, message: "'#def' must precede a rule" };
    }
  }

  const nameErr = resolveRuleNames(allRules);
  if (nameErr !== null) return nameErr;

  // Acc relations (plans/v2-acc-relations.md): heads declared and shaped,
  // names disjoint from every other kind of declaration. Checked after the
  // loop since declaration order is free.
  for (const [name, decl] of accDecls) {
    const line = decl.span.line;
    if (jsDefs.has(name)) return { line, message: `'#acc' name '${name}' is already a '#js' function` };
    if (isBuiltinRel(name)) return { line, message: `'${name}' is a built-in relation and cannot be redefined` };
    if (jsRels.has(name)) return { line, message: `'#acc' name '${name}' is already a '#js-def' relation` };
  }
  for (const r of accRules) {
    const err = validateAccRule(r, accDecls);
    if (err !== null) return err;
  }

  return { rules, jsDefs, jsRels, accDecls, accRules };
}

// Assemble an acc rule from its parsed halves (plans/v2-acc-relations.md
// §1.2). The body desugars like an ordinary rule (dots, arity saturation)
// and is then restricted to match atoms and `=`; the head must be exactly
// one unmarked atom. Declaration-dependent checks (head
// declared, arity, agg-column shape) run in `validateAccRule` once every
// `#acc` line has been seen.
function buildAccRule(
  bodyItems: BodyItem[],
  headItems: BodyItem[],
  startLine: number,
  slashLine: number,
): AccRule | ParseError {
  const usedNames = new Set<string>();
  collectUsedNames(bodyItems, usedNames);
  collectUsedNames(headItems, usedNames);
  const counter = { n: 1 };
  const body = desugarBody(bodyItems, usedNames, counter, undefined);
  if (!Array.isArray(body)) return body;
  saturateArity(body);
  for (const a of body) {
    if (a.tag === "Equal") continue;
    if (a.tag === "Atom" && a.marker === "match" && a.subAtoms === undefined && !a.after) continue;
    const what =
      a.tag === "Sub" ? "a sub-rule" :
      a.tag === "Exception" ? "an exception block" :
      a.tag === "Atom" ? `a '${markerChar(a.marker)}${a.after ? ">" : ""}' atom` : a.tag;
    return { line: a.span.line, message: `acc rule bodies contain only matches and '=' (found ${what})` };
  }
  const headDesugared = desugarBody(headItems, usedNames, counter, undefined);
  if (!Array.isArray(headDesugared)) return headDesugared;
  if (headDesugared.length !== 1) {
    return { line: slashLine, message: "an acc rule head is exactly one atom after '/'" };
  }
  const h = headDesugared[0]!;
  if (h.tag !== "Atom" || h.marker !== "match" || h.subAtoms !== undefined || h.after) {
    return { line: h.span.line, message: "an acc rule head is a plain atom (no marker)" };
  }
  if (h.negated) {
    return { line: h.span.line, message: "an acc rule head cannot be negated ('not' is a read)" };
  }
  saturateArity([h]);
  const headSym = h.atom.terms[0];
  if (headSym === undefined || headSym.tag !== "Symbol") {
    return { line: h.span.line, message: "an acc rule head must start with a relation name" };
  }
  return { name: "", body, head: h.atom, headSpan: h.span, span: { line: startLine } };
}

function markerChar(m: Marker): string {
  switch (m) {
    case "match": return "-";
    case "episode": return "~";
    case "fact": return "+";
    case "anchor": return "^";
    case "ask": return "?";
    case "constrain": return "!";
  }
}

// Declaration-dependent acc rule checks; also unwraps the head's agg column
// from `(@op T)` / `()` to the bare contribution term.
function validateAccRule(
  r: AccRule,
  accDecls: Map<string, AccDecl>,
): ParseError | null {
  const line = r.span.line;
  const headSym = r.head.terms[0]!;
  const name = headSym.tag === "Symbol" ? headSym.name : "";
  const decl = accDecls.get(name);
  if (decl === undefined) {
    return { line, message: `acc rule head '${name}' is not declared with '#acc'` };
  }
  const args = r.head.terms.length - 1;
  if (args !== decl.columns.length) {
    return { line, message: `acc rule head '${name}' has ${args} column(s); '#acc ${name}' declares ${decl.columns.length}` };
  }
  if (decl.aggIndex !== null) {
    const col = decl.columns[decl.aggIndex]!;
    const op = col.kind === "agg" ? accOp(col.op)! : undefined;
    const pos = decl.aggIndex + 1;
    const t = r.head.terms[pos]!;
    // `(@op T)` wrapper or `()` — unwrap to the contribution term.
    if (t.tag === "Atom") {
      const first = t.atom.terms[0];
      if (first !== undefined && first.tag === "Symbol" && first.name.startsWith("@")) {
        if (first.name.slice(1) !== op!.name) {
          return { line, message: `acc rule head '${name}': column ${pos} is declared '@${op!.name}', not '${first.name}'` };
        }
        if (t.atom.terms.length !== op!.arity + 1) {
          return { line, message: `acc rule head '${name}': '(${first.name} ...)' takes ${op!.arity} argument(s)` };
        }
        r.head.terms[pos] = op!.arity === 0 ? UNIT : t.atom.terms[1]!;
      } else if (t.atom.terms.length === 0) {
        if (op!.arity !== 0) {
          return { line, message: `acc rule head '${name}': '@${op!.name}' takes a contribution term, not '()'` };
        }
      } else if (op!.arity === 0) {
        return { line, message: `acc rule head '${name}': '@${op!.name}' takes no argument (write '()')` };
      }
    } else if (op!.arity === 0) {
      return { line, message: `acc rule head '${name}': '@${op!.name}' takes no argument (write '()')` };
    }
  }
  return null;
}


// Parse one rule body's tokens into `BodyItem`s. Consumes from `pos.i`
// until a rule boundary (`ruleEnd` / command at depth 0) or end of
// tokens; `pos.i` is left at the terminator. With `fragment` set (parsing
// an exception RHS), rule boundaries cannot occur and nested exception
// blocks / commands are errors.
function parseBodyItems(
  tokens: Token[],
  pos: { i: number },
  startLine: number,
  fragment: boolean,
): BodyItem[] | ParseError {
  const body: BodyItem[] = [];
  // Each stack frame is the inner body of the enclosing sub (or the
  // outer rule body at index 0). We also track each open sub so its
  // `sequence` flag and span can be patched at the matching close.
  // `wrapStart` marks the items-index where the current line's
  // content began in this frame; a bare `;` wraps items from
  // wrapStart..end into a sequence sub. `lastLine` triggers the
  // wrapStart reset when execution crosses a line boundary.
  // `needsContent` is true at line-start and immediately after a
  // semi; it gates errors like `; a`, `a; ;`, `(;)`.
  type Frame = { items: BodyItem[]; wrapStart: number; lastLine: number; needsContent: boolean };
  const stack: Frame[] = [{ items: body, wrapStart: 0, lastLine: startLine, needsContent: true }];
  const openSubs: { item: { kind: "sub"; inner: BodyItem[]; sequence: boolean; span: Span } }[] = [];
  let depth = 0;

  while (pos.i < tokens.length) {
    const tok = tokens[pos.i]!;
    if (tok.tag === "ruleEnd") {
      if (fragment || depth > 0) { pos.i++; continue; }
      break;
    }
    if (tok.tag === "command") {
      if (fragment) return { line: tok.line, message: `'#${tok.name}' command not allowed in an exception block` };
      if (depth > 0) return { line: tok.line, message: `'#${tok.name}' command not allowed inside a sub-rule` };
      break;
    }
    // Line-change reset: a `;` only wraps content emitted on the
    // current line within this frame, so realign wrapStart on every
    // line boundary.
    const top = stack[stack.length - 1]!;
    if (tok.line !== top.lastLine) {
      top.wrapStart = top.items.length;
      top.lastLine = tok.line;
      top.needsContent = true;
    }
    if (tok.tag === "open") {
      const inner: BodyItem[] = [];
      const subItem = { kind: "sub" as const, inner, sequence: false, span: { line: tok.line } };
      top.items.push(subItem);
      top.needsContent = false;
      stack.push({ items: inner, wrapStart: 0, lastLine: tok.line, needsContent: true });
      openSubs.push({ item: subItem });
      depth++;
      pos.i++;
      continue;
    }
    if (tok.tag === "close") {
      if (depth === 0) return { line: tok.line, message: "unmatched ')'" };
      stack.pop();
      const opened = openSubs.pop()!;
      if (tok.sequence) opened.item.sequence = true;
      depth--;
      pos.i++;
      continue;
    }
    if (tok.tag === "semi") {
      if (top.needsContent) {
        return { line: tok.line, message: "';' with no content on this line" };
      }
      const last = top.items[top.items.length - 1]!;
      if (last.kind === "dot") {
        return { line: tok.line, message: "';' after '.' is not allowed" };
      }
      const wrapped = top.items.splice(top.wrapStart, top.items.length - top.wrapStart);
      top.items.push({ kind: "sub", inner: wrapped, sequence: true, span: { line: tok.line } });
      // wrapStart stays put: a following `;` on the same line wraps
      // the new sub plus any items appended after it.
      top.needsContent = true;
      pos.i++;
      continue;
    }
    if (tok.tag === "dot") {
      top.items.push({ kind: "dot", line: tok.line });
      pos.i++;
      continue;
    }
    if (tok.tag === "exception") {
      if (fragment) return { line: tok.line, message: "exception RHS may not contain an exception" };
      const exc = parseExceptionBlock(tok);
      if ("message" in exc) return exc;
      top.items.push(exc);
      top.needsContent = false;
      pos.i++;
      continue;
    }
    if (tok.tag === "aggcomp") {
      return { line: tok.line, message: REMOVED_AGG("bracket aggregation '[ … ]'") };
    }
    if (tok.tag === "equal") {
      const parsedEq = parseEqual(tok.toks, tok.line, tok.startCol, tok.endCol);
      if ("message" in parsedEq) return parsedEq;
      top.items.push({ kind: "atom", atom: parsedEq });
      top.needsContent = false;
      pos.i++;
      continue;
    }
    if (tok.tag === "macroDef") {
      // `parseProgram` consumes these; reaching one here means a `#macro`
      // appeared where a rule body was expected (e.g. right after `#def`).
      return { line: tok.line, message: REMOVED_AGG("'#macro'") };
    }
    if (tok.tag === "slash") {
      // Acc rule separator (plans/v2-acc-relations.md). Legal only at the
      // top level of a rule body; parseProgram consumes it and parses the
      // head that follows.
      if (fragment) return { line: tok.line, message: "'/' is not allowed in an exception block" };
      if (depth > 0) return { line: tok.line, message: "'/' is not allowed inside a sub-rule" };
      break;
    }
    const parsed = parseAtom(tok.toks, tok.marker, tok.line, tok.startCol, tok.endCol);
    if ("message" in parsed) return parsed;
    if (tok.after) {
      if (parsed.tag !== "Atom" || (parsed.marker !== "match" && parsed.marker !== "episode") || parsed.negated) {
        return { line: tok.line, message: "'>' (continue after) applies only to a match ('>p') or an episode ('~>p'), not to 'not'" };
      }
      parsed.after = true;
    }
    top.items.push({ kind: "atom", atom: parsed });
    top.needsContent = false;
    pos.i++;
  }

  if (depth > 0) {
    const ln = openSubs[openSubs.length - 1]!.item.span.line;
    return { line: ln, message: "unmatched '('" };
  }
  return body;
}

// Parse the inside of a `{p t1..tn => e}` exception block. See
// plans/v2-exceptions.md.
function parseExceptionBlock(tok: Extract<Token, { tag: "exception" }>): BodyItem | ParseError {
  const { toks, line } = tok;
  // The top-level `=>`, possibly glued to its neighbours (`p=>q`): split
  // its word.
  const arrow = findTop(toks, (t) => t.kind === "word" && t.text.includes("=>"), ["(", "{"], [")", "}"]);
  if (arrow < 0) return { line, message: "exception block requires '=>'" };
  const word = toks[arrow]!;
  const at = word.text.indexOf("=>");
  const piece = (from: number, to: number): Lex[] =>
    from < to ? [{ ...word, text: word.text.slice(from, to), col: word.col + from, end: word.col + to }] : [];
  const lhs = [...toks.slice(0, arrow), ...piece(0, at)];
  const rhs = [...piece(at + 2, word.text.length), ...toks.slice(arrow + 1)];
  if (lhs.length === 0) return { line, message: "exception LHS is empty" };
  const first = lhs[0]!;
  if (isPunct(first, "{")) {
    return { line, message: "exception LHS may not contain an exception" };
  }
  const c0 = first.text[0]!;
  if (first.kind === "word" && (isMarkerChar(c0) || c0 === "=" || c0 === ">")) {
    return { line, message: "exception LHS cannot carry a marker" };
  }
  if (hasTopArrow(lhs)) {
    return { line, message: REMOVED_AGG("'-> weight'") };
  }
  const words = termWords(lhs);
  if (!Array.isArray(words)) return words;
  const terms = parseTerms(words, line);
  if ("message" in terms) return terms;
  if (terms.length === 0) return { line, message: "exception LHS is empty" };
  const head = terms[0]!;
  if (head.tag !== "Symbol") {
    return { line, message: "exception LHS head must be a symbol" };
  }
  if (head.name.startsWith("*")) {
    return { line, message: `head syms starting with '*' are reserved (got '${head.name}')` };
  }
  // RHS: same machinery as a normal rule body, on the block's own tokens,
  // so its spans are true source columns. These atoms are spliced verbatim
  // into the generated exception rule by `applyExceptions`, so an emitting
  // RHS atom reaches an `Emit` under its own span. An empty RHS is allowed:
  // `{p t1..tn =>}` suppresses `p` in this context (expand skips the
  // exception-case rule).
  let right: BodyItem[] = [];
  if (rhs.length > 0) {
    const rhsToks: Token[] = [];
    const err = scanTokens(rhs, rhsToks, () => null);
    if (err !== null) return err;
    const parsed = parseBodyItems(rhsToks, { i: 0 }, line, true);
    if (!Array.isArray(parsed)) return parsed;
    right = parsed;
  }
  const leftSpan = { line, startCol: first.col, endCol: lhs[lhs.length - 1]!.end };
  return { kind: "exception", left: { terms }, leftSpan, right, span: { line, startCol: tok.startCol, endCol: tok.endCol } };
}

function describeTerm(t: Term): string {
  if (t.tag === "Symbol") return t.name;
  if (t.tag === "Variable") return t.name;
  return t.tag;
}

function resolveRuleNames(rules: { name: string; explicitName?: string; span: Span }[]): ParseError | null {
  const seen = new Map<string, number>();
  for (const r of rules) {
    if (r.explicitName === undefined) continue;
    const prior = seen.get(r.explicitName);
    if (prior !== undefined) {
      return { line: r.span.line, message: `duplicate rule name '${r.explicitName}'` };
    }
    seen.set(r.explicitName, r.span.line);
  }
  let n = 1;
  for (const r of rules) {
    if (r.explicitName !== undefined) {
      r.name = r.explicitName;
    } else {
      r.name = `r${n}`;
    }
    n++;
  }
  return null;
}

// Walk all `BodyItem`s and collect every `Variable` name that appears
// anywhere in their term trees. Used by `desugarBody` to mint fresh
// `_dotN` names that don't collide with user-written ones.
function collectUsedNames(items: BodyItem[], out: Set<string>): void {
  for (const it of items) {
    if (it.kind === "dot") continue;
    if (it.kind === "sub") {
      collectUsedNames(it.inner, out);
      continue;
    }
    if (it.kind === "exception") {
      for (const t of it.left.terms) collectVarsInTerm(t, out);
      collectUsedNames(it.right, out);
      continue;
    }
    const a = it.atom;
    if (a.tag === "Atom") {
      if (a.subAtoms !== undefined) {
        for (const s of a.subAtoms) {
          for (const t of s.atom.terms) collectVarsInTerm(t, out);
        }
      } else {
        for (const t of a.atom.terms) collectVarsInTerm(t, out);
      }
      if (a.lLit !== undefined) collectVarsInTerm(a.lLit, out);
      if (a.rLit !== undefined) collectVarsInTerm(a.rLit, out);
    } else if (a.tag === "Equal") {
      collectVarsInTerm(a.lhs, out);
      for (const t of exprTerms(a.rhs)) collectVarsInTerm(t, out);
    }
  }
}

function collectVarsInTerm(t: Term, out: Set<string>): void {
  if (t.tag === "Variable") {
    out.add(t.name);
  } else if (t.tag === "Atom" || t.tag === "Id") {
    for (const inner of t.atom.terms) collectVarsInTerm(inner, out);
  }
}

function mintName(usedNames: Set<string>, counter: { n: number }): string {
  while (true) {
    const name = `_dot${counter.n++}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
}



// Anchor frame for the dot-desugar walk. See plans/v2-dot-notation.md.
//   anchor:      the most recent `tag === "Atom"` RuleAtom in this frame
//                (the would-be left of any incoming dot); null until the
//                first such atom is seen.
//   freshVar:    lazily allocated when this frame's anchor first needs
//                to be threaded; once allocated, the var has been
//                appended to anchor.atom.terms exactly once. When the left
//                of the dot was a lone variable (`A . p`), this is that
//                variable and `anchor` is null: nothing to append to.
//   pendingDot:  a `.` was just seen — the next atom/sub is the right.
type Frame = {
  anchor: AtomItem | null;
  freshVar: Term | null;
  pendingDot: boolean;
  // Line of the most recent `dot` BodyItem, for error reporting.
  dotLine: number;
};

function ensureFresh(frame: Frame, usedNames: Set<string>, counter: { n: number }): Term {
  if (frame.freshVar !== null) return frame.freshVar;
  const v: Term = { tag: "Variable", name: mintName(usedNames, counter) };
  frame.freshVar = v;
  if (frame.anchor !== null) frame.anchor.atom.terms.push(v);
  return v;
}

// The variable of a body atom that is just `A` — a bare match with a lone
// Variable term and nothing else — or null. On the left of a dot such an
// atom names the value to thread rather than a relation to match: `A.p X`
// is `p A X`, whatever marker `p` carries, so `x A, A.^p X` and `x.p X`
// read alike. (A variable-head match with arguments, `T X.p`, is still an
// atom: `T X _dot1, p _dot1`.)
function loneVariable(a: AtomItem): Term | null {
  if (a.marker !== "match" || a.atom.terms.length !== 1) return null;
  if (a.subAtoms !== undefined || a.lLit !== undefined || a.rLit !== undefined) return null;
  const t = a.atom.terms[0]!;
  return t.tag === "Variable" ? t : null;
}

// Walks `items` left-to-right. If `incoming` is supplied, the first
// real atom encountered (drilling through nested subs as needed) is
// treated as the right-hand side of a dot from the *caller's* frame —
// it gets the caller's fresh var prepended (after the head symbol),
// and the caller's anchor receives a single appended copy.
function desugarBody(
  items: BodyItem[],
  usedNames: Set<string>,
  counter: { n: number },
  incoming: Frame | undefined,
): RuleAtom[] | ParseError {
  const out: RuleAtom[] = [];
  const frame: Frame = { anchor: null, freshVar: null, pendingDot: false, dotLine: 0 };
  let incomingPending = incoming !== undefined;
  // Set after an exception block so a following `.` errors specifically
  // (an Exception is not a frame anchor — see plans/v2-exceptions.md).
  let afterException = false;

  for (const it of items) {
    if (it.kind === "exception") {
      if (incomingPending) {
        return { line: incoming!.dotLine, message: "'.' cannot be adjacent to an exception block" };
      }
      if (frame.pendingDot) {
        return { line: frame.dotLine, message: "'.' cannot be adjacent to an exception block" };
      }
      const inner = desugarBody(it.right, usedNames, counter, undefined);
      if (!Array.isArray(inner)) return inner;
      out.push({ tag: "Exception", left: it.left, leftSpan: it.leftSpan, right: inner, span: it.span });
      afterException = true;
      continue;
    }
    if (it.kind === "dot") {
      if (afterException) {
        return { line: it.line, message: "'.' cannot be adjacent to an exception block" };
      }
      if (incomingPending) {
        return { line: it.line, message: "dot must follow an atom" };
      }
      if (frame.pendingDot) {
        return { line: it.line, message: "consecutive '.' with no atom between them" };
      }
      if (frame.anchor === null && frame.freshVar === null) {
        return { line: it.line, message: "dot must follow an atom" };
      }
      if (frame.anchor !== null) {
        const lone = loneVariable(frame.anchor);
        if (lone !== null) {
          // `A . p`: drop the placeholder atom and thread `A` itself.
          out.splice(out.lastIndexOf(frame.anchor), 1);
          frame.anchor = null;
          frame.freshVar = lone;
        }
      }
      frame.pendingDot = true;
      frame.dotLine = it.line;
      continue;
    }

    if (it.kind === "atom") {
      afterException = false;
      const ra = it.atom;
      // Right-of-dot must be a plain Atom (not Equal). Sub is handled
      // by its own BodyItem branch below.
      const dotFromOuter = incomingPending;
      const dotFromLocal = frame.pendingDot;
      if (dotFromOuter || dotFromLocal) {
        if (ra.tag !== "Atom") {
          const ln = dotFromLocal ? frame.dotLine : ra.span.line;
          return { line: ln, message: "right of '.' must be a plain atom (not '=')" };
        }
        if (ra.atom.terms.length === 0) {
          const ln = dotFromLocal ? frame.dotLine : ra.span.line;
          return { line: ln, message: "right of '.' must have a head symbol" };
        }
        if (dotFromOuter) {
          const v = ensureFresh(incoming!, usedNames, counter);
          ra.atom.terms.splice(1, 0, v);
          incomingPending = false;
          // Now the freshly-spliced atom becomes our local anchor.
          frame.anchor = ra;
          frame.freshVar = null;
        } else {
          const v = ensureFresh(frame, usedNames, counter);
          ra.atom.terms.splice(1, 0, v);
          frame.pendingDot = false;
          // Advance: the right atom is the new local anchor.
          frame.anchor = ra;
          frame.freshVar = null;
        }
        out.push(ra);
        continue;
      }
      // No pending dot. If this is an `Atom`, it becomes the new
      // anchor. `Equal` does not advance the anchor (a dot after an
      // equal still chains off the prior real atom).
      if (ra.tag === "Atom") {
        frame.anchor = ra;
        frame.freshVar = null;
      }
      out.push(ra);
      continue;
    }

    // it.kind === "sub"
    afterException = false;
    let subIncoming: Frame | undefined;
    if (incomingPending) {
      // Outer's pending dot crosses two sub-boundaries. Pass the outer
      // frame straight through; the inner first-atom will append to
      // the outer anchor.
      subIncoming = incoming;
      incomingPending = false;
      // No local anchor change — sub doesn't advance.
    } else if (frame.pendingDot) {
      subIncoming = frame;
      frame.pendingDot = false;
      // sub doesn't advance the local anchor; freshVar stays so
      // further `.(...)` siblings reuse the same var.
    }
    const innerOut = desugarBody(it.inner, usedNames, counter, subIncoming);
    if (!Array.isArray(innerOut)) return innerOut;
    out.push({ tag: "Sub", body: innerOut, sequence: it.sequence, span: it.span });
  }

  if (frame.pendingDot) {
    return { line: frame.dotLine, message: "trailing '.' with no right-hand atom" };
  }
  if (incomingPending) {
    // Outer dot was passed in but this body had no atom to receive it.
    return { line: incoming!.dotLine, message: "'.' before empty sub-block" };
  }
  return out;
}

// Auto-fill trailing wildcards so every Symbol-headed atom reaches its lexical
// arity. Arity = (number of ':' in the head symbol) + 1. Runs on the dot-desugared body,
// so dot-threaded linking vars are already counted. Over-arity atoms are left
// untouched (non-strict; see plans/v2-arity-auto-wildcard.md).
function saturateArity(body: RuleAtom[]): void {
  for (const a of body) {
    if (a.tag === "Sub") { saturateArity(a.body); continue; }
    if (a.tag === "Exception") {
      saturateHead(a.left.terms, false);
      saturateArity(a.right);
      continue;
    }
    if (a.tag !== "Atom") continue; // Equal / Match / Emit / etc. have no head arity
    if (a.subAtoms !== undefined) {
      // `!(...)` block. The `atom` field is a placeholder alias of the first
      // sub — skip it.
      for (const s of a.subAtoms) saturateHead(s.atom.terms, false);
      continue;
    }
    saturateHead(a.atom.terms, false);
  }
}

// Pad `terms` (`[head, ...args]`, weight held separately) with trailing
// wildcards up to arity. A present weight fills one argument slot.
function saturateHead(terms: Term[], hasWeight: boolean): void {
  const head = terms[0];
  if (head === undefined || head.tag !== "Symbol" || head.name.startsWith("*")) return;
  // want terms.length = head + (colons + 1) args, minus the weight's slot.
  const want = colonCount(head.name) + 2 - (hasWeight ? 1 : 0);
  while (terms.length < want) terms.push({ tag: "Wildcard" });
}



function colonCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ":") n++;
  return n;
}


// `#acc name : col...` (plans/v2-acc-relations.md §1.1). Each column is a
// base-type Symbol (a key column), a bare `@op`, or a group `(@op base)`;
// at most one agg column. Ops come from the acc-ops.ts registry.
function parseAccDecl(argToks: Lex[], line: number): AccDecl | ParseError {
  const tokens = termWords(argToks);
  if (!Array.isArray(tokens)) return tokens;
  const relation = tokens[0];
  if (relation === undefined) return { line, message: "'#acc' requires a relation name" };
  if (!isSymToken(relation) || relation.startsWith("@") || relation === ":") {
    return { line, message: `'#acc' relation must be a lower-case symbol (got '${relation}')` };
  }
  if (tokens[1] !== ":") {
    return { line, message: "'#acc' requires a standalone ':' after the relation name (`#acc name : col...`)" };
  }
  const columns: AccColumn[] = [];
  let aggIndex: number | null = null;
  const aggColumn = (opTok: string, type: string | undefined): AccColumn | ParseError => {
    const name = opTok.slice(1);
    const def = accOp(name);
    if (def === undefined) return { line, message: `unknown aggregation '${opTok}' in '#acc ${relation}'` };
    if (aggIndex !== null) {
      return { line, message: `one aggregation column per acc relation ('#acc ${relation}' has two)` };
    }
    aggIndex = columns.length;
    return type === undefined ? { kind: "agg", op: name as AccOp } : { kind: "agg", op: name as AccOp, type };
  };
  let i = 2;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "(") {
      const close = tokens.indexOf(")", i);
      if (close < 0) return { line, message: `unbalanced '(' in '#acc ${relation}'` };
      const inner = tokens.slice(i + 1, close);
      const op = inner[0];
      if (op === undefined || !op.startsWith("@") || inner.length > 2 || inner.includes("(")) {
        return { line, message: `'#acc ${relation}': a parenthesized column must be '(@op base)'` };
      }
      const col = aggColumn(op, inner[1]);
      if ("message" in col) return col;
      columns.push(col);
      i = close + 1;
      continue;
    }
    if (t === ")") return { line, message: `unbalanced ')' in '#acc ${relation}'` };
    if (t.startsWith("@")) {
      const col = aggColumn(t, undefined);
      if ("message" in col) return col;
      columns.push(col);
      i++;
      continue;
    }
    if (!isSymToken(t)) {
      return { line, message: `'#acc ${relation}': column type must be a lower-case symbol (got '${t}')` };
    }
    columns.push({ kind: "key", type: t });
    i++;
  }
  return { relation, columns, aggIndex, span: { line } };
}

function parseEqual(toks: Lex[], line: number, startCol: number, endCol: number): RuleAtom | ParseError {
  if (hasTopArrow(toks)) {
    return { line, message: REMOVED_AGG("'-> weight'") };
  }
  const words = termWords(toks);
  if (!Array.isArray(words)) return words;
  const terms = parseTerms(words, line);
  if ("message" in terms) return terms;
  if (terms.length !== 2) {
    return { line, message: `'=' atom must have exactly two terms, got ${terms.length}` };
  }
  return { tag: "Equal", lhs: terms[0]!, rhs: terms[1]!, span: { line, startCol, endCol } };
}

function parseAtom(toks: Lex[], marker: Marker, line: number, startCol: number, endCol: number): RuleAtom | ParseError {
  // `!(...)` compound constrain (with optional whitespace before `(`).
  // The body is either `(sub, sub, ...)` for a compound, or a single
  // atom shape. Single-atom `!foo` / `!foo -> Z` is canonicalized into a
  // one-element `subAtoms` list so the IR shape is uniform downstream.
  if (marker === "constrain") {
    return parseConstrainBody(toks, line, startCol, endCol);
  }
  // Choice-actor prefix `[actor]` on an ask atom (plans/v2-choice-actors.md):
  // `?[rng] C` — the tokenizer only glues a `[...]` group into the atom text
  // when it immediately follows the `?` marker, so a leading `[` here is
  // always the actor group.
  let actor: Actor | undefined;
  if (marker === "ask" && isPunct(toks[0], "[")) {
    const close = toks.findIndex((t) => isPunct(t, "]"));
    if (close < 0) {
      return { line, message: "unterminated '[' after '?'" };
    }
    const name = toks.slice(1, close).map((t) => t.text).join(" ");
    if (!isActor(name)) {
      return { line, message: `unknown actor '${name}' (expected you|rng)` };
    }
    actor = name;
    toks = toks.slice(close + 1);
  }
  // A trailing `-> term` weight fed the removed `#agg`/`#reactive`.
  if (hasTopArrow(toks)) return { line, message: REMOVED_AGG("'-> weight'") };
  const words = termWords(toks);
  if (!Array.isArray(words)) return words;
  const parsedTerms = parseTerms(words, line);
  if ("message" in parsedTerms) return parsedTerms;
  // `not r t̄` (plans/v2-caret-fresh-left.md §3): a negated read. `not` is
  // reserved — only valid as the prefix of an unmarked atom without a weight.
  const neg = splitNot(parsedTerms, line);
  if ("message" in neg) return neg;
  const terms = neg.terms;
  if (neg.negated && marker !== "match") {
    return { line, message: "'not' only prefixes a plain read (no marker)" };
  }
  const atom: Atom = { terms };
  // Head syms starting with `*` are reserved for compiler-generated identity
  // terms (e.g. `*id`, `*mom`, `*choose`). Engine-emitted predicates like
  // `_choose` / `_constrain` / `_exn-wait` / `_acc-at` are reserved by the
  // general `_`-prefix rule (such tokens parse as Variables, not Symbols, so
  // they cannot appear as a Symbol head from user source).
  const headTerm = atom.terms[0];
  if (headTerm !== undefined && headTerm.tag === "Symbol" && headTerm.name.startsWith("*")) {
    return { line, message: `head syms starting with '*' are reserved (got '${headTerm.name}')` };
  }
  // Ask-shape validation (plans/v2-choice-actors.md): `?[actor] V1 .. Vn`
  // accepts only one or more distinct variables — no symbols, no compounds,
  // no bare `_`, no duplicates.
  if (marker === "ask") {
    if (atom.terms.length === 0) {
      return { line, message: "'?' requires at least one variable" };
    }
    const seenAsk = new Set<string>();
    for (const t of atom.terms) {
      if (t.tag !== "Variable") {
        return { line, message: "'?' accepts only variables (one or more)" };
      }
      if (seenAsk.has(t.name)) {
        return { line, message: `duplicate variable '${t.name}' in '?'` };
      }
      seenAsk.add(t.name);
    }
  }
  const out: RuleAtom = { tag: "Atom", marker, atom, span: { line, startCol, endCol } };
  if (actor !== undefined) out.actor = actor;
  if (neg.negated) out.negated = true;
  return out;
}

// Strip a leading reserved `not`. `not` followed by a Symbol-headed atom is a
// negated read; any other use of the word (`not` alone, `+not x`, a `not`
// argument position is fine) is an error, so the name never denotes a
// relation.
function splitNot(terms: Term[], line: number): { terms: Term[]; negated: boolean } | ParseError {
  const h = terms[0];
  if (h === undefined || h.tag !== "Symbol" || h.name !== "not") return { terms, negated: false };
  const inner = terms[1];
  if (inner === undefined || inner.tag !== "Symbol") {
    return { line, message: "'not' is reserved: write 'not rel args…' to read that no row of an '#acc' relation matches" };
  }
  return { terms: terms.slice(1), negated: true };
}

// Parse a `!` body (text already stripped of the leading `!`). May be:
//   single atom: `foo X Y` (or `not foo X Y`)
//   compound:    `(sub, sub, ...)` where each sub is one of the above
function parseConstrainBody(toks: Lex[], line: number, startCol: number, endCol: number): RuleAtom | ParseError {
  const subs: SubConstrain[] = [];
  if (isPunct(toks[0], "(")) {
    if (hasTopArrow(toks)) return { line, message: REMOVED_AGG("'-> weight'") };
    if (!isPunct(toks[toks.length - 1], ")")) {
      return { line, message: "'!(...)' block has unbalanced parens" };
    }
    const pieces = splitTopCommas(toks.slice(1, -1));
    if (pieces.every((p) => p.length === 0)) {
      return { line, message: "'!(...)' must contain at least one sub-atom" };
    }
    for (const piece of pieces) {
      const sub = parseConstrainSubAtom(piece, line);
      if ("message" in sub) return sub;
      subs.push(sub);
    }
  } else {
    const sub = parseConstrainSubAtom(toks, line);
    if ("message" in sub) return sub;
    subs.push(sub);
  }
  // The Atom variant requires an `atom` field; downstream code that
  // handles constrain reads `subAtoms` exclusively. Use the first sub's
  // atom as a placeholder so the field is well-formed.
  return {
    tag: "Atom",
    marker: "constrain",
    atom: subs[0]!.atom,
    subAtoms: subs,
    span: { line, startCol, endCol },
  };
}

// Parse one sub-atom inside `!(...)` (or the entire body of a
// single-atom `!`). A plain or `not` atom; no markers, no equality, no
// nested parens-list.
function parseConstrainSubAtom(toks: Lex[], line: number): SubConstrain | ParseError {
  if (toks.length === 0) return { line, message: "empty sub-atom inside '!(...)'" };
  // Reject embedded markers / equalities by checking the first char.
  const first = toks[0]!;
  const m = first.text[0]!;
  if (first.kind === "word" && (isMarkerChar(m) || m === "=")) {
    return { line, message: "sub-atom inside '!(...)' cannot carry a marker or '='" };
  }
  if (isPunct(first, "(")) {
    return { line, message: "sub-atom inside '!(...)' cannot be a parenthesised block" };
  }
  if (hasTopArrow(toks)) return { line, message: REMOVED_AGG("'-> weight'") };
  const words = termWords(toks);
  if (!Array.isArray(words)) return words;
  const parsedHead = parseTerms(words, line);
  if ("message" in parsedHead) return parsedHead;
  const neg = splitNot(parsedHead, line);
  if ("message" in neg) return neg;
  const headTerms = neg.terms;
  if (headTerms.length === 0) return { line, message: "sub-atom is empty" };
  if (neg.negated) return { atom: { terms: headTerms }, negated: true };
  const headTerm = headTerms[0]!;
  if (headTerm.tag === "Symbol" && headTerm.name.startsWith("*")) {
    return { line, message: `head syms starting with '*' are reserved (got '${headTerm.name}')` };
  }
  return { atom: { terms: headTerms } };
}





// Canonical token-class predicates. A token's first character decides its
// class: uppercase or `_`-prefixed → Variable, bare `_` → Wildcard, anything
// else (non-empty) → Symbol. These are the shared source of truth used by
// `parseTerms` and by the editor autocomplete (plans/v2-editor-autocomplete.md).

// True for a non-empty token that names a Symbol (lower-case / punctuation
// start, not `_`, not upper-case).
export function isSymbolToken(tok: string): boolean {
  if (tok.length === 0) return false;
  const c = tok[0]!;
  if (c === "_") return false;
  if (c >= "A" && c <= "Z") return false;
  return true;
}

// True for a non-empty token that names a Variable: an upper-case start, or
// `_` followed by at least one more character (bare `_` is a Wildcard, not a
// Variable).
export function isVariableToken(tok: string): boolean {
  if (tok.length === 0) return false;
  const c = tok[0]!;
  if (c >= "A" && c <= "Z") return true;
  if (c === "_" && tok.length > 1) return true;
  return false;
}

// Back-compat alias for the in-module call sites.
const isSymToken = isSymbolToken;

function parseTerms(tokens: string[], line: number, pos: { i: number } = { i: 0 }): Term[] | ParseError {
  const terms: Term[] = [];
  while (pos.i < tokens.length && tokens[pos.i] !== ")") {
    const tok = tokens[pos.i++]!;
    if (tok === "(") {
      const inner = parseTerms(tokens, line, pos);
      if (!Array.isArray(inner)) return inner;
      if (tokens[pos.i] !== ")") return { line, message: "unbalanced '(' in term" };
      pos.i++;
      // Convention: a compound whose head is a Symbol starting with `*` is a
      // compiler-generated identity term (e.g. `*choose`, `*id`, `*mom`).
      // Tag it as `Id` so it round-trips with the Id-opacity invariant
      // intact (notes/v2-design.md). Anything else is plain data.
      const head = inner[0];
      const tag = (head !== undefined && head.tag === "Symbol" && head.name.startsWith("*")) ? "Id" : "Atom";
      terms.push({ tag, atom: { terms: inner } });
    } else if (tok === "@js") {
      // `@js(name args...)` -> Atom([*js, name, ...args]); the `*js` head
      // marks it for lowering in expand (plans/v2-user-js-functions.md).
      if (tokens[pos.i] !== "(") return { line, message: "expected '(' after '@js'" };
      pos.i++;
      const inner = parseTerms(tokens, line, pos);
      if (!Array.isArray(inner)) return inner;
      if (tokens[pos.i] !== ")") return { line, message: "unbalanced '(' in '@js(...)'" };
      pos.i++;
      const fn = inner[0];
      if (fn === undefined || fn.tag !== "Symbol") {
        return { line, message: "'@js(...)' must name a function" };
      }
      terms.push({ tag: "Atom", atom: { terms: [{ tag: "Symbol", name: "*js" }, ...inner] } });
    } else if (tok.startsWith("\"")) {
      // A string literal (`termWords` keeps it whole): the Symbol named by
      // its source text.
      terms.push({ tag: "Symbol", name: tok });
    } else if (tok === "_") {
      terms.push({ tag: "Wildcard" });
    } else if (isVariableToken(tok)) {
      terms.push({ tag: "Variable", name: tok });
    } else {
      terms.push({ tag: "Symbol", name: tok });
    }
  }
  return terms;
}

// Convenience used by tests / formatter.
export function isAtomNode(a: RuleAtom): a is Extract<RuleAtom, { tag: "Atom" }> {
  return a.tag === "Atom";
}

export type { Span };

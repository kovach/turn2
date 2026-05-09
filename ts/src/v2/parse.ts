// v2 parser. Flat-syntax language per notes/turn-program-1.t.
//
// Two passes: tokenize (line-by-line, comment-aware) then parseProgram (turn
// the token stream into rules + schema). Hashconsing is *not* applied here —
// callers run terms through hashcons after parsing.

import type { Atom, Term, Span } from "../types.js";
import type { Marker, Program, Rule, RuleAtom, SchemaDecl } from "./types.js";

export interface ParseError {
  line: number;
  message: string;
}

type Token =
  | { tag: "open"; line: number }
  | { tag: "close"; sequence: boolean; line: number }
  | { tag: "atom"; marker: Marker; text: string; line: number }
  | { tag: "equal"; text: string; line: number }
  | { tag: "schema"; text: string; line: number }
  | { tag: "ruleEnd"; line: number };

export function parse(input: string): Program | ParseError {
  const toks = tokenize(input);
  if (!Array.isArray(toks)) return toks;
  return parseProgram(toks);
}

function stripComment(line: string): string {
  const i = line.indexOf("--");
  return i >= 0 ? line.slice(0, i) : line;
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

function tokenize(input: string): Token[] | ParseError {
  // A blank line ends a rule only when the next non-blank line starts at
  // column 0. A blank line followed by indented content is treated as a
  // continuation (the spec's `activate` example uses blank lines for
  // readability inside one rule).
  const tokens: Token[] = [];
  const lines = input.split("\n");
  let blankPending = false;
  for (let li = 0; li < lines.length; li++) {
    const lineno = li + 1;
    const raw = stripComment(lines[li]!);
    if (raw.trim() === "") {
      blankPending = true;
      continue;
    }
    const leading = raw.length - raw.trimStart().length;
    if (blankPending && leading === 0) {
      tokens.push({ tag: "ruleEnd", line: lineno });
    }
    blankPending = false;
    let pos = 0;
    let atomStart = true;
    while (pos < raw.length) {
      while (pos < raw.length && /\s/.test(raw[pos]!)) pos++;
      if (pos >= raw.length) break;
      const ch = raw[pos]!;
      if (atomStart && ch === "(") {
        tokens.push({ tag: "open", line: lineno });
        pos++;
        atomStart = true;
        continue;
      }
      if (ch === ")") {
        const sequence = raw[pos + 1] === ";";
        tokens.push({ tag: "close", sequence, line: lineno });
        pos += sequence ? 2 : 1;
        atomStart = true;
        continue;
      }
      if (ch === ",") {
        pos++;
        atomStart = true;
        continue;
      }
      if (atomStart && ch === "%") {
        const text = raw.slice(pos + 1).trim();
        tokens.push({ tag: "schema", text, line: lineno });
        pos = raw.length;
        atomStart = true;
        continue;
      }
      // Read atom content: balanced parens, ends at top-level `,` or `)`.
      const start = pos;
      let depth = 0;
      while (pos < raw.length) {
        const c = raw[pos]!;
        if (depth === 0 && (c === "," || c === ")")) break;
        if (c === "(") depth++;
        else if (c === ")") depth--;
        pos++;
      }
      const text = raw.slice(start, pos).trim();
      if (text.length > 0) {
        const m = text[0]!;
        // `=` is the equality marker only when followed by whitespace (or
        // bare). `=foo` stays a Symbol-headed match atom.
        if (m === "=" && (text.length === 1 || /\s/.test(text[1]!))) {
          tokens.push({ tag: "equal", text: text.slice(1).trim(), line: lineno });
        } else {
          let marker: Marker;
          let body: string;
          if (isMarkerChar(m)) {
            marker = markerOf(m);
            body = text.slice(1).trim();
          } else {
            marker = "match";
            body = text;
          }
          tokens.push({ tag: "atom", marker, text: body, line: lineno });
        }
      }
      atomStart = false;
    }
  }
  return tokens;
}

function parseProgram(tokens: Token[]): Program | ParseError {
  const rules: Rule[] = [];
  const schema = new Map<string, string>();
  let i = 0;
  let ruleNo = 1;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.tag === "ruleEnd") { i++; continue; }
    if (t.tag === "schema") {
      const decl = parseSchemaText(t.text, t.line);
      if ("message" in decl) return decl;
      if (schema.has(decl.relation)) {
        return { line: t.line, message: `duplicate schema declaration for '${decl.relation}'` };
      }
      schema.set(decl.relation, decl.aggregator);
      i++;
      continue;
    }

    const startLine = t.line;
    const body: RuleAtom[] = [];
    const stack: RuleAtom[][] = [body];
    let depth = 0;

    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.tag === "ruleEnd") {
        if (depth > 0) { i++; continue; }
        break;
      }
      if (tok.tag === "schema") {
        if (depth > 0) return { line: tok.line, message: "'%' schema decl not allowed inside a sub-rule" };
        break;
      }
      if (tok.tag === "open") {
        const inner: RuleAtom[] = [];
        const sub: RuleAtom = { tag: "Sub", body: inner, sequence: false, span: { line: tok.line } };
        stack[stack.length - 1]!.push(sub);
        stack.push(inner);
        depth++;
        i++;
        continue;
      }
      if (tok.tag === "close") {
        if (depth === 0) return { line: tok.line, message: "unmatched ')'" };
        stack.pop();
        const parent = stack[stack.length - 1]!;
        const subAtom = parent[parent.length - 1]!;
        if (subAtom.tag !== "Sub") throw new Error("internal: top of close stack not Sub");
        if (tok.sequence) subAtom.sequence = true;
        depth--;
        i++;
        continue;
      }
      if (tok.tag === "equal") {
        const parsedEq = parseEqualText(tok.text, tok.line);
        if ("message" in parsedEq) return parsedEq;
        stack[stack.length - 1]!.push(parsedEq);
        i++;
        continue;
      }
      const parsed = parseAtomText(tok.text, tok.marker, tok.line);
      if ("message" in parsed) return parsed;
      stack[stack.length - 1]!.push(parsed);
      i++;
    }

    if (depth > 0) return { line: startLine, message: "unmatched '('" };
    if (body.length > 0) {
      rules.push({ name: `r${ruleNo++}`, body, span: { line: startLine } });
    }
  }

  return { rules, schema };
}

function parseSchemaText(text: string, line: number): SchemaDecl | ParseError {
  // `% rel arg1 arg2 -> func` — relation name is the first token; args are
  // tokens before `->`; aggregator is the single token after `->`. For now
  // we only honour the relation name and aggregator (no per-relation args
  // beyond the head sym).
  const arrow = findTopArrow(text);
  if (arrow < 0) return { line, message: "schema decl requires '->'" };
  const head = text.slice(0, arrow).trim();
  const tail = text.slice(arrow + 2).trim();
  if (head.length === 0) return { line, message: "schema decl missing relation before '->'" };
  if (tail.length === 0) return { line, message: "schema decl missing aggregator after '->'" };
  const headTokens = tokenizeTermText(head);
  if (headTokens.length === 0) return { line, message: "schema decl missing relation" };
  const relation = headTokens[0]!;
  if (!isSymToken(relation)) return { line, message: `schema relation must be lower-case (got '${relation}')` };
  const tailTokens = tokenizeTermText(tail);
  if (tailTokens.length !== 1) return { line, message: "schema aggregator must be a single token" };
  const aggregator = tailTokens[0]!;
  if (!(aggregator === "sum" || aggregator === "count" || aggregator === "last")) {
    return { line, message: `unknown aggregator '${aggregator}'` };
  }
  return { relation, aggregator, span: { line } };
}

function parseEqualText(text: string, line: number): RuleAtom | ParseError {
  if (findTopArrow(text) >= 0) {
    return { line, message: "'=' atom cannot carry '-> weight'" };
  }
  const tokens = tokenizeTermText(text);
  const terms = parseTerms(tokens, line);
  if ("message" in terms) return terms;
  if (terms.length !== 2) {
    return { line, message: `'=' atom must have exactly two terms, got ${terms.length}` };
  }
  return { tag: "Equal", lhs: terms[0]!, rhs: terms[1]!, span: { line } };
}

function parseAtomText(text: string, marker: Marker, line: number): RuleAtom | ParseError {
  // Optional trailing `-> term` weight. Top-level arrow only (depth 0).
  const arrow = findTopArrow(text);
  let head: string;
  let weight: Term | undefined;
  if (arrow >= 0) {
    head = text.slice(0, arrow).trim();
    const tail = text.slice(arrow + 2).trim();
    if (tail.length === 0) return { line, message: "missing weight term after '->'" };
    const tailTokens = tokenizeTermText(tail);
    const tailTerms = parseTerms(tailTokens, line);
    if ("message" in tailTerms) return tailTerms;
    if (tailTerms.length !== 1) return { line, message: "weight must be a single term" };
    weight = tailTerms[0]!;
  } else {
    head = text;
  }
  const tokens = tokenizeTermText(head);
  const terms = parseTerms(tokens, line);
  if ("message" in terms) return terms;
  const atom: Atom = { terms };
  // Head syms starting with `*` are reserved for compiler-generated identity
  // terms (e.g. `*id`, `*mom`, `*choose`). Engine-emitted predicates like
  // `_choose` / `_constrain` / `_do-agg` / `_agg-result` are reserved by the
  // general `_`-prefix rule (such tokens parse as Variables, not Symbols, so
  // they cannot appear as a Symbol head from user source).
  const headTerm = atom.terms[0];
  if (headTerm !== undefined && headTerm.tag === "Symbol" && headTerm.name.startsWith("*")) {
    return { line, message: `head syms starting with '*' are reserved (got '${headTerm.name}')` };
  }
  const out: RuleAtom = { tag: "Atom", marker, atom, span: { line } };
  if (weight !== undefined) out.weight = weight;
  return out;
}

// Find the index of a top-level (depth 0) `->` in `text`, or -1.
function findTopArrow(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "-" && text[i + 1] === ">") return i;
  }
  return -1;
}

function tokenizeTermText(text: string): string[] {
  return text.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter((t) => t.length > 0);
}

function isSymToken(tok: string): boolean {
  if (tok.length === 0) return false;
  const c = tok[0]!;
  if (c === "_") return false;
  if (c >= "A" && c <= "Z") return false;
  return true;
}

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
    } else if (tok === "_") {
      terms.push({ tag: "Wildcard" });
    } else if (tok.length > 0 && tok[0]! >= "A" && tok[0]! <= "Z") {
      terms.push({ tag: "Variable", name: tok });
    } else if (tok.length > 1 && tok[0] === "_") {
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

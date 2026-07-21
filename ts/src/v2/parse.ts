// v2 parser. Flat-syntax language per notes/turn-program-1.t.
//
// Two passes: tokenize (line-by-line, comment-aware) then parseProgram (turn
// the token stream into rules + schema). Hashconsing is *not* applied here —
// callers run terms through hashcons after parsing.

import type { Atom, Term, Span } from "./term.js";
import type { JsDef, Marker, Program, Rule, RuleAtom, SchemaDecl, SubConstrain } from "./types.js";
import { aggregators } from "./aggregators.js";

export interface ParseError {
  line: number;
  message: string;
}

type Token =
  | { tag: "open"; line: number }
  | { tag: "close"; sequence: boolean; line: number }
  | { tag: "atom"; marker: Marker; text: string; line: number }
  // Exception block `{...}` (plans/v2-exceptions.md). `text` is the inner
  // text, braces stripped.
  | { tag: "exception"; text: string; line: number }
  // Bracket aggregation `[ Q | op V ]` (plans/v2-bracket-aggregation.md).
  // `text` is the inner text, brackets stripped; may span multiple source
  // lines (joined with spaces). `line` is the opening line.
  | { tag: "aggcomp"; text: string; line: number }
  | { tag: "equal"; text: string; line: number }
  | { tag: "command"; name: string; argText: string; body?: string; line: number }
  | { tag: "ruleEnd"; line: number }
  | { tag: "dot"; line: number }
  | { tag: "semi"; line: number };

// Parsed `#<name> ...` line. Consumed in parseProgram and not exposed.
type Command =
  | { kind: "def"; name: string; line: number }
  | { kind: "agg"; decl: SchemaDecl }
  | { kind: "reactive"; decl: SchemaDecl }
  | { kind: "js"; name: string; params: string[]; body: string; line: number }
  | { kind: "exit"; line: number };

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

export function tokenize(input: string): Token[] | ParseError {
  // A blank line ends a rule only when the next non-blank line starts at
  // column 0. A blank line followed by indented content is treated as a
  // continuation (the spec's `activate` example uses blank lines for
  // readability inside one rule).
  const tokens: Token[] = [];
  const lines = input.split("\n");
  let blankPending = false;
  for (let li = 0; li < lines.length; li++) {
    let lineno = li + 1;
    let raw = stripComment(lines[li]!);
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
      if (ch === ";") {
        // Bare `;` (not `);` — that case is folded into the `close`
        // token above). Emits a `semi` for parseProgram to wrap the
        // current line's accumulated items into a sequence sub.
        tokens.push({ tag: "semi", line: lineno });
        pos++;
        atomStart = true;
        continue;
      }
      if (ch === ".") {
        // `.` is always a top-level separator: handles spaced `a . b`,
        // leading-dot `.bar` / `.(sub)`, and produces the dot side of
        // glued `foo.bar` (the atom-body scanner below breaks on `.`).
        tokens.push({ tag: "dot", line: lineno });
        pos++;
        atomStart = true;
        continue;
      }
      if (ch === "{") {
        // Exception block `{p t1..tn => e}` (plans/v2-exceptions.md).
        // Scan to the matching `}` on this line, tracking brace depth.
        let braceDepth = 0;
        let end = -1;
        for (let j = pos; j < raw.length; j++) {
          const c = raw[j]!;
          if (c === "{") braceDepth++;
          else if (c === "}") {
            braceDepth--;
            if (braceDepth === 0) { end = j; break; }
          }
        }
        if (end < 0) {
          return { line: lineno, message: "unterminated '{' (exception block must close on the same line)" };
        }
        tokens.push({ tag: "exception", text: raw.slice(pos + 1, end).trim(), line: lineno });
        pos = end + 1;
        atomStart = true;
        continue;
      }
      if (ch === "}") {
        return { line: lineno, message: "stray '}'" };
      }
      if (ch === "[") {
        // Bracket aggregation `[ Q | op V ]` (plans/v2-bracket-aggregation.md).
        // Scan to the matching `]`, tracking bracket depth, continuing across
        // line breaks (comments stripped per line; pieces joined with a
        // space — line breaks inside the block carry no meaning). Blank
        // lines inside an open bracket are part of the block, never a
        // ruleEnd.
        if (!atomStart) {
          return { line: lineno, message: "'[' must start a query item (separate it with ',')" };
        }
        const openLine = lineno;
        const pieces: string[] = [];
        let bdepth = 0;
        let scanStart = pos;
        let end = -1;
        for (;;) {
          for (let j = scanStart; j < raw.length; j++) {
            const c = raw[j]!;
            if (c === "[") bdepth++;
            else if (c === "]") {
              bdepth--;
              if (bdepth === 0) { end = j; break; }
            }
          }
          if (end >= 0) break;
          // Bracket still open: consume the next line into the block.
          pieces.push(raw.slice(scanStart));
          li++;
          if (li >= lines.length) {
            return { line: openLine, message: "unterminated '['" };
          }
          lineno = li + 1;
          raw = stripComment(lines[li]!);
          scanStart = 0;
          pos = 0;
        }
        pieces.push(raw.slice(scanStart, end + 1));
        const whole = pieces.join(" ");
        tokens.push({ tag: "aggcomp", text: whole.slice(1, -1).trim(), line: openLine });
        pos = end + 1;
        atomStart = true;
        continue;
      }
      if (ch === "]") {
        return { line: lineno, message: "stray ']'" };
      }
      if (atomStart && ch === "#") {
        const rest = raw.slice(pos + 1);
        const trimmed = rest.trimStart();
        const ws = trimmed.search(/\s/);
        const name = ws < 0 ? trimmed : trimmed.slice(0, ws);
        if (name.length === 0) {
          return { line: lineno, message: "'#' must be followed by a command name" };
        }
        if (name === "def") {
          // `#def <name>` consumes only the name; the rest of the line
          // continues tokenizing so the rule body can follow on the same line.
          const afterName = ws < 0 ? "" : trimmed.slice(ws);
          const afterTrimmed = afterName.trimStart();
          const ws2 = afterTrimmed.search(/\s/);
          const defName = ws2 < 0 ? afterTrimmed : afterTrimmed.slice(0, ws2);
          tokens.push({ tag: "command", name, argText: defName, line: lineno });
          // Advance pos to just after the name token (or to end of line if none).
          const consumed = defName.length === 0
            ? raw.length
            : (raw.length - afterTrimmed.length) + defName.length;
          pos = consumed;
          atomStart = true;
          continue;
        }
        if (name === "js") {
          // Two forms, neither of which counts braces (so the body may contain
          // arbitrary JS — strings, templates, nested braces):
          //   - one-liner: `#js (sig) { body }` — `}` is the last char, body is
          //     between the first `{` and the last `}` on the line.
          //   - multi-line: `#js (sig) {` then *indented* body lines, closed by
          //     a `}` at column 0 (the first unindented line after the `{`).
          // Read raw (un-stripped) lines so the body survives verbatim.
          const rawLine = lines[li]!;
          const lead = rest.length - trimmed.length; // ws between '#' and name
          const afterJs = pos + 1 + lead + name.length;
          const sigPart = rawLine.slice(afterJs);
          const bracePos = sigPart.indexOf("{");
          if (bracePos < 0) {
            return { line: lineno, message: "'#js' signature must be followed by '{'" };
          }
          const sig = sigPart.slice(0, bracePos).trim();
          const afterBrace = sigPart.slice(bracePos + 1);
          const afterTrim = afterBrace.trim();
          let body: string;
          let endLi = li;
          if (afterTrim === "") {
            // Multi-line: collect indented lines until a column-0 `}`.
            const bodyLines: string[] = [];
            for (;;) {
              endLi++;
              if (endLi >= lines.length) {
                return { line: lineno, message: "'#js' body is missing a closing '}' at column 0" };
              }
              const bl = lines[endLi]!;
              const blank = bl.trim() === "";
              const indented = bl.length > 0 && /\s/.test(bl[0]!);
              if (!blank && !indented) {
                if (bl[0] !== "}") {
                  return { line: endLi + 1, message: "'#js' body must be indented; expected '}' at column 0" };
                }
                break;
              }
              bodyLines.push(bl);
            }
            body = bodyLines.join("\n");
          } else if (afterTrim.endsWith("}")) {
            // One-liner: body is between `{` and the last `}` on the line.
            body = afterBrace.slice(0, afterBrace.lastIndexOf("}"));
          } else {
            return { line: lineno, message: "'#js' body must close with '}' on the same line, or put '{' last and indent the body below" };
          }
          tokens.push({ tag: "command", name: "js", argText: sig, body, line: lineno });
          li = endLi;       // multi-line: past the `}` line; one-liner: unchanged
          pos = raw.length; // exit the inner while for the signature line
          atomStart = true;
          continue;
        }
        const argText = ws < 0 ? "" : trimmed.slice(ws).trim();
        tokens.push({ tag: "command", name, argText, line: lineno });
        pos = raw.length;
        atomStart = true;
        continue;
      }
      // Read atom content: balanced parens, ends at top-level `,` or `)`.
      const start = pos;
      let depth = 0;
      while (pos < raw.length) {
        const c = raw[pos]!;
        if (depth === 0 && (c === "," || c === ")" || c === "." || c === ";" || c === "{" || c === "}" || c === "[" || c === "]")) break;
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

// Temporary per-rule body item. `sub` carries an unresolved inner body
// (still a `BodyItem[]`) so the dot-desugar pass can thread an outer
// fresh var into the sub's first atom across the recursion. Final
// `desugarBody` produces a real `RuleAtom[]`.
type BodyItem =
  | { kind: "atom"; atom: RuleAtom }            // RuleAtom with tag "Atom", "Equal", or "AggComp"
  | { kind: "sub"; inner: BodyItem[]; sequence: boolean; span: Span }
  | { kind: "dot"; line: number }
  // Exception block. `right` is still BodyItems so `desugarBody` can
  // resolve the fragment's dots with the containing rule's shared
  // fresh-name minting (no `_dotN` capture between rule and fragment).
  | { kind: "exception"; left: Atom; right: BodyItem[]; span: Span };

type AtomItem = Extract<RuleAtom, { tag: "Atom" }>;

function parseCommand(tok: Extract<Token, { tag: "command" }>): Command | ParseError {
  if (tok.name === "def") {
    const tokens = tokenizeTermText(tok.argText);
    if (tokens.length === 0) {
      return { line: tok.line, message: "'#def' requires a rule name" };
    }
    const name = tokens[0]!;
    if (!isSymToken(name)) {
      return { line: tok.line, message: `'#def' name must be a lowercase symbol (got '${name}')` };
    }
    if (/^r\d+$/.test(name)) {
      return { line: tok.line, message: `'#def' name '${name}' is reserved for auto-naming` };
    }
    return { kind: "def", name, line: tok.line };
  }
  if (tok.name === "agg") {
    const decl = parseSchemaText(tok.argText, tok.line);
    if ("message" in decl) return decl;
    return { kind: "agg", decl };
  }
  if (tok.name === "reactive") {
    const decl = parseSchemaText(tok.argText, tok.line);
    if ("message" in decl) return decl;
    return { kind: "reactive", decl: { ...decl, reactive: true } };
  }
  if (tok.name === "js") {
    return parseJsCommand(tok.argText, tok.body ?? "", tok.line);
  }
  if (tok.name === "exit") {
    if (tok.argText.trim().length > 0) {
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

function parseProgram(tokens: Token[]): Program | ParseError {
  const rules: Rule[] = [];
  const schema = new Map<string, string>();
  const reactive = new Set<string>();
  const jsDefs = new Map<string, JsDef>();
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.tag === "ruleEnd") { i++; continue; }
    let explicitName: string | undefined;
    let startLine = t.line;
    if (t.tag === "command") {
      const cmd = parseCommand(t);
      if ("message" in cmd) return cmd;
      i++;
      if (cmd.kind === "agg" || cmd.kind === "reactive") {
        if (schema.has(cmd.decl.relation)) {
          return { line: t.line, message: `duplicate schema declaration for '${cmd.decl.relation}'` };
        }
        schema.set(cmd.decl.relation, cmd.decl.aggregator);
        if (cmd.kind === "reactive") reactive.add(cmd.decl.relation);
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
        jsDefs.set(cmd.name, { name: cmd.name, params: cmd.params, body: cmd.body, span: { line: cmd.line } });
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
    if (body.length > 0) {
      const usedNames = new Set<string>();
      collectUsedNames(body, usedNames);
      const counter = { n: 1 };
      const desugared = desugarBody(body, usedNames, counter, undefined);
      if (!Array.isArray(desugared)) return desugared;
      saturateArity(desugared);
      const rule: Rule = { name: "", body: desugared, span: { line: startLine } };
      if (explicitName !== undefined) rule.explicitName = explicitName;
      rules.push(rule);
    } else if (explicitName !== undefined) {
      return { line: startLine, message: "'#def' must precede a rule" };
    }
  }

  const nameErr = resolveRuleNames(rules);
  if (nameErr !== null) return nameErr;

  const boolErr = validateBoolWeights(rules, schema);
  if (boolErr !== null) return boolErr;

  return { rules, schema, reactive, jsDefs };
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
      const exc = parseExceptionBlock(tok.text, tok.line);
      if ("message" in exc) return exc;
      top.items.push(exc);
      top.needsContent = false;
      pos.i++;
      continue;
    }
    if (tok.tag === "aggcomp") {
      const parsedComp = parseAggCompText(tok.text, tok.line);
      if ("message" in parsedComp) return parsedComp;
      top.items.push({ kind: "atom", atom: parsedComp });
      top.needsContent = false;
      pos.i++;
      continue;
    }
    if (tok.tag === "equal") {
      const parsedEq = parseEqualText(tok.text, tok.line);
      if ("message" in parsedEq) return parsedEq;
      top.items.push({ kind: "atom", atom: parsedEq });
      top.needsContent = false;
      pos.i++;
      continue;
    }
    const parsed = parseAtomText(tok.text, tok.marker, tok.line);
    if ("message" in parsed) return parsed;
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

// Parse the inner text of a `{p t1..tn => e}` exception block (braces
// already stripped by the tokenizer). See plans/v2-exceptions.md.
function parseExceptionBlock(text: string, line: number): BodyItem | ParseError {
  const arrow = findTopFatArrow(text);
  if (arrow < 0) return { line, message: "exception block requires '=>'" };
  const lhsText = text.slice(0, arrow).trim();
  const rhsText = text.slice(arrow + 2).trim();
  if (lhsText.length === 0) return { line, message: "exception LHS is empty" };
  const c0 = lhsText[0]!;
  if (c0 === "{") {
    return { line, message: "exception LHS may not contain an exception" };
  }
  if (isMarkerChar(c0) || c0 === "=") {
    return { line, message: "exception LHS cannot carry a marker" };
  }
  if (findTopArrow(lhsText) >= 0) {
    return { line, message: "exception LHS cannot be an aggregate ('-> weight')" };
  }
  const terms = parseTerms(tokenizeTermText(lhsText), line);
  if ("message" in terms) return terms;
  if (terms.length === 0) return { line, message: "exception LHS is empty" };
  const head = terms[0]!;
  if (head.tag !== "Symbol") {
    return { line, message: "exception LHS head must be a symbol" };
  }
  if (head.name.startsWith("*")) {
    return { line, message: `head syms starting with '*' are reserved (got '${head.name}')` };
  }
  // RHS: same machinery as a normal rule body. Errors and spans from the
  // fragment carry sub-tokenizer line numbers (always 1 — the block is a
  // single line); remap both to the block's source line. An empty RHS is
  // allowed: `{p t1..tn =>}` suppresses `p` in this context (expand skips
  // the exception-case rule).
  let right: BodyItem[] = [];
  if (rhsText.length > 0) {
    const rhsToks = tokenize(rhsText);
    if (!Array.isArray(rhsToks)) return { line, message: rhsToks.message };
    const pos = { i: 0 };
    const parsed = parseBodyItems(rhsToks, pos, line, true);
    if (!Array.isArray(parsed)) return { line, message: parsed.message };
    right = parsed;
    remapItemLines(right, line);
  }
  return { kind: "exception", left: { terms }, right, span: { line } };
}

// Stamp `line` onto every span in a fragment parsed from single-line text.
function remapItemLines(items: BodyItem[], line: number): void {
  for (const it of items) {
    if (it.kind === "dot") { it.line = line; continue; }
    if (it.kind === "sub") { it.span.line = line; remapItemLines(it.inner, line); continue; }
    if (it.kind === "exception") { it.span.line = line; remapItemLines(it.right, line); continue; }
    if (it.atom.tag === "AggComp") { remapAggCompLines(it.atom, line); continue; }
    it.atom.span.line = line;
  }
}

function remapAggCompLines(comp: Extract<RuleAtom, { tag: "AggComp" }>, line: number): void {
  comp.span.line = line;
  for (const b of comp.body) {
    if (b.tag === "AggComp") remapAggCompLines(b, line);
    else b.span.line = line;
  }
}

// Find the index of a top-level (paren- and brace-depth 0) `=>` in `text`,
// or -1.
function findTopFatArrow(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i]!;
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth--;
    else if (depth === 0 && c === "=" && text[i + 1] === ">") return i;
  }
  return -1;
}

// Enforce surface restrictions for relations declared `-> bool`:
// assertions must be literal `-> 1`; queries must be `-> 0` / `-> 1`
// / a Variable. See plans/v2-bool-aggregate.md.
function validateBoolWeights(rules: Rule[], schema: Map<string, string>): ParseError | null {
  for (const r of rules) {
    const err = walkBoolValidate(r.body, schema);
    if (err !== null) return err;
  }
  return null;
}

function walkBoolValidate(body: RuleAtom[], schema: Map<string, string>): ParseError | null {
  for (const a of body) {
    if (a.tag === "Sub") {
      const err = walkBoolValidate(a.body, schema);
      if (err !== null) return err;
      continue;
    }
    if (a.tag === "Exception") {
      const err = walkBoolValidate(a.right, schema);
      if (err !== null) return err;
      continue;
    }
    if (a.tag !== "Atom") continue;
    if (a.subAtoms !== undefined) {
      // `!(...)` block. Plain sub-atoms have no weight; agg sub-atoms
      // carry weight in the trailing term slot — treat as queries.
      for (const sub of a.subAtoms) {
        if (sub.kind !== "agg") continue;
        const head = sub.atom.terms[0];
        if (head === undefined || head.tag !== "Symbol") continue;
        if (schema.get(head.name) !== "bool") continue;
        const w = sub.atom.terms[sub.atom.terms.length - 1]!;
        const err = checkBoolQueryWeight(w, head.name, a.span.line);
        if (err !== null) return err;
      }
      continue;
    }
    if (a.weight === undefined) continue;
    const head = a.atom.terms[0];
    if (head === undefined || head.tag !== "Symbol") continue;
    if (schema.get(head.name) !== "bool") continue;
    if (a.marker === "aggregate") {
      const err = checkBoolQueryWeight(a.weight, head.name, a.span.line);
      if (err !== null) return err;
    } else {
      // Assertion side: fact / episode / anchor / ask. Must be literal `1`.
      const w = a.weight;
      if (w.tag !== "Symbol" || w.name !== "1") {
        if (w.tag === "Symbol" && w.name === "0") {
          return { line: a.span.line, message: `bool relation '${head.name}' cannot be asserted as 0; '-> 0' is reserved for queries` };
        }
        return { line: a.span.line, message: `bool relation '${head.name}' assertion weight must be literal '1' (got '${describeTerm(w)}')` };
      }
    }
  }
  return null;
}

function checkBoolQueryWeight(w: Term, relName: string, line: number): ParseError | null {
  if (w.tag === "Variable") return null;
  if (w.tag === "Symbol" && (w.name === "0" || w.name === "1")) return null;
  return { line, message: `bool relation '${relName}' query weight must be '0', '1', or a variable (got '${describeTerm(w)}')` };
}

function describeTerm(t: Term): string {
  if (t.tag === "Symbol") return t.name;
  if (t.tag === "Variable") return t.name;
  return t.tag;
}

function resolveRuleNames(rules: Rule[]): ParseError | null {
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
      if (a.weight !== undefined) collectVarsInTerm(a.weight, out);
      if (a.lLit !== undefined) collectVarsInTerm(a.lLit, out);
      if (a.rLit !== undefined) collectVarsInTerm(a.rLit, out);
    } else if (a.tag === "Equal") {
      collectVarsInTerm(a.lhs, out);
      collectVarsInTerm(a.rhs, out);
    } else if (a.tag === "AggComp") {
      collectAggCompVarNames(a, out);
    }
  }
}

function collectAggCompVarNames(
  comp: Extract<RuleAtom, { tag: "AggComp" }>,
  out: Set<string>,
): void {
  for (const b of comp.body) {
    if (b.tag === "AggComp") {
      collectAggCompVarNames(b, out);
    } else if (b.tag === "Atom") {
      for (const t of b.atom.terms) collectVarsInTerm(t, out);
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
//                appended to anchor.atom.terms exactly once.
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
      out.push({ tag: "Exception", left: it.left, right: inner, span: it.span });
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
      if (frame.anchor === null) {
        return { line: it.line, message: "dot must follow an atom" };
      }
      if (frame.anchor.marker === "aggregate") {
        return { line: it.line, message: "aggregate atom (with '-> weight') cannot appear on the left of '.'" };
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
// arity. Arity = (number of ':' in the head symbol) + 1. A trailing `-> weight`
// counts as the atom's last argument (so `+ dmg -> 3` ≡ `+ dmg 3`, already
// saturated at arity 1 — no fresh-id column). Runs on the dot-desugared body,
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
    if (a.tag === "AggComp") { saturateAggComp(a); continue; }
    if (a.tag !== "Atom") continue; // Equal / Match / Emit / etc. have no head arity
    if (a.subAtoms !== undefined) {
      // `!(...)` block. `agg` subs fold the weight into the trailing term slot,
      // so it is already counted; pad before it. `plain` subs have no weight.
      // The `atom` field is a placeholder alias of the first sub — skip it.
      for (const s of a.subAtoms) {
        if (s.kind === "agg") saturateAggSub(s.atom.terms);
        else saturateHead(s.atom.terms, false);
      }
      continue;
    }
    // The trailing `-> weight` lives in `a.weight`, not in `atom.terms`; it
    // counts as one argument, so a weighted atom needs one fewer padded term.
    saturateHead(a.atom.terms, a.weight !== undefined);
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

// Pad every atom inside a bracket-aggregation query (plain matches; no
// weights inside `[...]`), recursing through nested expressions.
function saturateAggComp(comp: Extract<RuleAtom, { tag: "AggComp" }>): void {
  for (const b of comp.body) {
    if (b.tag === "AggComp") saturateAggComp(b);
    else if (b.tag === "Atom") saturateHead(b.atom.terms, false);
  }
}

// Pad a `!(...)` aggregate sub-atom `[head, ...args, weight]` by inserting
// wildcards before the trailing weight term (which counts as an argument).
function saturateAggSub(terms: Term[]): void {
  const head = terms[0];
  if (head === undefined || head.tag !== "Symbol" || head.name.startsWith("*")) return;
  const want = colonCount(head.name) + 2; // head + (colons + 1) args, weight included
  while (terms.length < want) terms.splice(terms.length - 1, 0, { tag: "Wildcard" });
}

function colonCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ":") n++;
  return n;
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
  if (!aggregators.has(aggregator)) {
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
  // `!(...)` compound constrain (with optional whitespace before `(`).
  // The body is either `(sub, sub, ...)` for a compound, or a single
  // atom shape. Single-atom `!foo` / `!foo -> Z` is canonicalized into a
  // one-element `subAtoms` list so the IR shape is uniform downstream.
  if (marker === "constrain") {
    return parseConstrainBody(text, line);
  }
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
  // A default-marker (`match`) atom that carries a trailing `-> weight`
  // is an aggregate, not a match.
  let outMarker: Marker = marker;
  if (marker === "match" && weight !== undefined) outMarker = "aggregate";
  const out: RuleAtom = { tag: "Atom", marker: outMarker, atom, span: { line } };
  if (weight !== undefined) out.weight = weight;
  return out;
}

// Parse a `!` body (text already stripped of the leading `!`). May be:
//   single-atom plain: `foo X Y`
//   single-atom agg:   `foo X -> W`
//   compound:          `(sub, sub, ...)` where each sub is one of the above
function parseConstrainBody(text: string, line: number): RuleAtom | ParseError {
  const trimmed = text.trim();
  const subs: SubConstrain[] = [];
  if (trimmed.startsWith("(")) {
    // Outer parens. Reject `!(...) -> w` — outer weight is undefined.
    if (findTopArrow(trimmed) >= 0) {
      return { line, message: "'!(...)' block cannot carry an outer '-> weight'" };
    }
    if (!trimmed.endsWith(")")) {
      return { line, message: "'!(...)' block has unbalanced parens" };
    }
    const inner = trimmed.slice(1, -1);
    const pieces = splitTopLevelCommas(inner);
    if (pieces.length === 0 || pieces.every((p) => p.trim().length === 0)) {
      return { line, message: "'!(...)' must contain at least one sub-atom" };
    }
    for (const piece of pieces) {
      const sub = parseConstrainSubAtom(piece.trim(), line);
      if ("message" in sub) return sub;
      subs.push(sub);
    }
  } else {
    const sub = parseConstrainSubAtom(trimmed, line);
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
    span: { line },
  };
}

// Parse one sub-atom inside `!(...)` (or the entire body of a
// single-atom `!`). Accepts only the plain or aggregate shape; no
// markers, no equality, no nested parens-list.
function parseConstrainSubAtom(text: string, line: number): SubConstrain | ParseError {
  if (text.length === 0) return { line, message: "empty sub-atom inside '!(...)'" };
  // Reject embedded markers / equalities by checking the first char.
  const m = text[0]!;
  if (isMarkerChar(m) || m === "=") {
    return { line, message: "sub-atom inside '!(...)' cannot carry a marker or '='" };
  }
  if (m === "(") {
    return { line, message: "sub-atom inside '!(...)' cannot be a parenthesised block" };
  }
  const arrow = findTopArrow(text);
  let headText: string;
  let weight: Term | undefined;
  if (arrow >= 0) {
    headText = text.slice(0, arrow).trim();
    const tail = text.slice(arrow + 2).trim();
    if (tail.length === 0) return { line, message: "missing weight term after '->'" };
    const tailTerms = parseTerms(tokenizeTermText(tail), line);
    if ("message" in tailTerms) return tailTerms;
    if (tailTerms.length !== 1) return { line, message: "weight must be a single term" };
    weight = tailTerms[0]!;
  } else {
    headText = text;
  }
  const headTerms = parseTerms(tokenizeTermText(headText), line);
  if ("message" in headTerms) return headTerms;
  if (headTerms.length === 0) return { line, message: "sub-atom is empty" };
  const headTerm = headTerms[0]!;
  if (headTerm.tag === "Symbol" && headTerm.name.startsWith("*")) {
    return { line, message: `head syms starting with '*' are reserved (got '${headTerm.name}')` };
  }
  if (weight !== undefined) {
    return { kind: "agg", atom: { terms: [...headTerms, weight] } };
  }
  return { kind: "plain", atom: { terms: headTerms } };
}

// Reduction ops accepted in `[ Q | op V ]` (plans/v2-bracket-aggregation.md).
const AGG_COMP_OPS = new Set(["count", "sum", "last"]);

// Parse the inner text of a `[ Q | op V ]` bracket aggregation (brackets
// already stripped by the tokenizer; possibly joined from several source
// lines). `Q` is a comma-separated list of plain match atoms and nested
// `[...]` expressions; the reduction is `op V` with op in AGG_COMP_OPS.
// Reduce-var binding restrictions (occurs in Q, not bound earlier in the
// rule) are checked at decompose time, where the prefix-bound set is known.
function parseAggCompText(text: string, line: number): RuleAtom | ParseError {
  // Locate the single top-level `|` (outside `(...)` and `[...]`).
  let depth = 0;
  let pipe = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "|" && depth === 0) {
      if (pipe >= 0) {
        return { line, message: "aggregate expression has more than one top-level '|'" };
      }
      pipe = i;
    }
  }
  if (pipe < 0) {
    return { line, message: "aggregate expression requires '| <op> <Var>'" };
  }
  const qText = text.slice(0, pipe).trim();
  const rText = text.slice(pipe + 1).trim();

  // Reduction: exactly `op V`.
  const rToks = tokenizeTermText(rText);
  if (rToks.length !== 2) {
    return { line, message: "reduction must be '<op> <Var>'" };
  }
  const op = rToks[0]!;
  if (!AGG_COMP_OPS.has(op)) {
    return { line, message: `unknown reduction op '${op}' (expected count, sum, or last)` };
  }
  const vTok = rToks[1]!;
  if (vTok === "_") {
    return { line, message: "reduction variable cannot be '_'" };
  }
  if (!isVariableToken(vTok)) {
    return { line, message: `reduction must name a variable (got '${vTok}')` };
  }

  // Query items.
  const body: RuleAtom[] = [];
  for (const pieceRaw of splitTopLevelCommasBrackets(qText)) {
    const piece = pieceRaw.trim();
    if (piece.length === 0) {
      return { line, message: "empty item in aggregate query" };
    }
    if (piece.startsWith("[")) {
      if (!piece.endsWith("]")) {
        return { line, message: "unbalanced '[' in aggregate query" };
      }
      const inner = parseAggCompText(piece.slice(1, -1), line);
      if ("message" in inner) return inner;
      body.push(inner);
      continue;
    }
    if (piece.includes("[") || piece.includes("]")) {
      return { line, message: "'[' inside an aggregate query must start a standalone item" };
    }
    const c0 = piece[0]!;
    if (isMarkerChar(c0) || c0 === "=") {
      return { line, message: "aggregate query atoms cannot carry a marker or '='" };
    }
    if (findTopArrow(piece) >= 0) {
      return { line, message: "aggregate query atoms cannot carry '-> weight'" };
    }
    if (piece.includes(".")) {
      return { line, message: "'.' is not allowed inside an aggregate query" };
    }
    if (piece.includes(";") || piece.includes("{") || piece.includes("}")) {
      return { line, message: "aggregate query atoms must be plain atoms" };
    }
    const terms = parseTerms(tokenizeTermText(piece), line);
    if ("message" in terms) return terms;
    if (terms.length === 0) {
      return { line, message: "empty item in aggregate query" };
    }
    const head = terms[0]!;
    if (head.tag === "Symbol" && head.name.startsWith("*")) {
      return { line, message: `head syms starting with '*' are reserved (got '${head.name}')` };
    }
    body.push({ tag: "Atom", marker: "match", atom: { terms }, span: { line } });
  }
  if (body.length === 0) {
    return { line, message: "aggregate query must contain at least one item" };
  }
  return { tag: "AggComp", body, reduce: { op, varName: vTok }, span: { line } };
}

// Split on top-level commas where depth counts both `(...)` and `[...]`.
function splitTopLevelCommasBrackets(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// Split `text` on top-level commas (paren-depth 0). Returns the pieces,
// not stripped.
function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
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

export function tokenizeTermText(text: string): string[] {
  return text.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter((t) => t.length > 0);
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

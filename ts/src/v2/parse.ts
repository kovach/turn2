// v2 parser. Flat-syntax language per notes/turn-program-1.t.
//
// Two passes: tokenize (line-by-line, comment-aware) then parseProgram (turn
// the token stream into rules + schema). Hashconsing is *not* applied here —
// callers run terms through hashcons after parsing.

import type { Atom, Term, Span } from "../types.js";
import type { Marker, Program, Rule, RuleAtom, SchemaDecl, SubConstrain } from "./types.js";

export interface ParseError {
  line: number;
  message: string;
}

type Token =
  | { tag: "open"; line: number }
  | { tag: "close"; sequence: boolean; line: number }
  | { tag: "atom"; marker: Marker; text: string; line: number }
  | { tag: "equal"; text: string; line: number }
  | { tag: "command"; name: string; argText: string; line: number }
  | { tag: "ruleEnd"; line: number }
  | { tag: "dot"; line: number }
  | { tag: "semi"; line: number };

// Parsed `#<name> ...` line. Consumed in parseProgram and not exposed.
type Command =
  | { kind: "def"; name: string; line: number }
  | { kind: "acc"; decl: SchemaDecl };

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
        if (depth === 0 && (c === "," || c === ")" || c === "." || c === ";")) break;
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
  | { kind: "atom"; atom: RuleAtom }            // RuleAtom with tag "Atom" or "Equal"
  | { kind: "sub"; inner: BodyItem[]; sequence: boolean; span: Span }
  | { kind: "dot"; line: number };

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
  if (tok.name === "acc") {
    const decl = parseSchemaText(tok.argText, tok.line);
    if ("message" in decl) return decl;
    return { kind: "acc", decl };
  }
  return { line: tok.line, message: `unknown command '#${tok.name}'` };
}

function parseProgram(tokens: Token[]): Program | ParseError {
  const rules: Rule[] = [];
  const schema = new Map<string, string>();
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
      if (cmd.kind === "acc") {
        if (schema.has(cmd.decl.relation)) {
          return { line: t.line, message: `duplicate schema declaration for '${cmd.decl.relation}'` };
        }
        schema.set(cmd.decl.relation, cmd.decl.aggregator);
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

    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.tag === "ruleEnd") {
        if (depth > 0) { i++; continue; }
        break;
      }
      if (tok.tag === "command") {
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
        i++;
        continue;
      }
      if (tok.tag === "close") {
        if (depth === 0) return { line: tok.line, message: "unmatched ')'" };
        stack.pop();
        const opened = openSubs.pop()!;
        if (tok.sequence) opened.item.sequence = true;
        depth--;
        i++;
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
        i++;
        continue;
      }
      if (tok.tag === "dot") {
        top.items.push({ kind: "dot", line: tok.line });
        i++;
        continue;
      }
      if (tok.tag === "equal") {
        const parsedEq = parseEqualText(tok.text, tok.line);
        if ("message" in parsedEq) return parsedEq;
        top.items.push({ kind: "atom", atom: parsedEq });
        top.needsContent = false;
        i++;
        continue;
      }
      const parsed = parseAtomText(tok.text, tok.marker, tok.line);
      if ("message" in parsed) return parsed;
      top.items.push({ kind: "atom", atom: parsed });
      top.needsContent = false;
      i++;
    }

    if (depth > 0) {
      const ln = openSubs[openSubs.length - 1]!.item.span.line;
      return { line: ln, message: "unmatched '('" };
    }
    if (body.length > 0) {
      const usedNames = new Set<string>();
      collectUsedNames(body, usedNames);
      const counter = { n: 1 };
      const desugared = desugarBody(body, usedNames, counter, undefined);
      if (!Array.isArray(desugared)) return desugared;
      const rule: Rule = { name: "", body: desugared, span: { line: startLine } };
      if (explicitName !== undefined) rule.explicitName = explicitName;
      rules.push(rule);
    } else if (explicitName !== undefined) {
      return { line: startLine, message: "'#def' must precede a rule" };
    }
  }

  const nameErr = resolveRuleNames(rules);
  if (nameErr !== null) return nameErr;

  return { rules, schema };
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

  for (const it of items) {
    if (it.kind === "dot") {
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

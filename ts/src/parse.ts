import type { AggregateInfo, Atom, BodyTree, MacroInvocation, Term, Tree } from "./types.js";
import { idExpand } from "./expand.js";
import { expandMacros } from "./macros.js";

export interface ParseError {
  line: number;
  message: string;
}

export function parse(input: string): Tree | ParseError {
  const nodes = _parseNodes(input);
  if ("message" in nodes) return nodes;
  return {
    tag: "Match",
    constraint: "any",
    id: { tag: "Variable", name: "0" },
    atom: { terms: [] },
    children: nodes,
  };
}

function _parseNodes(input: string): Tree[] | ParseError {
  const roots: Tree[] = [];
  const stack: Array<{ indent: number; node: Tree }> = [];

  for (const [idx, raw] of input.split("\n").entries()) {
    const lineno = idx + 1;
    const indent = raw.length - raw.trimStart().length;
    const afterIndent = raw.slice(indent).replace(/\/.*$/, "");

    if (afterIndent === "" || afterIndent.trim() === "") continue;
    if (afterIndent[0] === "\t") {
      return { line: lineno, message: "tabs are not supported for indentation" };
    }

    const prefix = afterIndent[0];
    const literalTag = prefixToTag(prefix);
    if (literalTag === null) {
      return { line: lineno, message: `invalid literal-type prefix '${prefix}'` };
    }

    let explicitId: Term | null = null;
    let atomStart = 1;
    // Skip optional space between prefix and [
    let bracketStart = 1;
    if (afterIndent[1] === " " && afterIndent[2] === "[") bracketStart = 2;
    if (afterIndent[bracketStart] === "[") {
      const close = afterIndent.indexOf("]", bracketStart + 1);
      if (close === -1) return { line: lineno, message: "unclosed '[' in node id" };
      const idTokens = tokenize(afterIndent.slice(bracketStart + 1, close));
      const idErr = checkReservedTokens(idTokens, lineno);
      if (idErr) return idErr;
      const idTerms = parseTerms(idTokens);
      if (idTerms.length !== 1) return { line: lineno, message: "node id must be a single term" };
      explicitId = idTerms[0]!;
      atomStart = close + 1;
    }

    const rest = afterIndent.slice(atomStart).trim();

    let terms: Term[] = [];
    let aggregateInfo: AggregateInfo | undefined;
    let macroInvocation: MacroInvocation | undefined;

    if (rest.startsWith("@")) {
      const tokens = tokenize(rest.slice(1));
      if (tokens.length === 0) {
        return { line: lineno, message: "macro invocation requires a name" };
      }
      const argTokens = tokens.slice(1);
      const macroErr = checkReservedTokens(argTokens, lineno);
      if (macroErr) return macroErr;
      const name = tokens[0]!;
      // The macro name itself must not start with `_` either.
      if (name.length > 1 && name[0] === "_") {
        return { line: lineno, message: `tokens starting with '_' are reserved (got '${name}')` };
      }
      const args = argTokens.length > 0 ? parseTerms(argTokens) : [];
      macroInvocation = { name, args };
    } else if (literalTag === "Aggregate") {
      const parsed = parseAggregateLine(rest, lineno);
      if ("message" in parsed) return parsed;
      aggregateInfo = parsed;
    } else {
      const restTokens = rest === "" ? [] : tokenize(rest);
      const restErr = checkReservedTokens(restTokens, lineno);
      if (restErr) return restErr;
      terms = parseTerms(restTokens);
    }

    let node: Tree;
    if (literalTag === "Equal") {
      if (terms.length !== 2) {
        return { line: lineno, message: `'=' line must have exactly two terms, got ${terms.length}` };
      }
      node = {
        tag: "Equal",
        lhs: terms[0]!,
        rhs: terms[1]!,
        span: { line: lineno },
        ...(macroInvocation && { macroInvocation }),
      };
    } else if (literalTag === "Ask") {
      // Ask atoms must be a (possibly empty) list of Variables. The `_choose`
      // expansion in expand.ts treats them like positive id-expansion subjects.
      for (const t of terms) {
        if (t.tag !== "Variable") {
          return { line: lineno, message: "'?' atom may only contain variables" };
        }
      }
      node = {
        tag: "Ask",
        id: explicitId ?? { tag: "Variable", name: String(lineno) },
        atom: { terms },
        span: { line: lineno },
        ...(macroInvocation && { macroInvocation }),
      };
    } else {
      node = {
        ...buildTreePayload(literalTag, aggregateInfo),
        id: explicitId ?? { tag: "Variable", name: String(lineno) },
        atom: { terms },
        children: [],
        span: { line: lineno },
        ...(macroInvocation && { macroInvocation }),
      };
    }

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      const { node: completed } = stack.pop()!;
      const top = stack[stack.length - 1]?.node;
      if (top !== undefined) {
        if (top.tag === "Equal") {
          return { line: lineno, message: "'=' line cannot have child nodes" };
        }
        if (top.tag === "Ask") {
          return { line: lineno, message: "'?' line cannot have child nodes" };
        }
        top.children.push(completed);
      } else {
        roots.push(completed);
      }
    }
    stack.push({ indent, node });
  }

  while (stack.length > 0) {
    const { node } = stack.pop()!;
    const top = stack[stack.length - 1]?.node;
    if (top !== undefined) {
      if (top.tag === "Equal") {
        return { line: 0, message: "'=' line cannot have child nodes" };
      }
      if (top.tag === "Ask") {
        return { line: 0, message: "'?' line cannot have child nodes" };
      }
      top.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

type LiteralTag = "Match" | "Before" | "Overlap" | "Assert" | "Ask" | "Constrain" | "Aggregate" | "Equal";

function prefixToTag(ch: string | undefined): LiteralTag | null {
  switch (ch) {
    case "-": return "Match";
    case "<": return "Before";
    case ",": return "Overlap";
    case "+": return "Assert";
    case "?": return "Ask";
    case "!": return "Constrain";
    case "#": return "Aggregate";
    case "=": return "Equal";
    default: return null;
  }
}

type BodyTagPayload =
  | { tag: "Match"; constraint: "any" }
  | { tag: "Before"; constraint: "any" }
  | { tag: "Overlap"; constraint: "any" }
  | { tag: "Assert" }
  | { tag: "Constrain" }
  | { tag: "Aggregate"; info: AggregateInfo };

function buildTreePayload(tag: Exclude<LiteralTag, "Equal" | "Ask">, aggInfo?: AggregateInfo): BodyTagPayload {
  switch (tag) {
    case "Match": return { tag: "Match", constraint: "any" };
    case "Before": return { tag: "Before", constraint: "any" };
    case "Overlap": return { tag: "Overlap", constraint: "any" };
    case "Assert": return { tag: "Assert" };
    case "Constrain": return { tag: "Constrain" };
    case "Aggregate": return { tag: "Aggregate", info: aggInfo! };
  }
}

function tokenize(s: string): string[] {
  return s.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter((t) => t.length > 0);
}

// Tokens beginning with `_` (other than the bare wildcard `_`) are reserved
// for engine-emitted predicates like `_choose`, `_agg-instance`, etc.
function checkReservedTokens(tokens: string[], lineno: number): ParseError | null {
  for (const tok of tokens) {
    if (tok.length > 1 && tok[0] === "_") {
      return { line: lineno, message: `tokens starting with '_' are reserved (got '${tok}')` };
    }
  }
  return null;
}

function parseAggregateLine(rest: string, lineno: number): AggregateInfo | ParseError {
  const arrowIdx = rest.indexOf("->");
  if (arrowIdx === -1) {
    return { line: lineno, message: "aggregate requires '->' separating args from output" };
  }

  const beforeArrow = rest.slice(0, arrowIdx).trim();
  const afterArrow = rest.slice(arrowIdx + 2).trim();

  if (beforeArrow === "") {
    return { line: lineno, message: "aggregate requires function name before '->'" };
  }
  if (afterArrow === "") {
    return { line: lineno, message: "aggregate requires output term after '->'" };
  }

  const tokens = tokenize(beforeArrow);
  const funcName = tokens[0]!;
  if (funcName.length > 1 && funcName[0] === "_") {
    return { line: lineno, message: `tokens starting with '_' are reserved (got '${funcName}')` };
  }
  const argTokens = tokens.slice(1);
  const argErr = checkReservedTokens(argTokens, lineno);
  if (argErr) return argErr;
  const args = argTokens.length > 0 ? parseTerms(argTokens) : [];

  const outTokens = tokenize(afterArrow);
  const outErr = checkReservedTokens(outTokens, lineno);
  if (outErr) return outErr;
  const outTerms = parseTerms(outTokens);
  if (outTerms.length !== 1) {
    return { line: lineno, message: "aggregate output must be a single term" };
  }

  return { funcName, args, out: outTerms[0]! };
}

function parseTerms(tokens: string[], pos: { i: number } = { i: 0 }): Term[] {
  const terms: Term[] = [];
  while (pos.i < tokens.length && tokens[pos.i] !== ")") {
    const tok = tokens[pos.i++]!;
    if (tok === "(") {
      const inner = parseTerms(tokens, pos);
      if (tokens[pos.i] === ")") pos.i++;
      terms.push({ tag: "Atom", atom: { terms: inner } });
    } else if (tok === "_") {
      terms.push({ tag: "Wildcard" });
    } else if (/^\*\d+$/.test(tok)) {
      terms.push({ tag: "Ref", id: parseInt(tok.slice(1), 10) });
    } else {
      terms.push(
        tok[0] !== undefined && /[A-Z]/.test(tok[0])
          ? { tag: "Variable", name: tok }
          : { tag: "Symbol", name: tok }
      );
    }
  }
  return terms;
}

function adjustSpans(tree: Tree, offset: number): Tree {
  const newSpan = tree.span ? { ...tree.span, line: tree.span.line + offset } : undefined;
  if (tree.tag === "Equal" || tree.tag === "Ask") {
    return { ...tree, ...(newSpan && { span: newSpan }) };
  }
  return {
    ...tree,
    ...(newSpan && { span: newSpan }),
    children: tree.children.map((c: Tree) => adjustSpans(c, offset)),
  };
}

export interface Frontmatter {
  display?: string;
}

export function parseFrontmatter(source: string): { frontmatter: Frontmatter; body: string } {
  // Frontmatter is the first contiguous block of `/` comment lines at the
  // start of the source. Each line is a normal comment in the body; scanning
  // for `key: value` pairs here is purely additive. Line numbers and rule
  // indices are preserved since the body parser skips the same lines.
  const frontmatter: Frontmatter = {};
  const match = source.match(/^(?:\/.*\n)+/);
  if (match) {
    for (const line of match[0].split("\n")) {
      const kvMatch = line.match(/^\/\s+(\w+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1]!;
        const value = kvMatch[2]!;
        if (key === "display") frontmatter.display = value;
      }
    }
  }
  return { frontmatter, body: source };
}

export function parseSource(
  source: string,
): { frontmatter: Frontmatter; body: string; patterns: Tree[] } | ParseError {
  const { frontmatter, body } = parseFrontmatter(source);
  const patterns = parsePatterns(body);
  if ("message" in patterns) return patterns;
  return { frontmatter, body, patterns };
}

// `ruleNamePrefix` is the lex-namespace baked into positive id atoms via
// `idExpand`. Callers that combine multiple `parsePatterns` outputs into one
// fixpoint must use distinct prefixes, or two positives with matching
// (prefix, idN) tails will hashcons to the same Ref and silently dedup.
export function parsePatterns(input: string, ruleNamePrefix = "r"): Tree[] | ParseError {
  const lines = input.split("\n");
  const chunks: Array<{ startLine: number; text: string }> = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i === lines.length || lines[i]!.trim() === "") {
      chunks.push({ startLine: start + 1, text: lines.slice(start, i).join("\n") });
      start = i + 1;
    }
  }
  const trees: Tree[] = [];
  let ruleIndex = 1;
  for (const { startLine, text } of chunks) {
    if (text.trim() === "") continue;
    const result = parse(text);
    if ("message" in result) {
      return { line: startLine + result.line - 1, message: result.message };
    }
    // Adjust spans to be absolute line numbers
    const adjusted = adjustSpans(result, startLine - 1);
    const expanded = expandMacros(adjusted);
    // The chunk parser always wraps its result in an implicit Match root, so
    // `expanded` is body-bearing; guard for the type.
    if (expanded.tag === "Equal" || expanded.tag === "Ask") continue;
    // Skip chunks that contain only comments — they produce no rule nodes.
    if (expanded.children.length === 0) continue;
    trees.push(idExpand(expanded, `${ruleNamePrefix}${ruleIndex++}`));
  }
  return trees;
}

// --- Formatting ---

export function formatTree(tree: Tree, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (tree.tag === "Equal") {
    return `${pad}= ${formatTerm(tree.lhs)} ${formatTerm(tree.rhs)}\n`;
  }
  if (tree.tag === "Ask") {
    const terms = tree.atom.terms.map(formatTerm).join(" ");
    return pad + (terms === "" ? "?" : `? ${terms}`) + "\n";
  }
  let line: string;
  if (tree.tag === "Aggregate") {
    const { funcName, args, out } = tree.info;
    const argsStr = args.length > 0 ? " " + args.map(formatTerm).join(" ") : "";
    line = `# ${funcName}${argsStr} -> ${formatTerm(out)}`;
  } else {
    line = formatNode(tree);
  }
  return pad + line + "\n" +
    tree.children.map((c: Tree) => formatTree(c, indent + 1)).join("");
}

export function formatNode(tree: BodyTree): string {
  const prefix = tagToPrefix(tree.tag);
  const terms = tree.atom.terms.map(formatTerm).join(" ");
  return terms === "" ? prefix : `${prefix} ${terms}`;
}

export function formatAtom(atom: Atom): string {
  return atom.terms.map(formatTerm).join(" ");
}

export function formatTerm(term: Term): string {
  switch (term.tag) {
    case "Symbol": return term.name;
    case "Variable": return term.name;
    case "Atom": return `(${formatAtom(term.atom)})`;
    case "Wildcard": return "_";
    case "Ref": return `*${term.id}`;
  }
}

function tagToPrefix(t: Tree["tag"]): string {
  switch (t) {
    case "Match": return "-";
    case "Before": return "<";
    case "Overlap": return ",";
    case "Assert": return "+";
    case "Ask": return "?";
    case "Constrain": return "!";
    case "Aggregate": return "#";
    case "Equal": return "=";
  }
}

export function buildSpanIndex(trees: Tree[]): Map<number, Tree[]> {
  const index = new Map<number, Tree[]>();
  function walk(t: Tree) {
    if (t.span) {
      const list = index.get(t.span.line) ?? [];
      list.push(t);
      index.set(t.span.line, list);
    }
    if (t.tag !== "Equal" && t.tag !== "Ask") t.children.forEach(walk);
  }
  trees.forEach(walk);
  return index;
}

import type { AggregateInfo, Atom, Literal, LiteralType, MacroInvocation, Term, Tree } from "./types.js";
import { idExpand } from "./expand.js";
import { expandMacros } from "./macros.js";

export interface ParseError {
  line: number;
  message: string;
}

export function parse(input: string): Tree | ParseError {
  const nodes = _parseNodes(input);
  if ("message" in nodes) return nodes;
  return { id: { tag: "Variable", name: "0" }, literal: { literalType: "Match", atom: { terms: [] } }, children: nodes };
}

function _parseNodes(input: string): Tree[] | ParseError {
  const roots: Tree[] = [];
  const stack: Array<{ indent: number; node: Tree }> = [];

  for (const [idx, raw] of input.split("\n").entries()) {
    const lineno = idx + 1;
    const indent = raw.length - raw.trimStart().length;
    const afterIndent = raw.slice(indent).replace(/--.*$/, "");

    if (afterIndent === "" || afterIndent.trim() === "") continue;
    if (afterIndent[0] === "\t") {
      return { line: lineno, message: "tabs are not supported for indentation" };
    }

    const prefix = afterIndent[0];
    const literalType = prefixToLiteralType(prefix);
    if (literalType === null) {
      return { line: lineno, message: `invalid literal-type prefix '${prefix}'` };
    }

    let explicitId: Term | null = null;
    let atomStart = 1;
    if (afterIndent[1] === "[") {
      const close = afterIndent.indexOf("]", 2);
      if (close === -1) return { line: lineno, message: "unclosed '[' in node id" };
      const idTokens = tokenize(afterIndent.slice(2, close));
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
      const name = tokens[0]!;
      const args = tokens.length > 1 ? parseTerms(tokens.slice(1)) : [];
      macroInvocation = { name, args };
    } else if (literalType === "Aggregate") {
      const parsed = parseAggregateLine(rest, lineno);
      if ("message" in parsed) return parsed;
      aggregateInfo = parsed;
    } else {
      terms = rest === "" ? [] : parseTerms(tokenize(rest));
    }

    const literal: Literal = { literalType, atom: { terms } };
    const node: Tree = {
      id: explicitId ?? { tag: "Variable", name: String(lineno) },
      literal,
      children: [],
      ...(aggregateInfo && { aggregateInfo }),
      ...(macroInvocation && { macroInvocation }),
    };

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      const { node: completed } = stack.pop()!;
      if (stack.length > 0) {
        stack[stack.length - 1]!.node.children.push(completed);
      } else {
        roots.push(completed);
      }
    }
    stack.push({ indent, node });
  }

  while (stack.length > 0) {
    const { node } = stack.pop()!;
    if (stack.length > 0) {
      stack[stack.length - 1]!.node.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function prefixToLiteralType(ch: string | undefined): LiteralType | null {
  switch (ch) {
    case "-": return "Match";
    case "<": return "Before";
    case "+": return "Assert";
    case "?": return "Ask";
    case "!": return "Constrain";
    case "#": return "Aggregate";
    default: return null;
  }
}

function tokenize(s: string): string[] {
  return s.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter((t) => t.length > 0);
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
  const args = tokens.length > 1 ? parseTerms(tokens.slice(1)) : [];

  const outTokens = tokenize(afterArrow);
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

export function parsePatterns(input: string): Tree[] | ParseError {
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
    const expanded = expandMacros(result);
    trees.push(idExpand(expanded, `r${ruleIndex++}`));
  }
  return trees;
}

// --- Formatting ---

export function formatTree(tree: Tree, indent = 0): string {
  let line: string;
  if (tree.aggregateInfo) {
    const { funcName, args, out } = tree.aggregateInfo;
    const argsStr = args.length > 0 ? " " + args.map(formatTerm).join(" ") : "";
    line = `# ${funcName}${argsStr} -> ${formatTerm(out)}`;
  } else {
    line = formatLiteral(tree.literal);
  }
  return "  ".repeat(indent) + line + "\n" +
    tree.children.map((c) => formatTree(c, indent + 1)).join("");
}

export function formatLiteral(literal: Literal): string {
  const prefix = literalTypeToPrefix(literal.literalType);
  const terms = literal.atom.terms.map(formatTerm).join(" ");
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
  }
}

function literalTypeToPrefix(t: LiteralType): string {
  switch (t) {
    case "Match": return "-";
    case "Before": return "<";
    case "Assert": return "+";
    case "Ask": return "?";
    case "Constrain": return "!";
    case "Aggregate": return "#";
  }
}

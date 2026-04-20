import type { Atom, Literal, LiteralType, Term, Tree } from "./types.js";
import { idExpand } from "./expand.js";

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
    const terms: Term[] = rest === "" ? [] : parseTerms(tokenize(rest));

    const literal: Literal = { literalType, atom: { terms } };
    const node: Tree = { id: explicitId ?? { tag: "Variable", name: String(lineno) }, literal, children: [] };

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
    default: return null;
  }
}

function tokenize(s: string): string[] {
  return s.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter((t) => t.length > 0);
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
    trees.push(idExpand(result, `r${ruleIndex++}`));
  }
  return trees;
}

// --- Formatting ---

export function formatTree(tree: Tree, indent = 0): string {
  return "  ".repeat(indent) + formatLiteral(tree.literal) + "\n" +
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
  }
}

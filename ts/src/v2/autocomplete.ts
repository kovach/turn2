// Pure (DOM-free) core of the editor symbol/variable autocomplete.
// See plans/v2-editor-autocomplete.md and notes/overview.md `# editor auto-complete`.
//
// The editor layer (editor.ts) owns cursor geometry and the overlay box; this
// module owns the data: which symbols/variables are candidates, and how a
// partial token ranks them.

import type { Term } from "../types.js";
import type { Program, Rule, RuleAtom } from "./types.js";
import { isSymbolToken, isVariableToken, parse, tokenize, tokenizeTermText } from "./parse.js";

// --- candidate ranking ------------------------------------------------------

// True if `q` is a subsequence of `s`: every char of `q` appears in `s`, in
// order, with arbitrary gaps. Hyphens are ordinary characters here.
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

// Rank `candidates` against the partial token `prefix`:
//   - exact match (a candidate equals `prefix`) suppresses everything → []
//   - strict-prefix matches first, then subsequence matches that were not
//     strict-prefix matches (i.e. every contiguous match ranks above any
//     non-contiguous one)
//   - within each of those two groups, shortest candidate first, ties broken
//     by candidate (document) order
//   - capped at `limit` (default 5)
export function completions(
  prefix: string,
  candidates: Iterable<string>,
  limit = 5,
): string[] {
  if (prefix.length === 0) return [];
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const c of candidates) {
    if (c === prefix) return []; // exact match suppresses
    if (seen.has(c)) continue;
    seen.add(c);
    uniq.push(c);
  }
  const strict: string[] = [];
  const subseq: string[] = [];
  for (const c of uniq) {
    if (c.startsWith(prefix)) strict.push(c);
    else if (isSubsequence(prefix, c)) subseq.push(c);
  }
  // Stable sort each group by length so shorter candidates rank first while
  // ties keep their original (document) order.
  const byLength = (a: string, b: string) => a.length - b.length;
  strict.sort(byLength);
  subseq.sort(byLength);
  return [...strict, ...subseq].slice(0, limit);
}

// --- candidate sources ------------------------------------------------------

// All Symbol tokens occurring in `text`, in document order (left-to-right,
// top-to-bottom), deduped. Works even when the program does not parse: it
// relies only on the lexer, and falls back to a lenient split if even
// tokenizing fails. Compiler-internal `*`-headed symbols are excluded.
//
// `#agg` declarations also contribute their head relation name (the first
// token of the directive's arg text), so a relation that is only declared and
// never otherwise written still completes. Other directives (`#def`, `#js`)
// are intentionally not mined here.
export function collectProgramSymbols(text: string): Set<string> {
  const out = new Set<string>();
  const add = (w: string) => {
    if (isSymbolToken(w) && !w.startsWith("*")) out.add(w);
  };
  const toks = tokenize(text);
  if (Array.isArray(toks)) {
    for (const t of toks) {
      if (t.tag === "atom" || t.tag === "equal") {
        for (const w of tokenizeTermText(t.text)) add(w);
      } else if (t.tag === "command" && t.name === "agg") {
        const head = tokenizeTermText(t.argText)[0];
        if (head !== undefined) add(head);
      }
    }
  } else {
    // Lexing failed (e.g. a malformed `#`/`@js` line): split leniently so
    // symbol completion still offers something.
    for (const w of text.split(/[\s(),.;]+/)) add(w);
  }
  return out;
}

function collectVarsFromTerm(t: Term, out: Set<string>): void {
  if (t.tag === "Variable") out.add(t.name);
  else if (t.tag === "Atom" || t.tag === "Id") {
    for (const u of t.atom.terms) collectVarsFromTerm(u, out);
  }
}

function collectVarsFromBody(body: RuleAtom[], out: Set<string>): void {
  for (const a of body) {
    if (a.tag === "Atom") {
      if (a.atom) for (const t of a.atom.terms) collectVarsFromTerm(t, out);
      if (a.weight) collectVarsFromTerm(a.weight, out);
      if (a.subAtoms) {
        for (const s of a.subAtoms) for (const t of s.atom.terms) collectVarsFromTerm(t, out);
      }
    } else if (a.tag === "Sub") {
      collectVarsFromBody(a.body, out);
    } else if (a.tag === "Equal") {
      collectVarsFromTerm(a.lhs, out);
      collectVarsFromTerm(a.rhs, out);
    }
    // No other tags occur pre-expand.
  }
}

// The rule whose source region contains 1-indexed `line`: the last rule whose
// span starts at or before `line` (rules are stored in source order, and
// `span.line` is the rule's first line).
function ruleAtLine(prog: Program, line: number): Rule | null {
  let best: Rule | null = null;
  for (const r of prog.rules) {
    if (r.span.line <= line) best = r;
    else break;
  }
  return best;
}

// Variables in scope for the rule containing 1-indexed `line`. Returns null if
// the program does not parse (per spec: variable completion is disabled on a
// broken parse) or if no rule contains the line.
export function collectRuleVariables(text: string, line: number): Set<string> | null {
  const prog = parse(text);
  if (!("rules" in prog)) return null; // ParseError
  const rule = ruleAtLine(prog, line);
  if (!rule) return null;
  const out = new Set<string>();
  collectVarsFromBody(rule.body, out);
  return out;
}

// --- top-level entry --------------------------------------------------------

// Completions for partial token `token` at 1-indexed `line` of `text`. The
// caller (editor) has already established that the cursor is at the right end
// of `token` (whitespace/EOL to the right, non-empty to the left).
export function suggestionsFor(text: string, token: string, line: number): string[] {
  if (token.length === 0) return [];
  if (isSymbolToken(token)) {
    return completions(token, collectProgramSymbols(text));
  }
  if (isVariableToken(token)) {
    const vars = collectRuleVariables(text, line);
    if (!vars) return [];
    return completions(token, vars);
  }
  return [];
}

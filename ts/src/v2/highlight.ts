// Lexical syntax highlighting for Turn (v2) source, DOM-free. A port of
// si/report/turnhl.py (the Spirit Island report's highlighter): the same
// token classes, so the same `--t-<cls>` palette styles both. Lexical on
// purpose, so it works on a program that doesn't parse.
//
// Classes:
//   c   comment                     -- ...
//   d   directive                   #acc #js-def #def ...
//   sl  launch / continue-after     ~  ~>  >
//   sa  assertion                   +  ^
//   sq  choice                      ?  ?[rng]  !
//   ex  exception                   {  }  =>
//   op  acc rule / sequencing       /  ;  .
//   p   other punctuation           ,  (  )  =
//   ag  aggregation op              @sum @last ...
//   n   number                      3  -7
//   v   variable                    Cap  _
//   b   builtin                     lt gt le ge is
//   r   relation (head of an atom)
//   s   other symbol
//   js  javascript body of #js / #js-def

export type HlClass =
  | "c" | "d" | "sl" | "sa" | "sq" | "ex" | "op" | "p" | "ag" | "n" | "v" | "b" | "r" | "s" | "js";

export interface HlToken {
  cls: HlClass;
  start: number; // column, inclusive
  end: number;   // column, exclusive
}

const BUILTINS = new Set(["lt", "gt", "le", "ge", "is"]);

// One alternative per group, tried in order at each position (as the
// Python verbose regex does).
const TOKEN = new RegExp(
  [
    String.raw`(?<ws>\s+)`,
    String.raw`(?<c>--.*$)`,
    String.raw`(?<d>#[a-z][\w-]*)`,
    String.raw`(?<ask>\?\[[a-z]+\])`,
    String.raw`(?<sl>~>|~)`,
    String.raw`(?<ex>=>|[{}])`,
    String.raw`(?<sa>[+^])`,
    String.raw`(?<sq>[?!])`,
    String.raw`(?<gt>>)`,
    String.raw`(?<ag>@[a-z-]+)`,
    String.raw`(?<n>-?\d+(?:\.\d+)?)`,
    String.raw`(?<v>[A-Z][\w']*|_\w*)`,
    String.raw`(?<id>[a-z*][\w:'*/-]*[\w'*]|[a-z*])`,
    String.raw`(?<op>[/;.,()=])`,
    String.raw`(?<other>.)`,
  ].join("|"),
  "y",
);

// After these, the next identifier is the head of an atom.
const HEAD_BEFORE = new Set(["sol", ",", "(", "{", "=>", "/", ".", ";", "sigil"]);

// Carried across lines: brace depth inside a multi-line `#js` body.
export interface HlState {
  js: number;
}

export function highlightLine(line: string, state: HlState): HlToken[] {
  if (state.js > 0) {
    state.js = Math.max(state.js + count(line, "{") - count(line, "}"), 0);
    return line.length === 0 ? [] : [{ cls: "js", start: 0, end: line.length }];
  }
  const js = /^(\s*)(#js(?:-def)?)(\s+)(.*)$/.exec(line);
  if (js !== null) return highlightJsHead(line, js, state);

  const out: HlToken[] = [];
  let prev = "sol";
  let pos = 0;
  while (pos < line.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(line)!;
    const kind = Object.keys(m.groups!).find((k) => m.groups![k] !== undefined)!;
    const text = m[0];
    const start = pos;
    pos += text.length;
    const push = (cls: HlClass): void => { out.push({ cls, start, end: pos }); };
    switch (kind) {
      case "ws":
        continue;
      case "c":
        push("c");
        continue;
      case "ask":
        push("sq"); prev = "sigil"; continue;
      case "sl": case "sa": case "sq":
        push(kind); prev = "sigil"; continue;
      case "gt":
        push("sl"); prev = "sigil"; continue;
      case "ex":
        push("ex"); prev = text; continue;
      case "id":
        push(BUILTINS.has(text) ? "b" : HEAD_BEFORE.has(prev) ? "r" : "s");
        prev = "id";
        continue;
      case "op":
        push("/;.".includes(text) ? "op" : "p");
        prev = text;
        continue;
      default:
        push(kind === "d" || kind === "ag" || kind === "n" || kind === "v" ? kind : "p");
        prev = kind === "d" ? "sigil" : kind;
    }
  }
  return out;
}

export function highlightLines(src: string): HlToken[][] {
  const state: HlState = { js: 0 };
  return src.split("\n").map((l) => highlightLine(l, state));
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// `#js (sig) { … }` / `#js-def name ±P … {`: directive, name, mode marks
// and parameters, then the body as `js`.
function highlightJsHead(line: string, m: RegExpExecArray, state: HlState): HlToken[] {
  const [, ind, kw, sp, rest] = m as unknown as [string, string, string, string, string];
  const out: HlToken[] = [];
  let col = ind.length;
  out.push({ cls: "d", start: col, end: col + kw.length });
  col += kw.length + sp.length;
  const brace = rest.indexOf("{");
  const head = brace < 0 ? rest : rest.slice(0, brace);
  const body = brace < 0 ? "" : rest.slice(brace);
  state.js = Math.max(count(body, "{") - count(body, "}"), 0);
  const name = /^\S+/.exec(head);
  let i = 0;
  if (name !== null) {
    out.push({ cls: "r", start: col, end: col + name[0].length });
    i = name[0].length;
  }
  const param = /([+-])([A-Za-z]\w*)/g;
  param.lastIndex = i;
  for (let pm = param.exec(head); pm !== null; pm = param.exec(head)) {
    out.push({ cls: "sq", start: col + pm.index, end: col + pm.index + 1 });
    out.push({ cls: "v", start: col + pm.index + 1, end: col + pm.index + pm[0].length });
  }
  if (body !== "") out.push({ cls: "js", start: col + head.length, end: line.length });
  return out;
}

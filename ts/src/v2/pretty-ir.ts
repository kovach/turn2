// Human-oriented renderer for the post-expand v2 IR (`--pretty` in v2-cli).
// `print-ir.ts` is a faithful structural dump; this one trades fidelity for
// legibility. It is debug output only — it does not round-trip through
// `parse`. Transformations, all purely presentational:
//
//   - Variables: user variables print bare (`X`, no `?`). Compiler-fresh
//     `_<prefix>_<n>` variables print as `<prefix>` + subscript (`l₁`,
//     `xl₂`). The anchor SSA family (`xl` / `xr`, minted from one shared
//     counter, in pairs except that `>p` mints only an `xl`) is renumbered
//     densely per prefix, so a match's pair usually shares a subscript;
//     every other family keeps its number (for
//     `l` / `r` / `id` that's the lexical position, matching `mom@k`).
//   - `bot` / `top` print as `⊥` / `⊤`.
//   - Copies are folded away: an `Equal` defining a compiler variable as a
//     variable / symbol (`l₄ = l₃`, `r₂ = ⊤`), or as an identity window
//     step (`xl = max(⊥, x)`, `xr = min(⊤, x)`), drops out and the variable
//     prints as its value downstream.
//     Order checks that are then trivially true (`⊥ ≤ x`, `x ≤ ⊤`, `x ≤ x`)
//     are dropped too.
//   - Fresh-id templates `(*mom rule k (*chain ...) l)` print as
//     `mom@k⟨...⟩.l` (`*id` / `*var` / `*choose` likewise; the rule name is
//     shown only when it isn't the enclosing rule). A chain that occurs more
//     than once and has at least MIN_ALIAS_LEN elements is hoisted into an
//     alias `κ₁ := ⟨...⟩`, printed just before its first use and referenced
//     as `mom@k(κ₁).l`.
//   - Atom keywords are dropped: `Le a b` → `a ≤ b`, `AssertLt a b` →
//     `+ a < b`, `Emit` → `+ atom @ [l, r]`, `Match` → `atom @ [l, r]`
//     (trailing `_`s stripped; `Δ` / `old` mark semi-naive delta / old
//     matches), `Equal` → `lhs = rhs`.

import type { Atom, Term } from "./term.js";
import type { Expr, Rule, RuleAtom } from "./types.js";
import { exprTerms } from "./types.js";
import { lineTag, renderRuleAtom, type RenderOptions } from "./print-ir.js";

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n: number): string => String(n).replace(/\d/g, (d) => SUBSCRIPTS[Number(d)]!);

// Fresh-id template heads, all shaped `(head rule lexPos (*chain ...) extra?)`.
const TEMPLATE_HEADS = new Set(["*id", "*mom", "*var", "*choose"]);

// Families renumbered densely (see header).
const DENSE_FAMILIES = new Set(["xl", "xr"]);

// Shorter chains print inline even when repeated.
const MIN_ALIAS_LEN = 3;

interface Ctx {
  ruleName: string;
  // Folded identity steps: compiler variable → the term it equals.
  subst: Map<string, Term>;
  // Dense renumbering for DENSE_FAMILIES: variable name → index.
  dense: Map<string, number>;
  // Chain text → alias, for chains that occur more than once.
  aliases: Map<string, string>;
  // Counting pass: chain text → occurrences (null in the rendering pass).
  counts: Map<string, number> | null;
  // Rendering pass: aliases referenced by the line being rendered.
  used: Set<string>;
}

function parseFresh(name: string): { prefix: string; n: number } | null {
  const m = /^_([a-zA-Z]+?)_?(\d+)$/.exec(name);
  return m === null ? null : { prefix: m[1]!, n: Number(m[2]) };
}

function varName(name: string, ctx: Ctx): string {
  const f = parseFresh(name);
  if (f === null) return name;
  return f.prefix + subscript(ctx.dense.get(name) ?? f.n);
}

function resolve(t: Term, ctx: Ctx): Term {
  while (t.tag === "Variable") {
    const s = ctx.subst.get(t.name);
    if (s === undefined) break;
    t = s;
  }
  return t;
}

function term(t0: Term, ctx: Ctx): string {
  const t = resolve(t0, ctx);
  switch (t.tag) {
    case "Variable": return varName(t.name, ctx);
    case "Wildcard": return "_";
    case "Ref": return `*${t.id}`;
    case "Symbol":
      return t.name === "bot" ? "⊥" : t.name === "top" ? "⊤" : t.name;
    case "Id":
    case "Atom": {
      const ts = t.atom.terms;
      const head = ts[0];
      if (head?.tag === "Symbol" && head.name === "*chain") return chain(ts.slice(1), ctx);
      if (head?.tag === "Symbol" && TEMPLATE_HEADS.has(head.name)) {
        const [, rule, pos, ch, extra] = ts;
        const chainHead = ch?.tag === "Id" || ch?.tag === "Atom" ? ch.atom.terms[0] : undefined;
        if (rule?.tag === "Symbol" && pos?.tag === "Symbol" && ts.length <= 5 &&
            chainHead?.tag === "Symbol" && chainHead.name === "*chain") {
          const where = rule.name === ctx.ruleName ? pos.name : `${rule.name}.${pos.name}`;
          const suffix = extra === undefined ? ""
            : head.name === "*mom" ? `.${term(extra, ctx)}`
            : term(extra, ctx);
          return `${head.name.slice(1)}@${where}${term(ch!, ctx)}${suffix}`;
        }
      }
      return `(${ts.map((x) => term(x, ctx)).join(" ")})`;
    }
  }
}

function chain(ts: Term[], ctx: Ctx): string {
  const text = `⟨${ts.map((x) => term(x, ctx)).join(" ")}⟩`;
  if (ctx.counts !== null) {
    ctx.counts.set(text, (ctx.counts.get(text) ?? 0) + 1);
    return text;
  }
  const alias = ctx.aliases.get(text);
  if (alias === undefined) return text;
  ctx.used.add(text);
  return `(${alias})`;
}

function atomText(a: Atom, ctx: Ctx, stripTrailingWildcards: boolean): string {
  let ts = a.terms;
  if (stripTrailingWildcards) {
    let end = ts.length;
    while (end > 1 && ts[end - 1]!.tag === "Wildcard") end--;
    ts = ts.slice(0, end);
  }
  return ts.map((x) => term(x, ctx)).join(" ");
}

function expr(e: Expr, ctx: Ctx): string {
  switch (e.tag) {
    case "Max": return `max(${term(e.a, ctx)}, ${term(e.b, ctx)})`;
    case "Min": return `min(${term(e.a, ctx)}, ${term(e.b, ctx)})`;
    case "JsCall": return `@js(${[e.func, ...e.args.map((x) => term(x, ctx))].join(" ")})`;
    default: return term(e, ctx);
  }
}

const isSym = (t: Term, name: string): boolean => t.tag === "Symbol" && t.name === name;

// The body line for one atom, or null when it is folded away.
function line(a: RuleAtom, ctx: Ctx): string | null {
  const iv = (l: Term, r: Term) => `@ [${term(l, ctx)}, ${term(r, ctx)}]`;
  switch (a.tag) {
    case "Match": {
      const c = a.constraint === "delta" ? "Δ " : a.constraint === "old" ? "old " : "";
      return `${c}${atomText(a.atom, ctx, true)} ${iv(a.l, a.r)}`;
    }
    case "Emit":
      return `+ ${atomText(a.atom, ctx, false)} ${iv(a.l, a.r)}`;
    case "Le": {
      const x = resolve(a.a, ctx), y = resolve(a.b, ctx);
      if (isSym(x, "bot") || isSym(y, "top")) return null;
      const xs = term(x, ctx), ys = term(y, ctx);
      return xs === ys ? null : `${xs} ≤ ${ys}`;
    }
    case "AssertLt":
      return `+ ${term(a.a, ctx)} < ${term(a.b, ctx)}`;
    case "Equal":
      if (a.lhs.tag === "Variable" && ctx.subst.has(a.lhs.name)) return null;
      return `${term(a.lhs, ctx)} = ${expr(a.rhs, ctx)}`;
    case "JsIterate":
      return `js ${[a.func, ...a.args.map((x) => term(x, ctx))].join(" ")}`;
    case "AccMatch":
      return `acc ${atomText(a.atom, ctx, false)} @ ${term(a.moment, ctx)}`;
    case "AccContribute":
      return `+acc ${[a.relation, ...a.terms.map((x) => term(x, ctx))].join(" ")}` +
        ` @ ⊔{${a.moments.map((x) => term(x, ctx)).join(", ")}}` +
        ` by {${a.ids.map((x) => term(x, ctx)).join(", ")}}`;
    case "Atom":
    case "Sub":
    case "AggComp":
    case "Exception":
      // Pre-expand atoms: no pretty form; fall back to the structural dump.
      return renderRuleAtom(a);
  }
}

function atomTerms(a: RuleAtom): Term[] {
  switch (a.tag) {
    case "Match":
    case "Emit": return [...a.atom.terms, a.l, a.r];
    case "Le":
    case "AssertLt": return [a.a, a.b];
    case "Equal": return [a.lhs, ...exprTerms(a.rhs)];
    case "JsIterate": return a.args;
    case "AccMatch": return [...a.atom.terms, a.moment];
    case "AccContribute": return [...a.terms, ...a.moments, ...a.ids];
    default: return [];
  }
}

function collectVars(t: Term, out: Set<string>): void {
  if (t.tag === "Variable") out.add(t.name);
  else if (t.tag === "Atom" || t.tag === "Id") for (const x of t.atom.terms) collectVars(x, out);
}

function buildCtx(rule: Rule): Ctx {
  const ctx: Ctx = {
    ruleName: rule.name,
    subst: new Map(),
    dense: new Map(),
    aliases: new Map(),
    counts: null,
    used: new Set(),
  };
  // Fold copies and identity window steps. Only an Equal that *defines* its
  // compiler-fresh lhs (first occurrence in the body) folds; one whose lhs
  // is already bound is a check and stays.
  const firstOcc = new Map<string, number>();
  rule.body.forEach((a, i) => {
    const vs = new Set<string>();
    for (const t of atomTerms(a)) collectVars(t, vs);
    for (const v of vs) if (!firstOcc.has(v)) firstOcc.set(v, i);
  });
  rule.body.forEach((a, i) => {
    if (a.tag !== "Equal" || a.lhs.tag !== "Variable") return;
    const v = a.lhs.name;
    if (parseFresh(v) === null || firstOcc.get(v) !== i) return;
    const e = a.rhs;
    if (e.tag === "Variable" || e.tag === "Symbol") {
      if (!(e.tag === "Variable" && e.name === v)) ctx.subst.set(v, e);
      return;
    }
    if (e.tag !== "Max" && e.tag !== "Min") return;
    const unit = e.tag === "Max" ? "bot" : "top";
    const other = isSym(resolve(e.a, ctx), unit) ? e.b : isSym(resolve(e.b, ctx), unit) ? e.a : null;
    if (other !== null) ctx.subst.set(v, other);
  });
  // Dense renumbering, over the variables that still print.
  const vars = new Set<string>();
  for (const a of rule.body) for (const t of atomTerms(a)) collectVars(t, vars);
  const byFamily = new Map<string, { name: string; n: number }[]>();
  for (const name of vars) {
    const f = parseFresh(name);
    if (f === null || !DENSE_FAMILIES.has(f.prefix) || ctx.subst.has(name)) continue;
    const fam = byFamily.get(f.prefix) ?? [];
    fam.push({ name, n: f.n });
    byFamily.set(f.prefix, fam);
  }
  for (const fam of byFamily.values()) {
    fam.sort((x, y) => x.n - y.n);
    fam.forEach((v, i) => ctx.dense.set(v.name, i + 1));
  }
  // Counting pass: find chains worth aliasing.
  ctx.counts = new Map();
  for (const a of rule.body) line(a, ctx);
  let k = 0;
  for (const [text, n] of ctx.counts) {
    if (n > 1 && text.split(" ").length >= MIN_ALIAS_LEN) ctx.aliases.set(text, `κ${subscript(++k)}`);
  }
  ctx.counts = null;
  return ctx;
}

export function prettyRule(rule: Rule, opts: RenderOptions = {}): string {
  const ctx = buildCtx(rule);
  const flags: string[] = [];
  if (rule.deltaHead === null) flags.push("unindexed delta");
  if (rule.deltaHead !== undefined && !rule.deltaSafeSkip) flags.push("no-skip");
  const pad = opts.lines ? " ".repeat(lineTag(0).length + 1) : "";
  const tag = (l: number) => (opts.lines ? `${lineTag(l)} ` : "");
  const out = [`${tag(rule.span.line)}#def ${rule.name}${flags.length > 0 ? `  [${flags.join(", ")}]` : ""}`];
  const defined = new Set<string>();
  for (const a of rule.body) {
    ctx.used.clear();
    const text = line(a, ctx);
    if (text === null) continue;
    for (const c of ctx.used) {
      if (defined.has(c)) continue;
      defined.add(c);
      out.push(`  ${pad}${ctx.aliases.get(c)} := ${c}`);
    }
    out.push(`  ${tag(a.span.line)}${text}`);
  }
  return out.join("\n");
}

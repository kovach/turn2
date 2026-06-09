// DOM-free, Store-free debug renderer for the raw (un-hashconsed) v2 IR:
// `Term` / `RuleAtom` / `Rule` / `Program` as produced by `parse` and the
// `expand` sub-stages. The store-based renderers in `print.ts` only handle
// hashconsed terms reached through a `Store`; the pre-/post-expand IR carries
// plain `Term`s, so the CLI's `--stage` dumps need this.
//
// This is debug output: it is NOT guaranteed to round-trip through `parse`.
// `Id` literals (fresh-id templates) are rendered structurally with their
// values substituted in, so the expansion fingerprints are legible. The
// exponential-blowup guard from `print.ts` (keep `Id`s opaque) targets the
// *hashconsed* store, where an `Id`-backed `Ref` body can unfold into a huge
// moment tree; the raw-IR templates here are finite, and any stray `Ref`
// still renders as an opaque `*n` handle, so nothing unfolds unboundedly.

import type { Atom, Term } from "./term.js";
import type { Program, Rule, RuleAtom } from "./types.js";

export function renderTermRaw(term: Term): string {
  switch (term.tag) {
    case "Symbol": return term.name;
    case "Variable": return `?${term.name}`;
    case "Wildcard": return "_";
    case "Ref": return `*${term.id}`;
    // Id literals are fresh-id templates, e.g. `(*mom ruleName lexPos
    // (*chain ...vars) side)`. Render the body structurally with values
    // substituted in. This recurses through the term algebra, but `Ref`s
    // stay opaque (`*n` above) so no hashcons body is ever unfolded — the
    // raw-IR templates are finite, so there is no blowup. (`print.ts` keeps
    // its store-side ids opaque for the hashconsed exponential-blowup case;
    // that doesn't apply here.)
    case "Id":
    case "Atom":
      return `(${term.atom.terms.map(renderTermRaw).join(" ")})`;
  }
}

function renderAtomRaw(atom: Atom): string {
  return atom.terms.map(renderTermRaw).join(" ");
}

// One line per atom, tag-prefixed so the lowering is legible. `Match` shows
// its semi-naive constraint (`delta`/`old`/`any`) when present.
export function renderRuleAtom(atom: RuleAtom): string {
  switch (atom.tag) {
    case "Atom": {
      const w = atom.weight !== undefined ? ` -> ${renderTermRaw(atom.weight)}` : "";
      if (atom.marker === "constrain" && atom.subAtoms) {
        const subs = atom.subAtoms
          .map((s) => `${s.kind === "agg" ? "agg " : ""}${renderAtomRaw(s.atom)}`)
          .join(", ");
        return `Atom[constrain] !(${subs})`;
      }
      return `Atom[${atom.marker}] ${renderAtomRaw(atom.atom)}${w}`;
    }
    case "Sub": {
      const inner = atom.body.map(renderRuleAtom).join("; ");
      return `Sub${atom.sequence ? "(seq)" : ""} (${inner})`;
    }
    case "Equal":
      return `Equal ${renderTermRaw(atom.lhs)} = ${renderTermRaw(atom.rhs)}`;
    case "JsCall":
      return `JsCall ${renderTermRaw(atom.out)} = @js(${atom.func} ${atom.args.map(renderTermRaw).join(" ")})`;
    case "Match": {
      const c = atom.constraint ? `[${atom.constraint}]` : "";
      return `Match${c} ${renderAtomRaw(atom.atom)} @ (${renderTermRaw(atom.l)}, ${renderTermRaw(atom.r)})`;
    }
    case "Emit":
      return `Emit ${renderAtomRaw(atom.atom)} @ (${renderTermRaw(atom.l)}, ${renderTermRaw(atom.r)})`;
    case "Le":
      return `Le ${renderTermRaw(atom.a)} <= ${renderTermRaw(atom.b)}`;
    case "AssertLt":
      return `AssertLt ${renderTermRaw(atom.a)} < ${renderTermRaw(atom.b)}`;
    case "Max":
      return `Max ${renderTermRaw(atom.out)} = max(${renderTermRaw(atom.a)}, ${renderTermRaw(atom.b)})`;
    case "Min":
      return `Min ${renderTermRaw(atom.out)} = min(${renderTermRaw(atom.a)}, ${renderTermRaw(atom.b)})`;
  }
}

export interface RenderOptions {
  // Prefix every atom (and the `#def` header) with its source line, e.g.
  // `L12`. Useful for mapping expanded output back to source.
  lines?: boolean;
}

export function renderRule(rule: Rule, opts: RenderOptions = {}): string {
  const delta =
    rule.deltaHead !== undefined
      ? `  [delta-head: ${rule.deltaHead ?? "*"}${rule.deltaSafeSkip ? ", safe-skip" : ""}]`
      : "";
  const tag = opts.lines ? `${lineTag(rule.span.line)} ` : "";
  const header = `${tag}#def ${rule.name}${delta}`;
  const body = rule.body
    .map((a) => `  ${opts.lines ? `${lineTag(a.span.line)} ` : ""}${renderRuleAtom(a)}`)
    .join("\n");
  return body.length > 0 ? `${header}\n${body}` : header;
}

// Fixed-width source-line tag so atom text stays column-aligned.
function lineTag(line: number): string {
  return `L${line}`.padEnd(5);
}

export function renderProgram(program: Program, opts: RenderOptions = {}): string {
  const parts: string[] = [];
  for (const [relation, aggregator] of program.schema) {
    parts.push(`#agg ${relation} ${aggregator}`);
  }
  for (const def of program.jsDefs.values()) {
    parts.push(`#js (${def.name} ${def.params.join(" ")}) { ... }`);
  }
  if (parts.length > 0) parts.push("");
  parts.push(program.rules.map((r) => renderRule(r, opts)).join("\n\n"));
  return parts.join("\n");
}

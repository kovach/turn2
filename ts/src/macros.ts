import type { Term, Tree } from "./types.js";
import { sym, vari, aggregate, before } from "./types.js";

export interface MacroDef {
  expand: (args: Term[], children: Tree[], fresh: () => string) => Tree;
}

let macroCounter = 0;

export function resetMacroCounter(): void {
  macroCounter = 0;
}

const macros = new Map<string, MacroDef>([
  ["at", {
    expand: ([x, y], _children, fresh) => {
      const l = vari(fresh());
      return {
        id: vari(fresh()),
        literal: { literalType: aggregate({ funcName: "last", args: [l], out: y! }), atom: { terms: [] } },
        children: [{
          id: vari(fresh()),
          literal: { literalType: before(), atom: { terms: [sym("move"), x!, l] } },
          children: [],
        }],
      };
    },
  }],
]);

export function expandMacro(name: string, args: Term[], children: Tree[]): Tree | null {
  const def = macros.get(name);
  if (!def) return null;
  const fresh = () => `_m${macroCounter++}`;
  return def.expand(args, children, fresh);
}

export function expandMacros(tree: Tree): Tree {
  return { ...tree, children: expandChildren(tree.children) };
}

function expandChildren(children: Tree[]): Tree[] {
  const result: Tree[] = [];
  for (const child of children) {
    if (child.macroInvocation) {
      const { name, args } = child.macroInvocation;
      const expanded = expandMacro(name, args, []);
      if (!expanded) {
        throw new Error(`Unknown macro: @${name}`);
      }
      // Inherit span from macro invocation site
      result.push({ ...expanded, ...(child.span && { span: child.span }) });
      result.push(...expandChildren(child.children));
    } else {
      result.push({ ...child, children: expandChildren(child.children) });
    }
  }
  return result;
}

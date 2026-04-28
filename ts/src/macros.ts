import type { Term, Tree } from "./types.js";
import { sym, vari } from "./types.js";

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
        tag: "Aggregate",
        info: { funcName: "last", args: [l], out: y! },
        id: vari(fresh()),
        atom: { terms: [] },
        children: [{
          tag: "Before",
          constraint: "any",
          id: vari(fresh()),
          atom: { terms: [sym("move"), x!, l] },
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
  if (tree.tag === "Equal" || tree.tag === "Ask") return tree;
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
      if (child.tag !== "Equal" && child.tag !== "Ask") result.push(...expandChildren(child.children));
    } else if (child.tag === "Equal" || child.tag === "Ask") {
      result.push(child);
    } else {
      result.push({ ...child, children: expandChildren(child.children) });
    }
  }
  return result;
}

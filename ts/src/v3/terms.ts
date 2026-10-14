// Interned ground terms and the patterns rules match them with.
//
// A ground term is an integer `Id` into one `Terms` table: a symbol (numbers
// and string literals are symbols, as in v2), a compound `(a b …)`, a fresh
// object minted by an emit (`+card C` with `C` unbound), or a choice term
// minted by `?C`. Equal terms have equal ids, so equality is `===`, and a
// relation's rows can be indexed by id.

import type { Term } from "../v2/term.js";

export type Id = number;

export const SYM = 0;
export const APP = 1;
export const FRESH = 2;
export const CHOICE = 3;

export class Terms {
  readonly kind: number[] = [];
  readonly name: string[] = [];
  readonly args: (readonly Id[] | null)[] = [];
  private readonly syms = new Map<string, Id>();
  private readonly apps = new Map<string, Id>();
  private freshCount = 0;

  sym(name: string): Id {
    let id = this.syms.get(name);
    if (id === undefined) {
      id = this.push(SYM, name, null);
      this.syms.set(name, id);
    }
    return id;
  }

  app(args: readonly Id[]): Id {
    const key = args.join(",");
    let id = this.apps.get(key);
    if (id === undefined) {
      id = this.push(APP, "", args.slice());
      this.apps.set(key, id);
    }
    return id;
  }

  // A fresh object (`#C.12`): unique, never equal to anything built later.
  fresh(label: string): Id {
    return this.push(FRESH, `#${label}.${++this.freshCount}`, null);
  }

  choice(label: string): Id {
    return this.push(CHOICE, `?${label}.${++this.freshCount}`, null);
  }

  private push(kind: number, name: string, args: readonly Id[] | null): Id {
    this.kind.push(kind);
    this.name.push(name);
    this.args.push(args);
    return this.kind.length - 1;
  }

  isNum(id: Id): boolean {
    return this.kind[id] === SYM && /^-?\d+(\.\d+)?$/.test(this.name[id]!);
  }

  num(id: Id): number | null {
    return this.isNum(id) ? Number(this.name[id]) : null;
  }

  // Peano value of `z` / `(s …)`, or null.
  nat(id: Id): number | null {
    let n = 0;
    for (;;) {
      if (this.kind[id] === SYM) return this.name[id] === "z" ? n : null;
      const a = this.args[id];
      if (a === null || a === undefined || a.length !== 2 || this.name[a[0]!] !== "s" || this.kind[a[0]!] !== SYM) return null;
      n++;
      id = a[1]!;
    }
  }

  peano(n: number): Id {
    let id = this.sym("z");
    const s = this.sym("s");
    for (let i = 0; i < n; i++) id = this.app([s, id]);
    return id;
  }

  show(id: Id): string {
    const a = this.args[id];
    if (a === null || a === undefined) return this.name[id]!;
    return `(${a.map((x) => this.show(x)).join(" ")})`;
  }

  // Fresh or choice ids anywhere inside `id`.
  hasMinted(id: Id): boolean {
    const k = this.kind[id];
    if (k === FRESH || k === CHOICE) return true;
    const a = this.args[id];
    return a !== null && a !== undefined && a.some((x) => this.hasMinted(x));
  }
}

// ---------------------------------------------------------------- patterns

// A pattern over one rule's variable slots. `js` appears only in emitted
// terms (`@js(f a…)`, parsed as `(*js f a…)`), and is evaluated when built.
export type Pat =
  | { k: "c"; id: Id }
  | { k: "v"; slot: number }
  | { k: "w" }
  | { k: "a"; args: Pat[] }
  | { k: "js"; fn: string; args: Pat[] };

export const UNBOUND = -1;
export type Env = Id[];

// Variable name → slot, per rule (exception right-hand sides share their
// host rule's slots).
export class Slots {
  readonly names: string[] = [];
  private readonly map = new Map<string, number>();
  slot(name: string): number {
    let s = this.map.get(name);
    if (s === undefined) {
      s = this.names.length;
      this.names.push(name);
      this.map.set(name, s);
    }
    return s;
  }
  has(name: string): boolean {
    return this.map.has(name);
  }
  get size(): number {
    return this.names.length;
  }
}

export function compilePat(t: Term, terms: Terms, slots: Slots): Pat {
  switch (t.tag) {
    case "Symbol":
      return { k: "c", id: terms.sym(t.name) };
    case "Variable":
      return t.name === "_" ? { k: "w" } : { k: "v", slot: slots.slot(t.name) };
    case "Wildcard":
      return { k: "w" };
    case "Atom": {
      const ts = t.atom.terms;
      if (ts.length >= 2 && ts[0]!.tag === "Symbol" && ts[0]!.name === "*js" && ts[1]!.tag === "Symbol") {
        return { k: "js", fn: ts[1]!.name, args: ts.slice(2).map((x) => compilePat(x, terms, slots)) };
      }
      const args = ts.map((x) => compilePat(x, terms, slots));
      if (args.every((p) => p.k === "c")) return { k: "c", id: terms.app(args.map((p) => (p as { id: Id }).id)) };
      return { k: "a", args };
    }
    default:
      throw new Error(`v3: unsupported term in a rule: ${t.tag} (saved v2 choice rows are not v3 input)`);
  }
}

// Match ground `id` against `p`, binding into `env` (mutated; the caller
// copies first when it needs to backtrack).
export function matchPat(p: Pat, id: Id, env: Env, terms: Terms): boolean {
  switch (p.k) {
    case "c":
      return p.id === id;
    case "w":
      return true;
    case "v": {
      const cur = env[p.slot]!;
      if (cur === UNBOUND) {
        env[p.slot] = id;
        return true;
      }
      return cur === id;
    }
    case "a": {
      const a = terms.args[id];
      if (a === null || a === undefined || a.length !== p.args.length) return false;
      for (let i = 0; i < a.length; i++) if (!matchPat(p.args[i]!, a[i]!, env, terms)) return false;
      return true;
    }
    case "js":
      throw new Error("v3: @js(...) can only appear in an emitted term");
  }
}

export function matchArgs(ps: readonly Pat[], ids: readonly Id[], env: Env, terms: Terms): boolean {
  if (ps.length !== ids.length) return false;
  for (let i = 0; i < ps.length; i++) if (!matchPat(ps[i]!, ids[i]!, env, terms)) return false;
  return true;
}

// The ground value of `p` under `env`, or null when it has an unbound
// variable or wildcard. `js` calls go through `callJs`.
export function groundPat(
  p: Pat, env: Env, terms: Terms, callJs?: (fn: string, args: Id[]) => Id,
): Id | null {
  switch (p.k) {
    case "c":
      return p.id;
    case "w":
      return null;
    case "v":
      return env[p.slot] === UNBOUND ? null : env[p.slot]!;
    case "a": {
      const out: Id[] = [];
      for (const q of p.args) {
        const g = groundPat(q, env, terms, callJs);
        if (g === null) return null;
        out.push(g);
      }
      return terms.app(out);
    }
    case "js": {
      if (callJs === undefined) throw new Error("v3: @js(...) outside an emitted term");
      const out: Id[] = [];
      for (const q of p.args) {
        const g = groundPat(q, env, terms, callJs);
        if (g === null) return null;
        out.push(g);
      }
      return callJs(p.fn, out);
    }
  }
}

export function patSlots(p: Pat, out: Set<number>): Set<number> {
  if (p.k === "v") out.add(p.slot);
  else if (p.k === "a" || p.k === "js") for (const q of p.args) patSlots(q, out);
  return out;
}

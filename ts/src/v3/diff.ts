// Lockstep differential run: v2 (the oracle) and v3 on the same program,
// answering every choice the same way, comparing as they go
// (plans/v3-procedural.md step 9).
//
// Fresh objects have engine-specific names (v2: Skolem `*id` terms; v3:
// counters), so both sides are compared through *descriptors*: a fresh
// object is described by the facts that mention it (`piece:kind @ town`,
// `moved @ a3`, …), with other fresh objects in those facts shown as `#`.
// Choices are answered by descriptor too, so "the explorer in a5" is the
// same pick on both sides. `?[rng]` becomes `?` on both sides, so every
// choice goes through the same policy.
//
// Compared at each step: the facts (tuples that live to `top`), the
// options of each pending component, and every acc relation's rows at the
// component's moment (at `top` once both runs are done).

import { parse } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { compressRefs } from "../v2/print.js";
import { tokenOf, type Store } from "../v2/store.js";
import { refTagOf } from "../v2/hashcons.js";
import type { Term } from "../v2/term.js";
import type { ComponentOptions, Program } from "../v2/types.js";
import { CHOICE, FRESH, type Id } from "./terms.js";
import { Runtime, type Component } from "./runtime.js";

export interface DiffOptions {
  steps: number;
  pick?: "first" | "random";
  seed?: number;
  gas?: number; // v2 iteration gas
  tupleGas?: number;
  log?: ((line: string) => void) | undefined;
}

export interface DiffResult {
  ok: boolean;
  steps: number;
  status: string;
  mismatches: string[];
  v2ms: number;
  v3ms: number;
  source2: string; // the v2 program with every answer appended as `^ is` rows
  answers3: { comp: number; option: number }[]; // the same game for a fresh v3 run
}

// Drop saved v2 choice rows (rule blocks that emit `^ is`) and make every
// rng choice an ordinary one.
export function prepareSource(src: string): string {
  const blocks: string[][] = [];
  for (const line of src.split("\n")) {
    if (blocks.length === 0 || (/^\S/.test(line) && !line.startsWith("--"))) blocks.push([line]);
    else blocks[blocks.length - 1]!.push(line);
  }
  return blocks
    .filter((b) => !b.some((l) => /^\s*\^\s*is\s/.test(l)))
    .map((b) => b.join("\n"))
    .join("\n")
    .replace(/\?\[rng\]/g, "?");
}

// ---------------------------------------------------------------- views

interface Side {
  facts: string[]; // abstracted, sorted
  desc: (x: unknown) => string; // abstracted rendering of one value
}

function describe(facts: { rel: string; args: unknown[] }[], isFresh: (x: unknown) => boolean, key: (x: unknown) => string, show: (x: unknown, f: (y: unknown) => string) => string): Side {
  const mentions = new Map<string, string[]>();
  const plain = (x: unknown) => show(x, (y) => (isFresh(y) ? "#" : ""));
  for (const f of facts) {
    const fr = new Set<string>();
    const walk = (x: unknown) => {
      if (isFresh(x)) fr.add(key(x));
    };
    f.args.forEach(walk);
    for (const k of fr) {
      const line = [f.rel, ...f.args.map((a) => (isFresh(a) && key(a) === k ? "@" : plain(a)))].join(" ");
      if (!mentions.has(k)) mentions.set(k, []);
      mentions.get(k)!.push(line);
    }
  }
  const descOf = (x: unknown) => `#{${(mentions.get(key(x)) ?? []).sort().join("; ")}}`;
  const desc = (x: unknown) => show(x, (y) => (isFresh(y) ? descOf(y) : ""));
  return { facts: facts.map((f) => [f.rel, ...f.args.map(desc)].join(" ")).sort(), desc };
}

function v2Side(store: Store, program: Program): Side {
  const topTok = tokenOf(store, store.top);
  const facts: { rel: string; args: unknown[] }[] = [];
  for (const t of store.tuples) {
    if (tokenOf(store, t.r) !== topTok) continue;
    const h = t.atom.terms[0];
    if (h === undefined || h.tag !== "Symbol") continue;
    if (h.name.startsWith("_") || h.name === "is" || program.accDecls.has(h.name)) continue;
    facts.push({ rel: h.name, args: t.atom.terms.slice(1, t.atom.terms.length - 1) });
  }
  const expand = (t: unknown): Term => {
    const term = t as Term;
    if (term.tag === "Ref") {
      const a = store.hash.refToAtom.get(term.id)!;
      return { tag: refTagOf(store.hash, term.id), atom: a } as Term;
    }
    return term;
  };
  const isFresh = (x: unknown) => expand(x).tag === "Id";
  const key = (x: unknown) => String(tokenOf(store, x as Term));
  const show = (x: unknown, f: (y: unknown) => string): string => {
    if (isFresh(x)) return f(x);
    const t = expand(x);
    if (t.tag === "Symbol") return t.name;
    if (t.tag === "Atom") return `(${t.atom.terms.map((y) => show(y, f)).join(" ")})`;
    return "?";
  };
  return describe(facts, isFresh, key, show);
}

function v3Side(rt: Runtime): Side {
  const facts: { rel: string; args: unknown[] }[] = [];
  const all = [...rt.tables.values()].flatMap((t) => t.tuples).sort((a, b) => a.seq - b.seq);
  for (const t of all) {
    if (t.r !== rt.mom.top || t.rel === "is") continue;
    facts.push({ rel: t.rel, args: t.args });
  }
  const terms = rt.terms;
  const isFresh = (x: unknown) => terms.kind[x as Id] === FRESH || terms.kind[x as Id] === CHOICE;
  const key = (x: unknown) => String(x);
  const show = (x: unknown, f: (y: unknown) => string): string => {
    if (isFresh(x)) return f(x);
    const a = terms.args[x as Id];
    if (a === null || a === undefined) return terms.name[x as Id]!;
    return `(${a.map((y) => show(y, f)).join(" ")})`;
  };
  return describe(facts, isFresh, key, show);
}

function multisetDiff(a: string[], b: string[], label: string, max = 6): string[] {
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  for (const x of b) count.set(x, (count.get(x) ?? 0) - 1);
  const out: string[] = [];
  for (const [x, n] of count) {
    if (n > 0) out.push(`${label}: only v2 (${n}x): ${x}`);
    else if (n < 0) out.push(`${label}: only v3 (${-n}x): ${x}`);
  }
  return out.slice(0, max).concat(out.length > max ? [`${label}: … ${out.length - max} more`] : []);
}

// ---------------------------------------------------------------- driver

export function diffRun(source: string, opts: DiffOptions): DiffResult {
  const log = opts.log ?? (() => {});
  let src = prepareSource(source);
  const program3 = parse(src);
  if ("message" in program3) throw new Error(`parse: ${program3.message}`);
  const rt = new Runtime(program3, { tupleGas: opts.tupleGas ?? 50_000 });
  let rand = (opts.seed ?? 1) >>> 0;
  const random = () => {
    rand = (rand + 0x6d2b79f5) >>> 0;
    let t = rand;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const mismatches: string[] = [];
  let v2ms = 0;
  let v3ms = 0;
  let step = 0;
  let status = "";
  const answers3: { comp: number; option: number }[] = [];
  for (; step <= opts.steps; step++) {
    let t0 = performance.now();
    const program2 = parse(src);
    if ("message" in program2) throw new Error(`parse: ${program2.message}`);
    const r2 = runFixpoint(program2, opts.gas ?? 20000, opts.tupleGas ?? 50_000);
    v2ms += performance.now() - t0;
    t0 = performance.now();
    const s3 = rt.run();
    v3ms += performance.now() - t0;

    const k2 = r2.status.kind === "active-choices" ? "choices" : r2.status.kind;
    status = `v2 ${k2}, v3 ${s3.kind}${s3.kind === "error" ? ` (${s3.message})` : ""}`;
    if (k2 === "gas" && s3.kind === "gas") break; // both ran away; cut-offs differ
    const side2 = v2Side(r2.store, program2);
    const side3 = v3Side(rt);
    const factDiff = multisetDiff(side2.facts, side3.facts, `step ${step} facts`);
    mismatches.push(...factDiff);
    if (k2 !== s3.kind) {
      mismatches.push(`step ${step}: status ${status}`);
      break;
    }
    if (k2 !== "choices" || s3.kind !== "choices") {
      // both done: compare acc at top
      if (r2.accAt !== undefined) mismatches.push(...compareAcc(r2, side2, rt, side3, tokenOf(r2.store, r2.store.top), rt.mom.top, step));
      break;
    }
    const comps2 = (r2.status as { components: ComponentOptions[] }).components;
    const comps3 = s3.components;
    const sig2 = comps2.map((c) => c.options.map((o) => o.map(side2.desc).join(" ")).sort());
    const sig3 = comps3.map((c) => c.options.map((o) => o.map(side3.desc).join(" ")).sort());
    const keys2 = sig2.map((s) => s.join(" | "));
    const keys3 = sig3.map((s) => s.join(" | "));
    const shared = keys2.filter((k) => keys3.includes(k)).sort();
    for (const k of keys2) if (!keys3.includes(k)) mismatches.push(`step ${step}: v2-only component: ${k.slice(0, 300)}`);
    for (const k of keys3) if (!keys2.includes(k)) mismatches.push(`step ${step}: v3-only component: ${k.slice(0, 300)}`);
    if (shared.length === 0) break;
    const key = shared[0]!;
    // Components with the same options (two pushes of identical pieces)
    // are told apart by their acc rows at their moments.
    const cands2 = comps2.filter((_, i) => keys2[i] === key);
    const cands3 = comps3.filter((_, i) => keys3[i] === key);
    let c2 = cands2[0]!;
    let c3: Component = cands3[0]!;
    let accDiff: string[] | null = null;
    for (const a of cands2) {
      for (const b of cands3) {
        const d = r2.accAt !== undefined ? compareAcc(r2, side2, rt, side3, tokenOf(r2.store, a.moment), b.moment, step) : [];
        if (accDiff === null || d.length < accDiff.length) { accDiff = d; c2 = a; c3 = b; }
        if (d.length === 0) break;
      }
      if (accDiff !== null && accDiff.length === 0) break;
    }
    mismatches.push(...(accDiff ?? []));
    if (factDiff.length > 0 || mismatches.length > 0) break;
    if (step === opts.steps) break;

    const options = sig3[keys3.indexOf(key)]!;
    const chosen = opts.pick === "random" ? options[Math.floor(random() * options.length)]! : options[0]!;
    const o2 = c2.options.find((o) => o.map(side2.desc).join(" ") === chosen)!;
    const o3 = c3.options.find((o) => o.map(side3.desc).join(" ") === chosen)!;
    log(`step ${step}: ${c3.choices.map((c) => c.label).join(" ")} (${options.length} options) -> ${chosen.slice(0, 120)}`);
    answers3.push({ comp: comps3.indexOf(c3), option: c3.options.indexOf(o3) });
    rt.answer(c3, o3);
    const roots = [...c2.activeTerms, ...o2];
    const { bindings, results } = compressRefs(roots, r2.store);
    const n = c2.activeTerms.length;
    const lines = [...bindings];
    for (let i = 0; i < n; i++) lines.push(`^ is ${results[i]} ${results[i + n]}`);
    src = src + "\n\n" + lines.map((l, i) => (i === 0 ? l : "  " + l)).join("\n") + "\n";
  }
  return { ok: mismatches.length === 0, steps: step, status, mismatches, v2ms, v3ms, source2: src, answers3 };
}

function compareAcc(
  r2: ReturnType<typeof runFixpoint>, side2: Side, rt: Runtime, side3: Side, tok2: number, m3: import("./moments.js").Moment, step: number,
): string[] {
  const rows2 = r2.accAt!(tok2);
  if (rows2 === undefined) return [`step ${step}: v2 has no acc rows at the moment`];
  const a: string[] = [];
  const b: string[] = [];
  for (const rel of rt.an.acc) {
    for (const row of rows2.get(rel) ?? []) a.push([rel, ...row.terms.map(side2.desc)].join(" "));
    for (const row of rt.acc.rowsAt(rel, m3)) b.push([rel, ...row.args.map(side3.desc)].join(" "));
  }
  return multisetDiff(a.sort(), b.sort(), `step ${step} acc`);
}

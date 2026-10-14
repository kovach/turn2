// v3 in the web editor (src/web-v2.ts): run a program with the answers saved
// in its source, and present the result in v2's shapes (a `Store`, a
// `FixpointStatus`, `accAt`), so the page's timeline, database view,
// choices strip and display modules work unchanged.
//
// Answers are saved as comment lines, so the source still parses as Turn:
//
//   --@ C@24 (cell z z)
//   --@ W@65 *17 | To@65 (cell (s z) z)
//
// one line per click, one `label@line value` per choice it answers (the `?`
// variable and its source line; a joint component can be answered a slot
// at a time). On a run they are replayed in order: each goes to the first
// pending component that has choices with those labels and an option with
// those values there (printed form), and answers just those choices;
// replay stops at the first line that does not fit, leaving it and the
// rest unused. v3 is deterministic,
// so a fresh object's printed name (`#P.17`) is stable while the program
// and earlier answers are; rng choices use a fixed default seed.

import type { Atom, Span, Term } from "../v2/term.js";
import type { BlockedChoose, ComponentOptions, FixpointStatus, Program, Rule } from "../v2/types.js";
import type { AccRow as V2AccRow } from "../v2/eval.js";
import type { RngCommit } from "../v2/scheduler.js";
import { addOrder, addTuple, createStore, intern, internAtom, tokenOf, type Store } from "../v2/store.js";
import { Runtime, type Choice, type Component, type Status } from "./runtime.js";
import type { Moment } from "./moments.js";
import { APP, SYM, type Id } from "./terms.js";

export const ANSWER_PREFIX = "--@ ";

export interface SavedAnswer {
  line: number; // 1-based source line
  picks: { label: string; value: string }[];
}

export function parseAnswers(source: string): SavedAnswer[] {
  const out: SavedAnswer[] = [];
  source.split("\n").forEach((text, i) => {
    if (!text.startsWith(ANSWER_PREFIX)) return;
    const picks = text.slice(ANSWER_PREFIX.length).split(" | ").map((p) => {
      const t = p.trim();
      const sp = t.indexOf(" ");
      return sp < 0 ? { label: t, value: "" } : { label: t.slice(0, sp), value: t.slice(sp + 1).trim() };
    });
    out.push({ line: i + 1, picks });
  });
  return out;
}

export function choiceLabel(c: Choice): string {
  return `${c.label}@${c.line}`;
}

export interface V3EditorResult {
  store: Store;
  status: FixpointStatus;
  iterations: number;
  rules: Rule[];
  rngCommits: RngCommit[];
  accAt: (tok: number, relations?: readonly string[]) => Map<string, V2AccRow[]> | undefined;
  error?: string;
  replayed: number; // saved answers used
  unused: SavedAnswer[]; // saved answers that did not fit (from the first misfit on)
  tuples: number;
  // The answer line for a click on a component's option (v2 terms).
  answerText(activeTerms: Term[], option: Term[]): string | null;
  rt: Runtime;
}

export function runV3(program: Program, source: string, opts: { tupleGas?: number } = {}): V3EditorResult {
  const rt = new Runtime(program, { tupleGas: opts.tupleGas ?? 1_000_000, defaultSeed: 1 });
  const answers = parseAnswers(source);
  let status: Status = rt.run();
  let replayed = 0;
  for (const ans of answers) {
    if (status.kind !== "choices") break;
    const hit = findAnswer(rt, status.components, ans);
    if (hit === null) break;
    hit.forEach(([c, v]) => rt.resolve(c, v));
    replayed++;
    status = rt.run();
  }
  return present(rt, status, replayed, answers.slice(replayed));
}

function findAnswer(rt: Runtime, comps: Component[], ans: SavedAnswer): [Choice, Id][] | null {
  for (const comp of comps) {
    const idx = ans.picks.map((p) => comp.choices.findIndex((c) => choiceLabel(c) === p.label));
    if (idx.some((i) => i < 0)) continue;
    const option = comp.options.find((o) => ans.picks.every((p, j) => rt.terms.show(o[idx[j]!]!) === p.value));
    if (option !== undefined) return idx.map((i) => [comp.choices[i]!, option[i]!]);
  }
  return null;
}

// ---------------------------------------------------------------- to v2 shapes

function present(rt: Runtime, s: Status, replayed: number, unused: SavedAnswer[]): V3EditorResult {
  const store = createStore();
  store.tupleGas = 0;
  const terms = rt.terms;
  const sym = (name: string): Term => ({ tag: "Symbol", name });

  // terms: symbols and compounds as themselves; fresh objects and choice
  // terms as Id terms shaped like v2's templates, `(*id rule pos (*chain
  // name) :Var)`, which the page reads for chip labels (they print `*N`)
  const termCache = new Map<Id, Term>();
  const back = new Map<number, Id>(); // v2 token -> v3 id
  const termOf = (id: Id): Term => {
    let t = termCache.get(id);
    if (t !== undefined) return t;
    const k = terms.kind[id];
    if (k === SYM) t = sym(terms.name[id]!);
    else if (k === APP) t = { tag: "Atom", atom: { terms: terms.args[id]!.map(termOf) } };
    else {
      const c = rt.choiceOf.get(id);
      const name = terms.name[id]!;
      const v = name.slice(1, name.lastIndexOf("."));
      t = { tag: "Id", atom: { terms: [
        sym("*id"), sym(c?.rule || "v3"), sym(String(c?.line ?? 0)),
        { tag: "Id", atom: { terms: [sym("*chain"), sym(name)] } }, sym(`:${v}`),
      ] } };
    }
    t = intern(store, t);
    termCache.set(id, t);
    back.set(tokenOf(store, t), id);
    return t;
  };

  // moments, and the order edges v3 created them with
  const momTerm = new Map<Moment, Term>();
  const momByTok = new Map<number, Moment>();
  const mt = (m: Moment): Term => {
    let t = momTerm.get(m);
    if (t !== undefined) return t;
    t = m === rt.mom.bot ? store.bot : m === rt.mom.top ? store.top
      : intern(store, { tag: "Id", atom: { terms: [sym("*m"), sym(String(m.id))] } });
    momTerm.set(m, t);
    momByTok.set(tokenOf(store, t), m);
    return t;
  };
  mt(rt.mom.bot);
  mt(rt.mom.top);
  for (const m of rt.mom.all) {
    if (m.pred === null || m.succ === null) continue;
    addOrder(store, mt(m.pred), mt(m));
    addOrder(store, mt(m), mt(m.succ));
  }

  // tuples, in emission order, with a trailing id slot as v2 stores them
  const all = [...rt.tables.values()].flatMap((t) => t.tuples).sort((a, b) => a.seq - b.seq);
  for (const t of all) {
    const atom: Atom = { terms: [sym(t.rel), ...t.args.map(termOf), { tag: "Id", atom: { terms: [sym("*t"), sym(String(t.seq))] } }] };
    addTuple(store, internAtom(store, atom), mt(t.l), mt(t.r), t.span as Span | undefined);
  }

  // A moment is settled once nothing below it can change: no unanswered
  // choice below it (at the end of a run, everything).
  const open = rt.choices.filter((c) => c.value === null && !c.dead);
  const settledAt = (m: Moment) => !open.some((c) => rt.mom.lt(c.moment, m));
  for (const [tok, m] of momByTok) {
    if (settledAt(m)) {
      store.settled.add(tok);
      store.resolved.add(tok);
    }
  }

  // #acc: the relations, the rows v3 computed (as v2's point rows), and
  // where rules read them
  const readByRules = new Set<string>();
  for (const [a, info] of rt.an.matches) if (info.kind === "acc" || info.kind === "not") readByRules.add(head(a.atom));
  for (const rel of rt.an.acc) store.accRelations.set(rel, { readByRules: readByRules.has(rel) });
  const rowAtom = (rel: string, args: Id[], m: Moment): Atom => ({
    terms: [sym(rel), ...args.map(termOf), { tag: "Id", atom: { terms: [sym("*acc"), sym(rel), ...args.map(termOf), mt(m)] } }],
  });
  for (const [m, rels] of [...rt.acc.computed()]) {
    const tok = tokenOf(store, mt(m));
    let comp = store.accComputed.get(tok);
    if (comp === undefined) store.accComputed.set(tok, (comp = new Set()));
    for (const [rel, rows] of rels) {
      comp.add(rel);
      for (const row of rows) addTuple(store, internAtom(store, rowAtom(rel, row.args, m)), mt(m), mt(m));
    }
  }
  for (const [rel, ms] of rt.accConsulted) {
    store.accConsulted.set(rel, new Set([...ms].map((m) => tokenOf(store, mt(m)))));
  }

  const accAt = (tok: number, relations?: readonly string[]): Map<string, V2AccRow[]> | undefined => {
    const m = momByTok.get(tok);
    if (m === undefined || !settledAt(m)) return undefined;
    const out = new Map<string, V2AccRow[]>();
    for (const rel of relations ?? [...rt.an.acc]) {
      if (!rt.an.acc.has(rel)) continue;
      out.set(rel, rt.acc.rowsAt(rel, m).map((r) => ({ terms: r.args.map(termOf), moment: mt(r.moment) })));
    }
    return out;
  };

  // status
  let status: FixpointStatus = { kind: "done" };
  let error: string | undefined;
  const comps: Component[] = s.kind === "choices" ? s.components : [];
  if (s.kind === "gas") status = { kind: "gas", iterations: 0, tuples: s.tuples };
  else if (s.kind === "error") error = s.message;
  else if (s.kind === "choices") {
    const components: ComponentOptions[] = comps.map((c) => ({
      activeTerms: c.choices.map((x) => termOf(x.term)),
      actors: c.choices.map((x) => (x.actor === "rng" ? "rng" : "you")),
      options: c.options.map((o) => o.map(termOf)),
      moment: mt(c.moment),
    }));
    const choices: BlockedChoose[] = comps.flatMap((c) => c.choices.map((x) => ({
      rowIndex: -1,
      chooseId: termOf(x.term),
      wrappedAtom: { terms: [termOf(x.term)] },
      actor: x.actor === "rng" ? "rng" as const : "you" as const,
      activeTerms: [termOf(x.term)],
      l: mt(x.moment),
      r: mt(x.moment),
    })));
    status = { kind: "active-choices", choices, components };
  }

  const answerText = (activeTerms: Term[], option: Term[]): string | null => {
    const chosen = activeTerms.map((t) => {
      const id = back.get(tokenOf(store, t));
      return id === undefined ? undefined : rt.choiceOf.get(id);
    });
    const vals = option.map((t) => back.get(tokenOf(store, t)));
    if (chosen.some((c) => c === undefined) || vals.some((v) => v === undefined)) return null;
    return ANSWER_PREFIX + chosen.map((c, i) => `${choiceLabel(c!)} ${terms.show(vals[i]!)}`).join(" | ");
  };

  const result: V3EditorResult = {
    store, status, iterations: 0, rules: [], rngCommits: [], accAt,
    replayed, unused, tuples: rt.tuplesStored, answerText, rt,
  };
  if (error !== undefined) result.error = error;
  return result;
}

function head(a: Atom): string {
  const h = a.terms[0];
  return h !== undefined && h.tag === "Symbol" ? h.name : "?";
}

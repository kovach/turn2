// Text output for v3 runs: tuples, acc rows, pending choices, the analysis
// report.

import type { AccRow } from "./query.js";
import type { Component, Runtime, Tuple } from "./runtime.js";
import { report } from "./analyze.js";

export function showTuple(rt: Runtime, t: { rel: string; args: readonly number[] }): string {
  return [t.rel, ...t.args.map((a) => rt.terms.show(a))].join(" ");
}

export function showRow(rt: Runtime, rel: string, r: AccRow): string {
  return [rel, ...r.args.map((a) => rt.terms.show(a))].join(" ");
}

// Every stored tuple, with its kind: `+` (lives to top), `~` (an episode),
// `^` (a view).
export function dumpTuples(rt: Runtime, opts: { facts?: boolean; episodes?: boolean; views?: boolean } = {}): string[] {
  const all: Tuple[] = [];
  for (const t of rt.tables.values()) all.push(...t.tuples);
  all.sort((a, b) => a.seq - b.seq);
  const out: string[] = [];
  for (const t of all) {
    const kind = t.frame !== null ? "~" : t.r === rt.mom.top ? "+" : "^";
    if (kind === "+" && opts.facts === false) continue;
    if (kind === "~" && opts.episodes === false) continue;
    if (kind === "^" && opts.views === false) continue;
    out.push(`${kind} ${showTuple(rt, t)}`);
  }
  return out;
}

export function dumpAcc(rt: Runtime, m = rt.mom.top): string[] {
  const out: string[] = [];
  for (const rel of [...rt.an.acc].sort()) {
    for (const r of rt.acc.rowsAt(rel, m)) out.push(showRow(rt, rel, r));
  }
  return out;
}

export function showComponent(rt: Runtime, c: Component): string {
  const names = c.choices.map((x) => `${x.label}${x.actor === "you" ? "" : `[${x.actor}]`}`).join(" ");
  const opts = c.options.map((o) => o.map((v) => rt.terms.show(v)).join(" "));
  return `? ${names}  (${opts.length} options: ${opts.slice(0, 12).join(" | ")}${opts.length > 12 ? " | …" : ""})`;
}

export function showReport(rt: Runtime): string[] {
  const out: string[] = [];
  let proc = 0;
  let subs = 0;
  const reps = report(rt.program, rt.an);
  for (const r of reps) {
    if (r.procedural) proc++;
    subs += r.kinds.filter((k) => k.kind === "subscribe").length;
    const ks = r.kinds.map((k) => `${k.rel}:${k.kind}`).join(" ");
    out.push(`L${r.rule.span.line} ${r.procedural ? "procedural" : "reactive  "} ${ks}`);
  }
  out.push(`${proc}/${reps.length} rules procedural; ${subs} subscribing matches`);
  return out;
}

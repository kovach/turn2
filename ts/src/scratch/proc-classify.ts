// Static classifier: which Turn rules are "episode-triggered procedures"?
// usage (from ts/): node --import tsx src/scratch/proc-classify.ts file.t... [--verbose]
import { readFileSync } from "node:fs";
import { parse } from "../v2/parse.js";
import type { RuleAtom, Program } from "../v2/types.js";
import type { Atom } from "../v2/term.js";

const verbose = process.argv.includes("--verbose");
const files = process.argv.slice(2).filter((f) => !f.startsWith("--"));

const head = (a: Atom) => (a.terms[0]?.tag === "Symbol" ? (a.terms[0] as any).name : "?");
type A = Extract<RuleAtom, { tag: "Atom" }>;

// events a rule body produces, in order, with scope info
type Ev =
  | { k: "match"; rel: string; paren: boolean; after: boolean; negated: boolean; scope: string | null }
  | { k: "emit"; rel: string; marker: string; after: boolean; scope: string | null };

function walk(body: RuleAtom[], scope0: string | null, paren: boolean, out: Ev[], isEp: (r: string) => boolean): string | null {
  let scope = scope0;
  for (const a of body) {
    if (a.tag === "Sub") {
      // a single-match paren group reads without narrowing
      const single = a.body.length === 1 && a.body[0]!.tag === "Atom" && (a.body[0] as A).marker === "match";
      const inner = walk(a.body, scope, paren || single, out, isEp);
      if (!a.sequence) scope = inner; // `;` returns to the enclosing window
      continue;
    }
    if (a.tag === "Exception") { out.push({ k: "emit", rel: "{exception}", marker: "exception", after: false, scope }); continue; }
    if (a.tag !== "Atom") continue;
    if (a.marker === "match") {
      const rel = head(a.atom);
      out.push({ k: "match", rel, paren, after: !!a.after, negated: !!a.negated, scope });
      if (!paren && !a.after && !a.negated && isEp(rel)) scope = rel;
    } else if (a.marker === "constrain") {
      out.push({ k: "emit", rel: "!", marker: "constrain", after: false, scope });
    } else {
      const rel = head(a.atom);
      out.push({ k: "emit", rel, marker: a.marker, after: !!a.after, scope });
      if (a.marker === "episode" && !a.after) scope = rel;
    }
  }
  return scope;
}

type Row = { file: string; rule: string; line: number; cls: string; detail: string[] };
const rows: Row[] = [];
const guardShape: string[] = [];
const handlersPer = new Map<string, number>();
const accRows: { file: string; rel: string; op: string; reads: string[]; cls: string }[] = [];

for (const file of files) {
  const prog = parse(readFileSync(file, "utf8")) as Program | { message: string };
  if (!("rules" in prog)) { console.error(file, "parse error", (prog as any).message); continue; }
  const markers = new Map<string, Set<string>>();
  const note = (rel: string, m: string) => { if (!markers.has(rel)) markers.set(rel, new Set()); markers.get(rel)!.add(m); };
  const collect = (b: RuleAtom[]) => { for (const a of b) { if (a.tag === "Sub") collect(a.body); else if (a.tag === "Atom" && a.marker !== "match" && a.marker !== "constrain") note(head(a.atom), a.marker); else if (a.tag === "Exception") collect(a.right); } };
  for (const r of prog.rules) collect(r.body);
  const acc = new Set(prog.accDecls.keys());
  const js = new Set(prog.jsRels.keys());
  const isEp = (r: string) => { const m = markers.get(r); return !!m && m.size === 1 && m.has("episode"); };

  const evs = prog.rules.map((r) => { const out: Ev[] = []; walk(r.body, null, false, out, isEp); return out; });
  // spawn graph: scope -> spawned episode; emits per scope
  const spawn = new Map<string, Set<string>>();
  const emittedIn = new Map<string, Set<string>>(); // rel -> scopes it is emitted within
  for (const ev of evs.flat()) {
    if (ev.k !== "emit") continue;
    const s = ev.scope ?? "<top>";
    if (ev.marker === "episode") { if (!spawn.has(s)) spawn.set(s, new Set()); spawn.get(s)!.add(ev.rel); }
    if (!emittedIn.has(ev.rel)) emittedIn.set(ev.rel, new Set()); emittedIn.get(ev.rel)!.add(s);
  }
  const reach = (from: string) => { const seen = new Set([from]); const st = [from]; while (st.length) { const x = st.pop()!; for (const y of spawn.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); } } return seen; };
  const desc = new Map<string, Set<string>>();
  const D = (e: string) => { if (!desc.has(e)) desc.set(e, reach(e)); return desc.get(e)!; };

  prog.rules.forEach((r, i) => {
    const ev = evs[i]!;
    const matches = ev.filter((e): e is Extract<Ev, { k: "match" }> => e.k === "match");
    const line = r.span.line;
    const detail: string[] = [];
    if (matches.length === 0) { rows.push({ file, rule: r.name, line, cls: "no-trigger (top-level)", detail }); return; }
    // the trigger: the deepest narrowing episode match (descendant of the other episode matches)
    const epMatches = matches.filter((m) => !m.paren && !m.after && isEp(m.rel));
    let trigger: string | null = null;
    for (const m of epMatches) if (!trigger || D(trigger).has(m.rel)) trigger = m.rel;
    if (!trigger) {
      rows.push({ file, rule: r.name, line, cls: "not-episode-triggered", detail: [`first=${matches[0]!.rel} [${[...(markers.get(matches[0]!.rel) ?? ["acc/js?"])].join("")}]`] });
      return;
    }
    const chainOk = epMatches.every((m) => m.rel === trigger || D(m.rel).has(trigger!));
    let cls = chainOk ? "procedural" : "multi-episode-join";
    const ancestors = new Set(epMatches.map((m) => m.rel).filter((x) => x !== trigger));
    const within = D(trigger);
    for (const m of matches) {
      if (m.rel === trigger && !m.paren) continue;
      let kind: string;
      if (acc.has(m.rel)) kind = m.negated ? "not-acc" : "acc-read";
      else if (js.has(m.rel) || ["lt", "gt", "le", "ge"].includes(m.rel)) kind = "js";
      else if (m.rel === "is") kind = "await-choice";
      else if (ancestors.has(m.rel)) kind = "ancestor";
      else {
        const scopes = emittedIn.get(m.rel) ?? new Set();
        const conc = [...scopes].some((s) => within.has(s));
        if (isEp(m.rel) && m.after) kind = "after-episode";
        else if (conc) kind = isEp(m.rel) ? "concurrent-episode" : "concurrent-tuple";
        else kind = "past/context";
        if (conc && cls === "procedural") cls = "reactive-join";
      }
      detail.push(`${m.paren ? "(" : ""}${m.rel}${m.paren ? ")" : ""}:${kind}`);
    }
    const firstEmit = ev.findIndex((e) => e.k === "emit");
    const lateReads = firstEmit < 0 ? [] : ev.slice(firstEmit).filter((e) => e.k === "match" && e.rel !== "is" && !js.has(e.rel) && !["lt","gt","le","ge"].includes(e.rel));
    if (cls === "procedural") { guardShape.push(lateReads.length ? "reads-after-emit" : "guard-then-body"); if (lateReads.length && verbose) console.log("   late:", file.split("/").pop(), line, lateReads.map((e: any) => e.rel).join(",")); }
    rows.push({ file, rule: r.name, line, cls, detail: [`trigger=${trigger}`, ...detail] });
  });

  for (const ar of prog.accRules) {
    const rel = head(ar.head);
    const d = prog.accDecls.get(rel)!;
    const op = d.aggIndex === null ? "bool" : (d.columns[d.aggIndex] as any).op;
    const reads: string[] = [];
    const g = (b: RuleAtom[]) => { for (const a of b) { if (a.tag === "Sub") g(a.body); else if (a.tag === "Atom") { const h = head(a.atom); reads.push(acc.has(h) ? `acc:${h}` : js.has(h) ? `js:${h}` : `${[...(markers.get(h) ?? ["?"])].map((x) => ({ fact: "+", anchor: "^", episode: "~" } as any)[x] ?? x).join("")}${h}`); } } };
    g(ar.body);
    const stored = reads.filter((x) => !x.startsWith("acc:") && !x.startsWith("js:"));
    const scoped = stored.some((x) => x.startsWith("~") || x.startsWith("^"));
    const cls = (reads.some((x) => x === `acc:${rel}`) ? "recursive " : "") + (scoped ? "scoped-inputs" : stored.length ? "fact-only-inputs" : "derived-only");
    accRows.push({ file, rel, op, reads, cls });
  }
}

const tally = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const byFile = new Map<string, Row[]>();
for (const r of rows) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file)!.push(r); }
for (const [f, rs] of byFile) {
  console.log(`\n${f.split("/").slice(-2).join("/")}: ${rs.length} rules  ` + tally(rs.map((r) => r.cls)).map(([k, n]) => `${k}=${n}`).join("  "));
  if (verbose) for (const r of rs) console.log(`  L${r.line} ${r.cls.padEnd(22)} ${r.detail.join(" ")}`);
}
console.log("\nTOTAL", rows.length, tally(rows.map((r) => r.cls)).map(([k, n]) => `${k}=${n}`).join("  "));
console.log("match kinds:", tally(rows.flatMap((r) => r.detail.filter((d) => !d.startsWith("trigger") && !d.startsWith("first")).map((d) => d.split(":").pop()!))).map(([k, n]) => `${k}=${n}`).join("  "));
console.log("procedural handler shape:", tally(guardShape).map(([k, n]) => `${k}=${n}`).join("  "));
console.log("\nACC rules", accRows.length, tally(accRows.map((a) => `${a.op}/${a.cls}`)).map(([k, n]) => `${k}=${n}`).join("  "));
if (verbose) for (const a of accRows) console.log(`  ${a.file.split("/").pop()} ${a.rel} @${a.op} ${a.cls}: ${a.reads.join(", ")}`);

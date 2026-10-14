// `#acc` relations, computed at the moment they are read.
//
// The rows at `m` are a fold over the contributions of the acc rules whose
// bodies hold at `m` (query.ts point reads). v3 never has to wait before
// computing them: a continuation only reads at its own moment, and by then
// everything at or below that moment has executed (plans/v3-procedural.md),
// so the rows are final when first computed and are cached per moment.
// Strata, recursion and the ops follow v2 (acc.ts, acc-ops.ts).

import type { AccDecl, AccRule, Program, RuleAtom } from "../v2/types.js";
import type { MomentOrder, Moment } from "./moments.js";
import { solve, type AccRow, type PointSource, type QAtom } from "./query.js";
import { compilePat, groundPat, Slots, UNBOUND, type Id, type Pat, type Terms } from "./terms.js";
import { headOf } from "./analyze.js";

interface CompiledAccRule {
  rule: AccRule;
  head: string;
  slots: number;
  body: QAtom[];
  cols: Pat[]; // head columns (key columns and the agg column)
}

interface Contribution {
  key: Id[];
  value: Id | null;
  moment: Moment;
}

const ROUND_CAP = 1000;

export class AccEngine {
  private readonly rules = new Map<string, CompiledAccRule[]>();
  private readonly stratumOf = new Map<string, string[]>();
  private readonly recursive = new Set<string>();
  private readonly cache = new Map<Moment, Map<string, AccRow[]>>();
  // While a stratum is being computed: its current rows.
  private local: Map<string, AccRow[]> | null = null;
  private localMoment: Moment | null = null;

  constructor(
    program: Program,
    private readonly terms: Terms,
    private readonly mom: MomentOrder,
    private readonly src: Omit<PointSource, "rows">,
  ) {
    const decls = program.accDecls;
    const reads = new Map<string, Set<string>>();
    for (const r of program.accRules) {
      const slots = new Slots();
      const body = r.body.map((a) => compileBodyAtom(a, decls, program, terms, slots));
      const head = headOf(r.head);
      const cols = r.head.terms.slice(1).map((t) => compilePat(t, terms, slots));
      const c: CompiledAccRule = { rule: r, head, slots: slots.size, body, cols };
      if (!this.rules.has(head)) this.rules.set(head, []);
      this.rules.get(head)!.push(c);
      let rs = reads.get(head);
      if (rs === undefined) reads.set(head, (rs = new Set()));
      for (const a of body) if (a.k === "acc" || a.k === "not") rs.add(a.rel);
    }
    // Tarjan's SCCs over read dependencies.
    let index = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const on = new Set<string>();
    const strong = (v: string) => {
      idx.set(v, index);
      low.set(v, index++);
      stack.push(v);
      on.add(v);
      for (const w of reads.get(v) ?? []) {
        if (!idx.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          on.delete(w);
          comp.push(w);
        } while (w !== v);
        for (const x of comp) this.stratumOf.set(x, comp);
        if (comp.length > 1 || reads.get(v)?.has(v)) for (const x of comp) this.recursive.add(x);
      }
    };
    for (const rel of decls.keys()) if (!idx.has(rel)) strong(rel);
    // stratified negation
    for (const [h, rules] of this.rules) {
      for (const r of rules) for (const a of r.body) {
        if (a.k === "not" && this.stratumOf.get(a.rel) === this.stratumOf.get(h)) {
          throw new Error(`v3: acc relation '${h}' negates '${a.rel}' inside its own recursion`);
        }
      }
    }
    this.decls = decls;
  }

  private readonly decls: Map<string, AccDecl>;

  // The rows computed so far, by moment (displays).
  computed(): Iterable<[Moment, Map<string, AccRow[]>]> {
    return this.cache.entries();
  }

  rowsAt(rel: string, m: Moment): AccRow[] {
    if (this.local !== null && this.localMoment === m && this.local.has(rel)) return this.local.get(rel)!;
    let at = this.cache.get(m);
    if (at === undefined) this.cache.set(m, (at = new Map()));
    const hit = at.get(rel);
    if (hit !== undefined) return hit;
    const stratum = this.stratumOf.get(rel);
    if (stratum === undefined) throw new Error(`v3: '${rel}' is not an acc relation`);
    this.computeStratum(stratum, m, at);
    return at.get(rel)!;
  }

  private computeStratum(stratum: string[], m: Moment, at: Map<string, AccRow[]>): void {
    const contribs = new Map<string, Map<string, Contribution>>();
    for (const rel of stratum) contribs.set(rel, new Map());
    const rows = new Map<string, AccRow[]>();
    const recursive = this.recursive.has(stratum[0]!);
    const saved = { local: this.local, localMoment: this.localMoment };
    const source: PointSource = { ...this.src, rows: (r, mm) => this.rowsAt(r, mm) };
    try {
      for (let round = 0; ; round++) {
        if (round > ROUND_CAP) throw new Error(`v3: acc stratum {${stratum.join(", ")}} did not converge`);
        for (const rel of stratum) rows.set(rel, this.fold(rel, [...contribs.get(rel)!.values()], m));
        if (recursive) {
          this.local = rows;
          this.localMoment = m;
        }
        let added = false;
        for (const rel of stratum) {
          for (const r of this.rules.get(rel) ?? []) {
            const env: Id[] = new Array(r.slots).fill(UNBOUND);
            solve(r.body, env, m, source, (e, trace) => {
              const cols = r.cols.map((p) => groundPat(p, e, this.terms));
              if (cols.some((c) => c === null)) throw new Error(`v3: acc rule for '${rel}' leaves a head variable unbound`);
              const decl = this.decls.get(rel)!;
              const key: Id[] = [];
              let value: Id | null = null;
              cols.forEach((c, i) => { if (i === decl.aggIndex) value = c; else key.push(c!); });
              const moment = this.mom.lub(trace.moments, m);
              const sig = `${key.join(",")}|${value}|${moment.id}|${trace.ids.join(",")}`;
              const bucket = contribs.get(rel)!;
              if (!bucket.has(sig)) {
                bucket.set(sig, { key, value, moment });
                added = true;
              }
            });
          }
        }
        if (!added) break;
        if (!recursive) {
          for (const rel of stratum) rows.set(rel, this.fold(rel, [...contribs.get(rel)!.values()], m));
          break;
        }
      }
    } finally {
      this.local = saved.local;
      this.localMoment = saved.localMoment;
    }
    for (const rel of stratum) at.set(rel, rows.get(rel)!);
  }

  private fold(rel: string, contribs: Contribution[], m: Moment): AccRow[] {
    const decl = this.decls.get(rel)!;
    const aggCol = decl.aggIndex === null ? null : decl.columns[decl.aggIndex]!;
    const op = aggCol !== null && aggCol.kind === "agg" ? aggCol.op : "bool";
    const groups = new Map<string, { key: Id[]; items: Contribution[] }>();
    for (const c of contribs) {
      const sig = c.key.join(",");
      let g = groups.get(sig);
      if (g === undefined) groups.set(sig, (g = { key: c.key, items: [] }));
      g.items.push(c);
    }
    if (groups.size === 0 && decl.columns.length === (aggCol === null ? 0 : 1)) groups.set("", { key: [], items: [] });
    const out: AccRow[] = [];
    const t = this.terms;
    for (const g of groups.values()) {
      const groupMoment = this.mom.lub(g.items.map((c) => c.moment), m);
      const emit = (value: Id | null, moment: Moment) => {
        const args: Id[] = [];
        let ki = 0;
        for (let i = 0; i < decl.columns.length; i++) args.push(i === decl.aggIndex ? value! : g.key[ki++]!);
        out.push({ args, moment, key: `${rel}(${args.join(",")})` });
      };
      switch (op) {
        case "bool":
          if (g.items.length > 0) emit(null, groupMoment);
          break;
        case "sum": {
          let n = 0;
          for (const c of g.items) {
            const v = c.value === null ? null : t.num(c.value);
            if (v === null || !Number.isInteger(v)) throw new Error(`acc '${rel}': @sum expects a numeric symbol, got '${c.value === null ? "()" : t.show(c.value)}'`);
            n += v;
          }
          emit(t.sym(String(n)), groupMoment);
          break;
        }
        case "count":
          emit(t.peano(g.items.length), groupMoment);
          break;
        case "min": {
          let best: Contribution[] = [];
          let bestN = Infinity;
          for (const c of g.items) {
            const n = t.nat(c.value!);
            if (n === null) throw new Error(`acc '${rel}': @min expects a Peano nat, got '${t.show(c.value!)}'`);
            if (n < bestN) { bestN = n; best = [c]; } else if (n === bestN) best.push(c);
          }
          if (best.length > 0) emit(best[0]!.value, this.mom.lub(best.map((c) => c.moment), this.mom.bot));
          break;
        }
        case "last": {
          const seen = new Set<string>();
          const uniq = g.items.filter((c) => {
            const k = `${c.moment.id}|${c.value}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          for (const c of uniq) {
            if (uniq.some((d) => d !== c && this.mom.le(c.moment, d.moment) && !this.mom.le(d.moment, c.moment))) continue;
            emit(c.value, c.moment);
          }
          break;
        }
        case "arg-min": {
          let bestN = Infinity;
          const byA = new Map<Id, { pair: Id; moments: Moment[] }>();
          for (const c of g.items) {
            const a = t.args[c.value!];
            const n = a !== null && a !== undefined && a.length === 3 && t.name[a[0]!] === "pair" ? t.nat(a[2]!) : null;
            if (n === null) throw new Error(`acc '${rel}': @arg-min expects a (pair A N) with N a Peano nat`);
            if (n < bestN) { bestN = n; byA.clear(); }
            if (n === bestN) {
              const cur = byA.get(a![1]!);
              if (cur === undefined) byA.set(a![1]!, { pair: c.value!, moments: [c.moment] });
              else cur.moments.push(c.moment);
            }
          }
          for (const e of byA.values()) emit(e.pair, this.mom.lub(e.moments, this.mom.bot));
          break;
        }
        default:
          throw new Error(`v3: unknown acc op '${op}'`);
      }
    }
    return out;
  }
}

function compileBodyAtom(
  a: RuleAtom, decls: Map<string, AccDecl>, program: Program, terms: Terms, slots: Slots,
): QAtom {
  if (a.tag === "Equal") {
    if (a.rhs.tag === "Max" || a.rhs.tag === "Min" || a.rhs.tag === "JsCall") throw new Error("v3: computed '=' in an acc rule");
    return { k: "eq", lhs: compilePat(a.lhs, terms, slots), rhs: compilePat(a.rhs, terms, slots) };
  }
  if (a.tag !== "Atom" || a.marker !== "match") throw new Error("v3: acc rule bodies hold matches and '=' only");
  const rel = headOf(a.atom);
  const pats = a.atom.terms.slice(1).map((t) => compilePat(t, terms, slots));
  if (decls.has(rel)) return { k: a.negated ? "not" : "acc", rel, pats };
  if (a.negated) throw new Error(`v3: 'not ${rel}': not reads only #acc relations`);
  if (program.jsRels.has(rel)) return { k: "js", rel, pats };
  return { k: "rel", rel, pats };
}

// Diagnostic counters for v2 fixpoint runs. Counters are unconditional
// integer adds (cheap); only `wallMs` requires `performance.now()` and is
// gated by `enabled`. See plans/v2-stats-tracker.md.

export interface RuleStats {
  ruleIdx: number;
  name: string;
  invocations: number;
  skipped: number;
  firings: number;
  tuplesEmitted: number;
  tuplesDeduped: number;
  wallMs: number;
  candScanned: number;
  candPassedGen: number;
  candPassedOverlap: number;
  candPassedLiteral: number;
  candPassedUnify: number;
}

export interface HeadStats {
  head: string;
  scanCount: number;
  bucketSize: number;
  peakBucketSize: number;
}

export interface IterStats {
  iter: number;
  tuplesAdded: number;
  dupes: number;
  rulesRan: number;
  rulesSkipped: number;
}

// Per body position, for every rule evaluated (ordinary and acc rules alike,
// keyed by the atom object, so acc rules — which run with ruleIdx -1 — are
// counted too). Only collected when `enabled`. `entries` is how often
// evaluation reached the atom, i.e. the bindings that survived everything
// before it. Match / AccMatch sites also count their candidate funnel:
// `scanned` (what the index returned, below the snapshot bound) →
// `passedGen` (semi-naive delta/old filter) → `passedEnds` (endpoints
// unify) → `passedUnify` (args unify: what an exact index on the bound
// args would have returned). Bindings that then die in later filters
// (`Le` overlap / alive-at checks, `=`) show as the drop from
// `passedUnify` to the `entries` of the next generating atom.
export interface SiteStats {
  rule: string;
  pos: number;
  // Source line of the atom (0 for generated atoms).
  line: number;
  body: readonly { tag: string }[];
  tag: string;
  head: string;
  entries: number;
  scanned: number;
  passedGen: number;
  passedEnds: number;
  passedUnify: number;
  // Entries whose left endpoint was ground (the byHeadL index applied).
  lBound: number;
  // Bound-argument pattern per entry, `+` ground / `-` not (args after the
  // head), e.g. `+-` for `at P L` with P bound.
  masks: Map<string, number>;
}

export interface StatsTracker {
  enabled: boolean;
  rules: RuleStats[];
  heads: Map<string, HeadStats>;
  iterations: IterStats[];
  sites: Map<object, SiteStats>;
  // Times a rule's body ran to its end, by rule name.
  completions: Map<string, number>;
  // Set when the cost profile is on (`CostProfile` below).
  cost: CostProfile | undefined;
}

export function createTracker(enabled: boolean): StatsTracker {
  return { enabled, rules: [], heads: new Map(), iterations: [], sites: new Map(), completions: new Map(), cost: undefined };
}

export function siteFor(
  tr: StatsTracker, body: readonly { tag: string; span?: { line: number } }[], pos: number, rule: string, head: string,
): SiteStats {
  const atom = body[pos]!;
  let st = tr.sites.get(atom);
  if (st === undefined) {
    st = {
      rule, pos, line: atom.span?.line ?? 0, body, tag: atom.tag, head,
      entries: 0, scanned: 0, passedGen: 0, passedEnds: 0, passedUnify: 0, lBound: 0, masks: new Map(),
    };
    tr.sites.set(atom, st);
  }
  return st;
}

const GENERATORS = new Set(["Match", "AccMatch", "JsIterate", "Emit", "AccContribute"]);

// Bindings out of a Match / AccMatch site that reach the next generating
// atom (or the end of the body).
export function siteSurvivors(tr: StatsTracker, st: SiteStats): number {
  for (let j = st.pos + 1; j < st.body.length; j++) {
    if (GENERATORS.has(st.body[j]!.tag)) return tr.sites.get(st.body[j]!)?.entries ?? 0;
  }
  return tr.completions.get(st.rule) ?? 0;
}

// Join-site report: totals, then the top sites by candidates scanned.
// `idx-waste` = scanned − passedUnify (avoidable by indexing the bound
// args); `tmp-waste` = passedUnify − survivors (avoidable only by a
// temporal / interval index or by moving the filter into the scan).
export function formatJoinReport(tr: StatsTracker, n = 20): string {
  const gens = [...tr.sites.values()].filter((s) => s.tag === "Match" || s.tag === "AccMatch");
  const surv = new Map(gens.map((s) => [s, siteSurvivors(tr, s)]));
  const sum = (f: (s: SiteStats) => number): number => gens.reduce((a, s) => a + f(s), 0);
  const scanned = sum((s) => s.scanned);
  const unified = sum((s) => s.passedUnify);
  const survived = sum((s) => surv.get(s)!);
  const pct = (a: number, b: number): string => (b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}%`);
  const out: string[] = [];
  out.push(`Join sites: ${gens.length}; entries ${sum((s) => s.entries)}; scanned ${scanned}`
    + `; args unified ${unified} (${pct(unified, scanned)})`
    + `; survived later filters ${survived} (${pct(survived, scanned)} of scanned)`);
  out.push(`  idx-waste ${scanned - unified} (${pct(scanned - unified, scanned)})`
    + `, tmp-waste ${unified - survived} (${pct(unified - survived, scanned)})`);
  out.push("");
  out.push("  " + ["rule:line", "pos", "kind", "head", "entries", "scanned", "/entry", "unify", "survive", "l-idx", "top masks"]
    .map((h, i) => (i < 4 ? h.padEnd([22, 4, 8, 18][i]!) : h.padStart([9, 10, 8, 8, 8, 6][i - 4] ?? 0))).join(" "));
  for (const s of [...gens].sort((a, b) => b.scanned - a.scanned).slice(0, n)) {
    const masks = [...s.masks].sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([m, c]) => `${m || "()"}:${pct(c, s.entries)}`).join(" ");
    out.push("  " + [
      `${s.rule}:${s.line}`.slice(0, 22).padEnd(22), String(s.pos).padEnd(4), s.tag.padEnd(8), s.head.slice(0, 18).padEnd(18),
      String(s.entries).padStart(9), String(s.scanned).padStart(10),
      (s.entries === 0 ? "-" : (s.scanned / s.entries).toFixed(1)).padStart(8),
      pct(s.passedUnify, s.scanned).padStart(8), pct(surv.get(s)!, s.scanned).padStart(8),
      pct(s.lBound, s.entries).padStart(6), " " + masks,
    ].join(" "));
  }
  return out.join("\n");
}

export function attachRules(tr: StatsTracker, names: readonly string[]): void {
  tr.rules = names.map((name, ruleIdx) => emptyRuleStats(ruleIdx, name));
}

export function emptyRuleStats(ruleIdx: number, name: string): RuleStats {
  return {
    ruleIdx, name,
    invocations: 0, skipped: 0, firings: 0,
    tuplesEmitted: 0, tuplesDeduped: 0, wallMs: 0,
    candScanned: 0, candPassedGen: 0, candPassedOverlap: 0,
    candPassedLiteral: 0, candPassedUnify: 0,
  };
}

export function getOrCreateHead(tr: StatsTracker, head: string): HeadStats {
  let h = tr.heads.get(head);
  if (h === undefined) {
    h = { head, scanCount: 0, bucketSize: 0, peakBucketSize: 0 };
    tr.heads.set(head, h);
  }
  return h;
}

export function topRules(
  tr: StatsTracker,
  by: keyof Omit<RuleStats, "ruleIdx" | "name">,
  n: number,
): RuleStats[] {
  return [...tr.rules]
    .filter((r) => (r[by] as number) > 0)
    .sort((a, b) => (b[by] as number) - (a[by] as number))
    .slice(0, n);
}

export function topHeads(
  tr: StatsTracker,
  by: keyof Omit<HeadStats, "head">,
  n: number,
): HeadStats[] {
  return [...tr.heads.values()]
    .filter((h) => (h[by] as number) > 0)
    .sort((a, b) => (b[by] as number) - (a[by] as number))
    .slice(0, n);
}

const RULE_COLS: { key: keyof RuleStats; label: string; width: number }[] = [
  { key: "name",            label: "rule",     width: 28 },
  { key: "invocations",     label: "inv",      width: 8 },
  { key: "skipped",         label: "skip",     width: 7 },
  { key: "firings",         label: "fire",     width: 8 },
  { key: "tuplesEmitted",   label: "emit",     width: 7 },
  { key: "tuplesDeduped",   label: "dup",      width: 6 },
  { key: "candScanned",     label: "scan",     width: 9 },
  { key: "candPassedUnify", label: "unify",    width: 8 },
  { key: "wallMs",          label: "ms",       width: 8 },
];

function fmtCell(v: unknown, w: number): string {
  if (typeof v === "number") {
    const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
    return s.padStart(w);
  }
  return String(v).padEnd(w);
}

function ruleRow(r: RuleStats): string {
  return RULE_COLS.map((c) => fmtCell(r[c.key], c.width)).join(" ");
}

function ruleHeader(): string {
  return RULE_COLS.map((c) =>
    typeof c.key === "string" && c.key === "name"
      ? c.label.padEnd(c.width)
      : c.label.padStart(c.width),
  ).join(" ");
}

export function formatReport(tr: StatsTracker, n = 10): string {
  const out: string[] = [];

  out.push(`Top rules by wallMs (top ${n}):`);
  out.push("  " + ruleHeader());
  for (const r of topRules(tr, "wallMs", n)) out.push("  " + ruleRow(r));

  out.push("");
  out.push(`Top rules by candScanned (top ${n}):`);
  out.push("  " + ruleHeader());
  for (const r of topRules(tr, "candScanned", n)) out.push("  " + ruleRow(r));

  out.push("");
  out.push(`Top rules by tuplesEmitted (top ${n}):`);
  out.push("  " + ruleHeader());
  for (const r of topRules(tr, "tuplesEmitted", n)) out.push("  " + ruleRow(r));

  out.push("");
  out.push(`Top heads by scanCount (top ${n}):`);
  out.push("  head".padEnd(28) + "  " + "scan".padStart(10) + "  " + "bucket".padStart(8) + "  " + "peak".padStart(8));
  for (const h of topHeads(tr, "scanCount", n)) {
    out.push(
      "  " + h.head.padEnd(28)
      + "  " + String(h.scanCount).padStart(10)
      + "  " + String(h.bucketSize).padStart(8)
      + "  " + String(h.peakBucketSize).padStart(8)
    );
  }

  out.push("");
  out.push("Per-iteration:");
  out.push("  " + "iter".padStart(4) + "  " + "added".padStart(7) + "  " + "dup".padStart(6)
    + "  " + "ran".padStart(5) + "  " + "skip".padStart(6));
  for (const it of tr.iterations) {
    out.push("  " + String(it.iter).padStart(4)
      + "  " + String(it.tuplesAdded).padStart(7)
      + "  " + String(it.dupes).padStart(6)
      + "  " + String(it.rulesRan).padStart(5)
      + "  " + String(it.rulesSkipped).padStart(6));
  }

  // Funnel breakdown for the top-3 by scan.
  out.push("");
  out.push("Candidate funnel (top 3 by scan):");
  for (const r of topRules(tr, "candScanned", 3)) {
    out.push(`  ${r.name}:`);
    out.push(`    scan=${r.candScanned}`
      + ` → gen=${r.candPassedGen}`
      + ` → overlap=${r.candPassedOverlap}`
      + ` → lit=${r.candPassedLiteral}`
      + ` → unify=${r.candPassedUnify}`
      + ` → fire=${r.firings}`
      + ` (emit=${r.tuplesEmitted}, dup=${r.tuplesDeduped})`);
  }

  return out.join("\n");
}

// Cost profile (`--rule-profile`): wall time and work per source rule, so a
// run's cost can be read against the program text. Frames nest — an acc
// computation demanded inside a rule's match, a rule evaluated inside an acc
// computation — and each frame's `selfMs` excludes its children, so the
// entries sum to the whole run. Rules are keyed by source line: delta
// variants and the rules a pass derives from one source rule share it.
// Non-rule frames (`engine`, acc folds, moment handlers) are keyed by name
// with line 0. Separate from `enabled` (join stats), whose per-atom
// bookkeeping would swamp the times.
export interface CostEntry {
  key: string;
  kind: "rule" | "acc" | "engine";
  line: number;
  name: string;
  selfMs: number;
  calls: number;
  // Times the rule body ran to its end (firings, before dedup).
  completions: number;
  // New tuples added while this frame was innermost.
  added: number;
}

export interface CostFrame {
  entry: CostEntry;
  t0: number;
  childMs: number;
  parent: CostFrame | undefined;
}

export interface CostProfile {
  entries: Map<string, CostEntry>;
  cur: CostFrame | undefined;
}

export function costEnter(p: CostProfile, kind: CostEntry["kind"], line: number, name: string): CostFrame {
  const key = line > 0 ? `${kind}:${line}` : `${kind}:${name}`;
  let entry = p.entries.get(key);
  if (entry === undefined) {
    entry = { key, kind, line, name, selfMs: 0, calls: 0, completions: 0, added: 0 };
    p.entries.set(key, entry);
  }
  entry.calls++;
  const f: CostFrame = { entry, t0: performance.now(), childMs: 0, parent: p.cur };
  p.cur = f;
  return f;
}

export function costExit(p: CostProfile, f: CostFrame): void {
  const ms = performance.now() - f.t0;
  f.entry.selfMs += ms - f.childMs;
  if (f.parent !== undefined) f.parent.childMs += ms;
  p.cur = f.parent;
}

// `f` as its own (non-rule) frame, when the profile is on.
export function inFrame<T>(p: CostProfile | undefined, name: string, f: () => T): T {
  if (p === undefined) return f();
  const frame = costEnter(p, "engine", 0, name);
  const out = f();
  costExit(p, frame);
  return out;
}

// Top entries by self time. `source` (the program text) adds each rule's
// first line.
export function formatCostReport(p: CostProfile, source?: string, n = 40): string {
  const lines = source?.split("\n");
  const all = [...p.entries.values()];
  const total = all.reduce((a, e) => a + e.selfMs, 0);
  const pct = (ms: number): string => `${((100 * ms) / total).toFixed(1)}%`;
  const out: string[] = [];
  const byKind = (k: CostEntry["kind"]): number => all.filter((e) => e.kind === k).reduce((a, e) => a + e.selfMs, 0);
  out.push(`Cost profile: ${total.toFixed(1)} ms; rules ${pct(byKind("rule"))}, acc rules ${pct(byKind("acc"))}`
    + `, engine ${pct(byKind("engine"))}`);
  out.push("");
  out.push("  " + ["self ms", "%", "cum %", "calls", "fires", "added"].map((h) => h.padStart(8)).join("")
    + "  " + "where".padEnd(16) + "source");
  let cum = 0;
  for (const e of all.sort((a, b) => b.selfMs - a.selfMs).slice(0, n)) {
    cum += e.selfMs;
    const where = e.line > 0 ? `${e.kind === "acc" ? "acc " : ""}line ${e.line}` : e.kind;
    const text = e.line > 0 ? (lines?.[e.line - 1]?.trim() ?? e.name) : e.name;
    out.push("  " + [
      e.selfMs.toFixed(1), pct(e.selfMs), pct(cum), String(e.calls),
      e.kind === "engine" ? "" : String(e.completions), String(e.added),
    ].map((s) => s.padStart(8)).join("") + "  " + where.padEnd(16) + text.slice(0, 70));
  }
  return out.join("\n");
}

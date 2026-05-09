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

export interface StatsTracker {
  enabled: boolean;
  rules: RuleStats[];
  heads: Map<string, HeadStats>;
  iterations: IterStats[];
}

export function createTracker(enabled: boolean): StatsTracker {
  return { enabled, rules: [], heads: new Map(), iterations: [] };
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

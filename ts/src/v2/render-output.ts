import type { Term } from "./term.js";
import { refTagOf } from "./hashcons.js";
import { renderTermShallow } from "./print.js";
import { lessThan, type Store } from "./store.js";
import { renderTimeline } from "./timeline.js";

export interface TuplesOptions {
  hideInternal?: boolean;
  temporal?: boolean;
}

export interface TimelineOptions {
  hideInternal?: boolean;
  momentStyle?: "spine" | "edges";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTermDb(store: Store, term: Term): string {
  switch (term.tag) {
    case "Symbol":   return `<span class="sym">${escapeHtml(term.name)}</span>`;
    case "Variable": return `<span class="var">?${escapeHtml(term.name)}</span>`;
    case "Wildcard": return `<span class="sym">_</span>`;
    case "Ref": {
      if (refTagOf(store.hash, term.id) === "Id") {
        return `<span class="ref">*${term.id}</span>`;
      }
      const stored = store.hash.refToAtom.get(term.id);
      if (stored === undefined) return `<span class="ref">*${term.id}</span>`;
      return `(${stored.terms.map((t) => renderTermDb(store, t)).join(" ")})`;
    }
    case "Id":   return `<span class="ref">*${term.atom.terms[0]?.tag === "Symbol" ? term.atom.terms[0].name : "id"}</span>`;
    case "Atom": return `(${term.atom.terms.map((t) => renderTermDb(store, t)).join(" ")})`;
  }
}

function renderEndpoint(store: Store, term: Term): string {
  if (term.tag === "Ref") return `*${term.id}`;
  return renderTermShallow(store, term);
}

function renderTupleRow(store: Store, i: number): { atom: string; interval: string; line: number | undefined } {
  const t = store.tuples[i]!;
  const head = t.atom.terms[0];
  const headStr = head !== undefined && head.tag === "Symbol"
    ? `<span class="pred">${escapeHtml(head.name)}</span>`
    : renderTermDb(store, head!);
  const args = t.atom.terms.slice(1, -1).map((x) => renderTermDb(store, x)).join(" ");
  const atomStr = args === "" ? headStr : `${headStr} ${args}`;
  const intervalStr = `[${renderEndpoint(store, t.l)}, ${renderEndpoint(store, t.r)}]`;
  return { atom: atomStr, interval: intervalStr, line: store.tupleSource[i]?.line };
}

function emitRows(
  lines: string[],
  rendered: { atom: string; interval: string; line: number | undefined }[],
): void {
  let maxAtomLen = 0;
  for (const r of rendered) {
    const plain = r.atom.replace(/<[^>]+>/g, "");
    if (plain.length > maxAtomLen) maxAtomLen = plain.length;
  }
  const pad = Math.min(maxAtomLen, 48);
  for (const r of rendered) {
    const plainLen = r.atom.replace(/<[^>]+>/g, "").length;
    const gap = " ".repeat(Math.max(2, pad - plainLen + 2));
    const attr = r.line !== undefined ? ` data-source-line="${r.line}"` : "";
    lines.push(`  <span class="row"${attr}>${r.atom}${gap}<span class="interval">${escapeHtml(r.interval)}</span></span>`);
  }
}

function temporalOrder(store: Store, idxs: number[]): number[] {
  const n = idxs.length;
  const depth = new Array<number>(n).fill(0);
  const preds: number[][] = [];
  for (let k = 0; k < n; k++) preds.push([]);
  for (let i = 0; i < n; i++) {
    const ti = store.tuples[idxs[i]!]!;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const tj = store.tuples[idxs[j]!]!;
      if (lessThan(store, ti.r, tj.l)) preds[j]!.push(i);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < n; k++) {
      let d = 0;
      for (const p of preds[k]!) {
        if (depth[p]! + 1 > d) d = depth[p]! + 1;
      }
      if (d !== depth[k]) { depth[k] = d; changed = true; }
    }
  }
  const order = idxs.map((_, k) => k);
  order.sort((a, b) => depth[a]! - depth[b]! || idxs[a]! - idxs[b]!);
  return order.map((k) => idxs[k]!);
}

export function renderTuples(host: HTMLElement, store: Store, opts: TuplesOptions = {}): void {
  const hide = opts.hideInternal ?? true;
  const temporal = !!opts.temporal;

  const visible: number[] = [];
  for (let i = 0; i < store.tuples.length; i++) {
    const head = store.tuples[i]!.atom.terms[0];
    const name = head !== undefined && head.tag === "Symbol" ? head.name : "(other)";
    if (hide && name.startsWith("_")) continue;
    visible.push(i);
  }

  if (visible.length === 0) {
    host.innerHTML = `<span style="color:#666">(empty)</span>`;
    return;
  }

  const lines: string[] = [];
  if (temporal) {
    const ordered = temporalOrder(store, visible);
    const rendered = ordered.map((i) => renderTupleRow(store, i));
    emitRows(lines, rendered);
  } else {
    const groups = new Map<string, number[]>();
    for (const i of visible) {
      const head = store.tuples[i]!.atom.terms[0];
      const name = head !== undefined && head.tag === "Symbol" ? head.name : "(other)";
      let bucket = groups.get(name);
      if (bucket === undefined) { bucket = []; groups.set(name, bucket); }
      bucket.push(i);
    }
    const userKeys: string[] = [];
    const internalKeys: string[] = [];
    for (const k of groups.keys()) {
      if (k.startsWith("_")) internalKeys.push(k);
      else userKeys.push(k);
    }
    userKeys.sort();
    internalKeys.sort();
    const orderedKeys = [...userKeys, ...internalKeys];
    for (const key of orderedKeys) {
      const idxs = groups.get(key)!;
      lines.push(`<span class="group-heading">${escapeHtml(key)} (${idxs.length})</span>`);
      const rendered = idxs.map((i) => renderTupleRow(store, i));
      emitRows(lines, rendered);
    }
  }
  host.innerHTML = lines.join("\n");
}

export function renderTimelineH(host: HTMLElement, store: Store, opts: TimelineOptions = {}): void {
  const out = renderTimeline(store, { hideInternal: opts.hideInternal ?? true, orientation: "horizontal", laneMode: "tree", momentStyle: opts.momentStyle ?? "edges" });
  host.replaceChildren(out.main);
}

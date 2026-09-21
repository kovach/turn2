import { spanKey, type Span, type Term } from "./term.js";
import { refTagOf } from "./hashcons.js";
import { atomFingerprint, renderTermShallow } from "./print.js";
import { lessThan, tokenOf, type Store } from "./store.js";
import { renderTimeline, type CollapsedInterval } from "./timeline.js";
import { accRelationVisible, accSnapshot } from "./acc-view.js";

export interface TuplesOptions {
  hideInternal?: boolean;
  temporal?: boolean;
}

export interface TimelineOptions {
  hideInternal?: boolean;
  momentStyle?: "spine" | "edges";
  // Episodes (by `timelineCollapseKey`) whose intervals render collapsed.
  collapsedKeys?: Iterable<string>;
  // `#acc` relations forced shown / hidden; see TimelineOpts.accOverrides.
  accOverrides?: ReadonlyMap<string, boolean>;
  // Render the acc controls around the timeline: a strip of per-relation
  // toggles above it (`data-acc-toggle`) and, when `inspectKey` names a
  // moment of this store (`momentKey`), the moment inspector below it
  // (`data-acc-inspector-close`). The host owns the state and the events;
  // moment dots carry `data-tl-moment`. Off by default (pres embeds get the
  // bare timeline).
  accControls?: boolean;
  inspectKey?: string | null;
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

function renderTupleRow(store: Store, i: number): { atom: string; interval: string; span: Span | undefined; index: number } {
  const t = store.tuples[i]!;
  const head = t.atom.terms[0];
  const headStr = head !== undefined && head.tag === "Symbol"
    ? `<span class="pred">${escapeHtml(head.name)}</span>`
    : renderTermDb(store, head!);
  const args = t.atom.terms.slice(1, -1).map((x) => renderTermDb(store, x)).join(" ");
  const atomStr = args === "" ? headStr : `${headStr} ${args}`;
  const intervalStr = `[${renderEndpoint(store, t.l)}, ${renderEndpoint(store, t.r)}]`;
  return { atom: atomStr, interval: intervalStr, span: store.tupleSource[i], index: i };
}

function emitRows(
  lines: string[],
  rendered: { atom: string; interval: string; span: Span | undefined; index: number }[],
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
    const key = spanKey(r.span);
    // `data-tl-tuple` (same attribute the timeline stamps) lets the source
    // link recover the tuple for live-value notes.
    const attr = (key !== undefined ? ` data-source-span="${key}"` : "") + ` data-tl-tuple="${r.index}"`;
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

// Collapse keys identify an episode across re-evaluations of the program —
// including the ones triggered by appending an `is` row for a click — so a
// collapsed interval stays collapsed. Moment tokens and hashcons ids can't do
// that (they shift with interning order), hence `atomFingerprint`: a memoized
// structural hash of the atom including its derivation-fingerprinting id slot.
// Two firings that derive identically share a key and collapse together; an
// episode whose derivation an edit changes loses its key, and expands.
export function timelineCollapseKey(store: Store, tupleIndex: number): string | null {
  const t = store.tuples[tupleIndex];
  if (t === undefined) return null;
  if (tokenOf(store, t.r) === store.topTok) return null; // a fact, not an episode
  return atomFingerprint(store, t.atom);
}

// Resolve collapse keys against the current store's tuples.
export function resolveCollapsed(store: Store, keys: Iterable<string>): CollapsedInterval[] {
  const want = new Set(keys);
  if (want.size === 0) return [];
  const out: CollapsedInterval[] = [];
  for (let i = 0; i < store.tuples.length; i++) {
    const key = timelineCollapseKey(store, i);
    if (key === null || !want.has(key)) continue;
    const t = store.tuples[i]!;
    // Carry the tuple index: it identifies which episode was collapsed when
    // several share one interval (`~a, ^b`).
    out.push({ l: tokenOf(store, t.l), r: tokenOf(store, t.r), tupleIndex: i });
  }
  return out;
}

// Identifies a moment across re-evaluations of the program, the way
// `timelineCollapseKey` identifies an episode: tokens shift with interning
// order, the structural fingerprint of the moment term does not.
export function momentKey(store: Store, tok: number): string | null {
  const term = store.momentTerms.get(tok);
  if (term === undefined) return null;
  return atomFingerprint(store, { terms: [term] });
}

function resolveMomentKey(store: Store, key: string | null | undefined): number | null {
  if (key === null || key === undefined) return null;
  for (const tok of store.momentTerms.keys()) if (momentKey(store, tok) === key) return tok;
  return null;
}

// One checkbox per `#acc` relation. Unchecked relations are left off the
// timeline; the default (no override) shows the relations ordinary rules
// read and hides pure intermediates.
function renderAccToggles(store: Store, overrides: ReadonlyMap<string, boolean>): HTMLElement {
  const strip = document.createElement("div");
  strip.classList.add("tl-acc-toggles");
  const lead = document.createElement("span");
  lead.classList.add("tl-acc-toggles-lead");
  lead.textContent = "acc";
  strip.appendChild(lead);
  for (const [relation, info] of store.accRelations) {
    const label = document.createElement("label");
    label.title = info.readByRules
      ? "read by ordinary rules (shown by default)"
      : "read only by other acc rules (hidden by default)";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = accRelationVisible(store, relation, overrides);
    box.setAttribute("data-acc-toggle", relation);
    label.appendChild(box);
    label.appendChild(document.createTextNode(" " + relation));
    strip.appendChild(label);
  }
  return strip;
}

// The moment inspector: every acc relation's rows at one moment, diffed
// against the moment's immediate predecessors. `+` rows are missing at some
// predecessor, struck `−` rows are rows a predecessor has and this moment
// lacks. It ignores the timeline's per-relation visibility — this is where
// the hidden relations can still be looked up.
function renderMomentInspector(store: Store, tok: number): HTMLElement {
  const snap = accSnapshot(store, tok);
  const panel = document.createElement("div");
  panel.classList.add("tl-inspector");
  const head = document.createElement("div");
  head.classList.add("tl-inspector-head");
  const name = renderTermShallow(store, store.momentTerms.get(tok)!);
  const state = snap.resolved
    ? "resolved"
    : tok === store.topTok ? "top is never resolved" : "not resolved: acc relations are not computed here yet";
  const title = document.createElement("span");
  title.textContent = `moment ${name} · ${state}`;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("data-acc-inspector-close", "");
  head.appendChild(title);
  head.appendChild(close);
  panel.appendChild(head);
  for (const rel of snap.relations) {
    const section = document.createElement("div");
    section.classList.add("tl-inspector-rel");
    const h = document.createElement("div");
    h.classList.add("tl-inspector-rel-head");
    h.textContent = rel.relation;
    if (rel.consulted) {
      const badge = document.createElement("span");
      badge.classList.add("tl-inspector-read");
      badge.textContent = "read here";
      h.appendChild(badge);
    }
    section.appendChild(h);
    if (rel.rows.length === 0 && rel.gone.length === 0) {
      const none = document.createElement("div");
      none.classList.add("tl-inspector-row", "tl-inspector-none");
      none.textContent = "(no rows)";
      section.appendChild(none);
    }
    for (const row of rel.rows) {
      const r = document.createElement("div");
      r.classList.add("tl-inspector-row");
      if (row.status === "new") r.classList.add("tl-inspector-new");
      r.textContent = `${row.status === "new" ? "+" : " "} ${row.label}`;
      r.setAttribute("data-tl-tuple", String(row.tupleIndex));
      section.appendChild(r);
    }
    for (const label of rel.gone) {
      const r = document.createElement("div");
      r.classList.add("tl-inspector-row", "tl-inspector-gone");
      r.textContent = `− ${label}`;
      section.appendChild(r);
    }
    panel.appendChild(section);
  }
  return panel;
}

export function renderTimelineH(host: HTMLElement, store: Store, opts: TimelineOptions = {}): void {
  const accOverrides = opts.accOverrides ?? new Map<string, boolean>();
  const controls = opts.accControls === true && store.accRelations.size > 0;
  const inspectTok = controls ? resolveMomentKey(store, opts.inspectKey) : null;
  const out = renderTimeline(store, {
    hideInternal: opts.hideInternal ?? true,
    orientation: "horizontal",
    laneMode: "tree",
    momentStyle: opts.momentStyle ?? "edges",
    collapsed: opts.collapsedKeys === undefined ? [] : resolveCollapsed(store, opts.collapsedKeys),
    accOverrides,
    selectedMoment: inspectTok,
  });
  if (!controls) {
    host.replaceChildren(out.main);
    return;
  }
  const parts: Element[] = [renderAccToggles(store, accOverrides), out.main];
  if (inspectTok !== null) parts.push(renderMomentInspector(store, inspectTok));
  host.replaceChildren(...parts);
}

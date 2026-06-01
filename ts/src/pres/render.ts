import type { Block, Doc, ListItem, Segment, Slide, Span } from "./types.js";
import { Editor } from "../v2/editor.js";
import { renderTuples, renderTimelineH } from "../v2/render-output.js";
import { parse as parseV2 } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";
import { createStore, type Store } from "../v2/store.js";
import {
  buildSvgIndex, formatCoord, spliceRange, shiftRangesAfter,
  type SvgIndex, type AttrRange, type ElementEntry,
} from "./svg-index.js";

type State = { slide: number; reveal: number };

// Per code block, the "right" entries of the reveal-state structure `S`
// (see plans/v2-relaxed-editor-freezing.md): reveal -> edited full content.
// Absence of a key means that reveal is "left" (untouched source).
export type EditMap = Map<number, string>;

type EffectiveSlide = {
  kind: "title" | "content";
  slide: Slide;
};

type ActiveBlock = {
  slideIdx: number;
  blockIdx: number;
  segments: Segment[];
  editor: Editor;
  containerEl: HTMLElement;
  hosts: { timeline: HTMLElement; tuples: HTMLElement };
  outBox: HTMLElement;
  errorStrip: HTMLElement;
  enabled: { timeline: boolean; tuples: boolean };
  toggle: (which: "tuples" | "timeline") => void;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  // Most recent fixpoint result that parsed + ran to completion. Seeded
  // with an empty store so the very first render (even on a parse error
  // in the seed text) flows through the normal path.
  lastValidStore: Store;
};

type ActiveSvg = {
  slideIdx: number;
  blockIdx: number;
  // Live reference to the Block in effectiveSlides — we mutate its
  // `body` and `bodyOffset` is also referenced from here. Keeping the
  // pointer avoids re-locating after edits.
  block: Extract<Block, { kind: "svg" }>;
  containerEl: HTMLElement;
  index: SvgIndex;
};

type RenderHandle = {
  doc: Doc;
  effectiveSlides: EffectiveSlide[];
  state: State;
  root: HTMLElement;
  mountedSlide: number;
  edits: Map<string, EditMap>;
  activeBlocks: ActiveBlock[];
  activeSvgs: ActiveSvg[];
  // In-memory copy of full .pres source; mutated on drag commit.
  currentSrc: string;
  // Lazily-built keybindings overlay, appended to document.body and
  // toggled via the help button / `?` key. Null until first opened.
  helpEl: HTMLElement | null;
};

const GAS = 100;
const TUPLE_GAS = 3000;
const DEBOUNCE_MS = 200;

function buildEffectiveSlides(doc: Doc): EffectiveSlide[] {
  const out: EffectiveSlide[] = [];
  const hasMeta = !!(doc.metadata.title || doc.metadata.author || doc.metadata.date);
  if (hasMeta) {
    out.push({
      kind: "title",
      slide: { title: doc.metadata.title ?? "", blocks: [], overlayCount: 1 },
    });
  }
  for (const s of doc.slides) out.push({ kind: "content", slide: s });
  return out;
}

function wrapSpan(s: Span): string {
  let inner = escapeHtml(s.text);
  if (s.code) inner = `<code>${inner}</code>`;
  if (s.italic) inner = `<em>${inner}</em>`;
  if (s.bold) inner = `<strong>${inner}</strong>`;
  return `<span class="frag" data-reveal="${s.reveal}">${inner}</span>`;
}

function spanHtml(spans: Span[]): string {
  return spans.map(wrapSpan).join("");
}

function renderListItems(items: ListItem[]): string {
  let html = "";
  const stack: number[] = [];
  let openLi = false;
  for (const item of items) {
    while (stack.length > 0 && stack[stack.length - 1]! > item.level) {
      if (openLi) { html += "</li>"; openLi = false; }
      html += "</ul>";
      stack.pop();
      if (stack.length > 0) openLi = true;
    }
    if (stack.length === 0 || stack[stack.length - 1]! < item.level) {
      html += `<ul class="block list">`;
      stack.push(item.level);
      openLi = false;
    } else {
      if (openLi) { html += "</li>"; openLi = false; }
    }
    html += `<li class="frag" data-reveal="${item.reveal}">${spanHtml(item.spans)}`;
    openLi = true;
  }
  while (stack.length > 0) {
    if (openLi) { html += "</li>"; openLi = false; }
    html += "</ul>";
    stack.pop();
    if (stack.length > 0) openLi = true;
  }
  return html;
}

function renderBlock(b: Block, blockIdx: number): string {
  if (b.kind === "para") {
    return `<p class="block para">${spanHtml(b.spans)}</p>`;
  }
  if (b.kind === "list") {
    return renderListItems(b.items);
  }
  if (b.kind === "svg") {
    return `<div class="block svg frag" data-block-idx="${blockIdx}" data-reveal="${b.reveal}"></div>`;
  }
  // code — editor mounts after render; container is the visible frame.
  const opts = b.opts.length > 0 ? ` data-opts="${b.opts.join(",")}"` : "";
  return `<div class="block code" data-block-idx="${blockIdx}"${opts}></div>`;
}

function renderSlide(eff: EffectiveSlide, reveal: number, footer: string, helpButton: string): string {
  if (eff.kind === "title") {
    return `<div class="slide title-slide r-${reveal}">
      <h1 class="title-line">${escapeHtml(eff.slide.title)}</h1>
      <div class="meta-author" data-slot="author"></div>
      <div class="meta-date" data-slot="date"></div>
      ${helpButton}
    </div>`;
  }
  const body = eff.slide.blocks.map((b, i) => renderBlock(b, i)).join("");
  return `<div class="slide content-slide r-${reveal}">
    <h1 class="slide-title">${escapeHtml(eff.slide.title)}</h1>
    <div class="slide-body">${body}</div>
    ${footer}
    ${helpButton}
  </div>`;
}

// Keybindings shown in the help overlay. Kept alongside the bindings in
// attachKeyHandler; update both together.
const HELP_ITEMS: Array<[string, string]> = [
  ["→ · l · Space", "Next step"],
  ["← · h", "Previous step"],
  ["↓ · j · PageDown", "Next slide"],
  ["↑ · k · PageUp", "Previous slide"],
  ["Home · p", "First slide"],
  ["End · n", "Last slide"],
  ["t", "Toggle timeline"],
  ["d", "Toggle database"],
  ["?", "Toggle this help"],
  ["Esc", "Close this help"],
];

// The `?` button shown on the first slide only.
const HELP_BUTTON_HTML =
  `<button type="button" class="help-button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>`;

function ensureHelpEl(h: RenderHandle): HTMLElement {
  if (h.helpEl) return h.helpEl;
  const overlay = document.createElement("div");
  overlay.className = "help-overlay";
  overlay.hidden = true;
  const rows = HELP_ITEMS.map(
    ([k, d]) => `<tr><td class="help-key">${escapeHtml(k)}</td><td class="help-desc">${escapeHtml(d)}</td></tr>`,
  ).join("");
  overlay.innerHTML = `<div class="help-panel">
    <h2 class="help-title">Keyboard shortcuts</h2>
    <table class="help-table">${rows}</table>
    <div class="help-hint">press ? or Esc to close</div>
  </div>`;
  // Click on the backdrop (but not the panel) closes.
  overlay.addEventListener("click", ev => { if (ev.target === overlay) closeHelp(h); });
  document.body.appendChild(overlay);
  h.helpEl = overlay;
  return overlay;
}

function helpOpen(h: RenderHandle): boolean {
  return !!h.helpEl && !h.helpEl.hidden;
}

function closeHelp(h: RenderHandle): void {
  if (h.helpEl) h.helpEl.hidden = true;
}

function toggleHelp(h: RenderHandle): void {
  if (helpOpen(h)) closeHelp(h);
  else ensureHelpEl(h).hidden = false;
}

// Bottom-right slide number for content slides. Title slides get no number;
// content slides are numbered from 1. With `show-slide-total` on, append the
// total content-slide count as `i / n`.
function slideFooter(h: RenderHandle, eff: EffectiveSlide): string {
  if (eff.kind !== "content") return "";
  const hasTitle = h.effectiveSlides[0]?.kind === "title";
  const num = h.state.slide - (hasTitle ? 1 : 0) + 1;
  const label = h.doc.metadata.showSlideTotal
    ? `${num} / ${h.doc.slides.length}`
    : `${num}`;
  return `<div class="slide-number">${label}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function applyReveal(slideEl: HTMLElement, reveal: number) {
  slideEl.className = slideEl.className.replace(/\br-\d+\b/g, "").trim();
  slideEl.classList.add(`r-${reveal}`);
  const frags = slideEl.querySelectorAll<HTMLElement>(".frag");
  frags.forEach(f => {
    const k = parseInt(f.dataset.reveal ?? "1", 10);
    f.classList.toggle("hidden-frag", k > reveal);
  });
}

function updateUrlHash(state: State) {
  const h = `#s=${state.slide}&r=${state.reveal}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

function readUrlHash(): Partial<State> {
  const m = /#s=(\d+)(?:&r=(\d+))?/.exec(location.hash);
  if (!m) return {};
  return { slide: parseInt(m[1]!, 10), reveal: m[2] ? parseInt(m[2], 10) : 1 };
}

export function mount(root: HTMLElement, doc: Doc, source: string = ""): RenderHandle {
  const theme = doc.metadata.theme ?? "light";
  document.body.classList.remove("mode-light", "mode-dark");
  document.body.classList.add(`mode-${theme}`);
  const effectiveSlides = buildEffectiveSlides(doc);
  if (effectiveSlides.length === 0) {
    root.innerHTML = `<div class="empty">no slides</div>`;
    return {
      doc, effectiveSlides, state: { slide: 0, reveal: 1 }, root,
      mountedSlide: -1, edits: new Map(), activeBlocks: [], activeSvgs: [],
      currentSrc: source, helpEl: null,
    };
  }
  const init = readUrlHash();
  const state: State = {
    slide: clamp(init.slide ?? 0, 0, effectiveSlides.length - 1),
    reveal: Math.max(1, init.reveal ?? 1),
  };
  const handle: RenderHandle = {
    doc, effectiveSlides, state, root,
    mountedSlide: -1, edits: new Map(), activeBlocks: [], activeSvgs: [],
    currentSrc: source, helpEl: null,
  };
  renderCurrent(handle);
  attachKeyHandler(handle);
  window.addEventListener("hashchange", () => {
    const h = readUrlHash();
    if (h.slide !== undefined) {
      handle.state.slide = clamp(h.slide, 0, effectiveSlides.length - 1);
      handle.state.reveal = Math.max(1, h.reveal ?? 1);
      renderCurrent(handle);
    }
  });
  return handle;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function renderCurrent(h: RenderHandle) {
  const eff = h.effectiveSlides[h.state.slide]!;
  h.state.reveal = clamp(h.state.reveal, 1, eff.slide.overlayCount);

  if (h.mountedSlide !== h.state.slide) {
    teardownAll(h);
    const helpButton = h.state.slide === 0 ? HELP_BUTTON_HTML : "";
    h.root.innerHTML = renderSlide(eff, h.state.reveal, slideFooter(h, eff), helpButton);
    h.mountedSlide = h.state.slide;
    if (eff.kind === "title") {
      const authorEl = h.root.querySelector<HTMLElement>('[data-slot="author"]');
      const dateEl = h.root.querySelector<HTMLElement>('[data-slot="date"]');
      if (authorEl) authorEl.textContent = h.doc.metadata.author ?? "";
      if (dateEl) dateEl.textContent = h.doc.metadata.date ?? "";
    }
    const helpBtn = h.root.querySelector<HTMLElement>(".help-button");
    if (helpBtn) helpBtn.addEventListener("click", () => toggleHelp(h));
    mountCodeBlocks(h);
    mountSvgBlocks(h);
  }

  const slideEl = h.root.querySelector<HTMLElement>(".slide");
  if (slideEl) applyReveal(slideEl, h.state.reveal);
  applyCodeReveal(h);
  updateUrlHash(h.state);
}

function editKey(slideIdx: number, blockIdx: number): string {
  return `${slideIdx}/${blockIdx}`;
}

export function revealedText(segments: Segment[], reveal: number): string {
  let out = "";
  for (const s of segments) if (s.reveal <= reveal) out += s.text;
  return out;
}

// Greatest reveal with a "right" (edited) entry, or 0 if there are none.
export function maxEdited(S: EditMap): number {
  let m = 0;
  for (const r of S.keys()) if (r > m) m = r;
  return m;
}

// Reconstruct the editor text at `reveal` from the reveal-state structure S:
// start from the nearest "right" entry at or below `reveal`, then append the
// source segments for the reveals above it (up to `reveal`). With an empty S
// this equals `revealedText(segments, reveal)`.
export function editorState(S: EditMap, segments: Segment[], reveal: number): string {
  let base = "";
  let start = 0;
  for (let r = reveal; r >= 1; r--) {
    const e = S.get(r);
    if (e !== undefined) { base = e; start = r; break; }
  }
  let out = base;
  for (const s of segments) if (s.reveal > start && s.reveal <= reveal) out += s.text;
  return out;
}

function applyCodeReveal(h: RenderHandle) {
  for (const a of h.activeBlocks) {
    const S = h.edits.get(editKey(a.slideIdx, a.blockIdx))!;
    const R = h.state.reveal;
    const next = editorState(S, a.segments, R);
    a.editor.setFrozen(maxEdited(S) > R);
    if (a.editor.value === next) continue;
    a.editor.value = next;
    // Programmatic value writes don't fire `input`, so re-evaluate
    // synchronously rather than waiting for the debounced onChange.
    if (a.debounceTimer !== null) {
      clearTimeout(a.debounceTimer);
      a.debounceTimer = null;
    }
    runAndRender(next, a);
  }
}

function mountCodeBlocks(h: RenderHandle) {
  const eff = h.effectiveSlides[h.state.slide]!;
  if (eff.kind !== "content") return;
  const slide = eff.slide;
  for (let blockIdx = 0; blockIdx < slide.blocks.length; blockIdx++) {
    const block = slide.blocks[blockIdx]!;
    if (block.kind !== "code") continue;
    mountActive(h, blockIdx, block);
  }
}

function mountActive(h: RenderHandle, blockIdx: number, block: Block) {
  if (block.kind !== "code") return;
  const containerEl = h.root.querySelector<HTMLElement>(`.block.code[data-block-idx="${blockIdx}"]`);
  if (!containerEl) return;

  const key = editKey(h.state.slide, blockIdx);
  let S = h.edits.get(key);
  if (!S) { S = new Map(); h.edits.set(key, S); }
  const initial = editorState(S, block.segments, h.state.reveal);
  const hostBox = document.createElement("div");
  hostBox.className = "pres-editor-host";
  containerEl.appendChild(hostBox);

  const tuplesHost = document.createElement("div");
  tuplesHost.className = "pres-output-tuples";
  const timelineHost = document.createElement("div");
  timelineHost.className = "pres-output-timeline";
  const outBox = document.createElement("div");
  outBox.className = "pres-output";
  outBox.appendChild(tuplesHost);
  outBox.appendChild(timelineHost);
  containerEl.appendChild(outBox);

  // Error strip sits AFTER outBox so toggling it doesn't shift the
  // db/timeline up and down.
  const errorStrip = document.createElement("div");
  errorStrip.className = "pres-eval-error";
  errorStrip.style.display = "none";
  containerEl.appendChild(errorStrip);

  const enabled = {
    tuples: block.opts.includes("tuples"),
    timeline: block.opts.includes("timeline"),
  };
  const applyVisibility = () => {
    tuplesHost.style.display = enabled.tuples ? "" : "none";
    timelineHost.style.display = enabled.timeline ? "" : "none";
    outBox.style.display = (enabled.tuples || enabled.timeline) ? "" : "none";
  };
  applyVisibility();

  // Toolbar with toggle buttons.
  const toolbar = document.createElement("div");
  toolbar.className = "pres-editor-toolbar";
  const refreshers: Array<() => void> = [];
  const toggleFn = (which: "tuples" | "timeline") => {
    enabled[which] = !enabled[which];
    for (const r of refreshers) r();
    applyVisibility();
    // Re-render the most recent valid store into the newly visible
    // host; avoids re-evaluating a (possibly broken) current source.
    if (enabled[which]) renderIntoHosts(active.lastValidStore, { timeline: timelineHost, tuples: tuplesHost }, enabled);
  };
  const mkToggle = (label: string, which: "tuples" | "timeline") => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pres-toggle";
    btn.textContent = label;
    const refresh = () => btn.classList.toggle("active", enabled[which]);
    refresh();
    refreshers.push(refresh);
    btn.addEventListener("click", () => toggleFn(which));
    toolbar.appendChild(btn);
  };
  mkToggle("db", "tuples");
  mkToggle("timeline", "timeline");

  const active: ActiveBlock = {
    slideIdx: h.state.slide,
    blockIdx,
    segments: block.segments,
    editor: null!,
    containerEl,
    hosts: { timeline: timelineHost, tuples: tuplesHost },
    outBox,
    errorStrip,
    enabled,
    toggle: toggleFn,
    debounceTimer: null,
    lastValidStore: createStore(),
  };

  const runOnce = (source: string) => {
    runAndRender(source, active);
  };

  const editor = new Editor({
    host: hostBox,
    initial,
    saveBackend: "none",
    autoGrow: true,
    onChange: (value: string) => {
      // Edits can only reach a non-frozen reveal; record the current
      // reveal as a "right" entry. The throw guards the invariant that a
      // frozen reveal (one with edits at a greater reveal) never lands here.
      const R = h.state.reveal;
      if (maxEdited(S) > R) throw new Error("edit on a frozen reveal");
      S.set(R, value);
      if (active.debounceTimer !== null) clearTimeout(active.debounceTimer);
      active.debounceTimer = setTimeout(() => {
        active.debounceTimer = null;
        runOnce(value);
      }, DEBOUNCE_MS);
    },
  });
  active.editor = editor;
  editor.setFrozen(maxEdited(S) > h.state.reveal);
  hostBox.appendChild(toolbar);
  h.activeBlocks.push(active);

  // Render the seeded empty store so a parse-on-load failure still
  // shows a populated (empty) db/timeline, not bare divs.
  renderIntoHosts(active.lastValidStore, active.hosts, enabled);

  // Initial run with the seed text.
  runOnce(initial);
}

function mountSvgBlocks(h: RenderHandle) {
  const eff = h.effectiveSlides[h.state.slide]!;
  if (eff.kind !== "content") return;
  const slide = eff.slide;
  for (let blockIdx = 0; blockIdx < slide.blocks.length; blockIdx++) {
    const block = slide.blocks[blockIdx]!;
    if (block.kind !== "svg") continue;
    mountSvgBlock(h, blockIdx, block);
  }
}

function mountSvgBlock(
  h: RenderHandle,
  blockIdx: number,
  block: Extract<Block, { kind: "svg" }>,
) {
  const containerEl = h.root.querySelector<HTMLElement>(
    `.block.svg[data-block-idx="${blockIdx}"]`,
  );
  if (!containerEl) return;

  const index = buildSvgIndex(block.body);
  if (!index) {
    containerEl.textContent = `svg parse error`;
    return;
  }
  containerEl.innerHTML = "";
  containerEl.appendChild(index.root);

  const active: ActiveSvg = {
    slideIdx: h.state.slide, blockIdx, block, containerEl, index,
  };
  h.activeSvgs.push(active);

  if (block.dynamic) {
    for (const entry of index.elements) attachHandle(h, active, entry);
  }
}

// Compute the translate origin for a draggable element (where to put
// its drag handle, and which attributes move when dragged).
function translateOrigin(entry: ElementEntry): { x: number; y: number } | null {
  const v = (attr: string): number | null => {
    const r = entry.ranges.get(attr);
    if (!r) return null;
    // Read off the live DOM attribute (this is what the renderer is
    // showing; ranges are source-side and stay in sync).
    const s = entry.domEl.getAttribute(attr);
    if (s === null) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };
  switch (entry.tag) {
    case "circle": case "ellipse": {
      const cx = v("cx"), cy = v("cy");
      if (cx === null || cy === null) return null;
      return { x: cx, y: cy };
    }
    case "rect": {
      const x = v("x"), y = v("y");
      if (x === null || y === null) return null;
      return { x, y };
    }
    case "line": {
      const x1 = v("x1"), y1 = v("y1");
      if (x1 === null || y1 === null) return null;
      return { x: x1, y: y1 };
    }
    case "text": {
      const x = v("x"), y = v("y");
      if (x === null || y === null) return null;
      return { x, y };
    }
  }
}

// Which attribute pairs translate together (x-attr, y-attr).
function translatePairs(entry: ElementEntry): Array<[string, string]> {
  switch (entry.tag) {
    case "circle": case "ellipse": return [["cx", "cy"]];
    case "rect": return [["x", "y"]];
    case "text": return [["x", "y"]];
    case "line": return [["x1", "y1"], ["x2", "y2"]];
  }
}

const HANDLE_RADIUS_PX = 6;

function attachHandle(h: RenderHandle, active: ActiveSvg, entry: ElementEntry) {
  const origin = translateOrigin(entry);
  if (origin === null) return;
  const pairs = translatePairs(entry);
  // Only attach if every translating attribute has a range we can write.
  for (const [ax, ay] of pairs) {
    if (!entry.ranges.has(ax) || !entry.ranges.has(ay)) return;
  }

  const svgNS = "http://www.w3.org/2000/svg";
  const handle = document.createElementNS(svgNS, "circle");
  handle.setAttribute("cx", String(origin.x));
  handle.setAttribute("cy", String(origin.y));
  handle.setAttribute("r", String(HANDLE_RADIUS_PX));
  handle.setAttribute("class", "svg-handle");
  handle.setAttribute("fill", "rgba(60,120,255,0.35)");
  handle.setAttribute("stroke", "rgba(30,80,200,0.9)");
  handle.setAttribute("stroke-width", "1");
  (handle.style as CSSStyleDeclaration).cursor = "grab";
  // Make handle radius approximately constant in screen px regardless
  // of viewBox scaling. Browsers ignore this if no viewBox; that's fine.
  handle.setAttribute("vector-effect", "non-scaling-stroke");
  active.index.root.appendChild(handle);

  type DragState = {
    pointerId: number;
    startClient: { x: number; y: number };
    startCtm: DOMMatrix;
    startValues: Map<string, number>;
  };
  let drag: DragState | null = null;

  const screenToLocalDelta = (clientDx: number, clientDy: number, ctm: DOMMatrix) => {
    // Inverse of CTM applied to the *delta* — the translation part of
    // CTM cancels out for deltas, so we only need the linear part.
    const inv = ctm.inverse();
    const dx = inv.a * clientDx + inv.c * clientDy;
    const dy = inv.b * clientDx + inv.d * clientDy;
    return { dx, dy };
  };

  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    (handle.style as CSSStyleDeclaration).cursor = "grabbing";
    const ctm = active.index.root.getScreenCTM();
    if (!ctm) return;
    const startValues = new Map<string, number>();
    for (const [ax, ay] of pairs) {
      startValues.set(ax, parseFloat(entry.domEl.getAttribute(ax)!));
      startValues.set(ay, parseFloat(entry.domEl.getAttribute(ay)!));
    }
    drag = {
      pointerId: ev.pointerId,
      startClient: { x: ev.clientX, y: ev.clientY },
      startCtm: ctm,
      startValues,
    };
  });

  handle.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const { dx, dy } = screenToLocalDelta(
      ev.clientX - drag.startClient.x,
      ev.clientY - drag.startClient.y,
      drag.startCtm,
    );
    for (const [ax, ay] of pairs) {
      const nx = drag.startValues.get(ax)! + dx;
      const ny = drag.startValues.get(ay)! + dy;
      entry.domEl.setAttribute(ax, formatCoord(nx));
      entry.domEl.setAttribute(ay, formatCoord(ny));
    }
    // Sync the handle to the new translate origin.
    const o = translateOrigin(entry);
    if (o) {
      handle.setAttribute("cx", String(o.x));
      handle.setAttribute("cy", String(o.y));
    }
  });

  const finish = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    try { handle.releasePointerCapture(ev.pointerId); } catch {}
    (handle.style as CSSStyleDeclaration).cursor = "grab";
    // Commit: splice each updated attribute back into the source. We
    // sort ranges descending by start so earlier splices don't shift
    // later ones (and we update SvgIndex per splice for the same
    // reason).
    const touched: string[] = [];
    for (const [ax, ay] of pairs) { touched.push(ax, ay); }
    const rangesToCommit: Array<{ attr: string; range: AttrRange; newVal: string }> = [];
    for (const attr of touched) {
      const range = entry.ranges.get(attr)!;
      const newVal = entry.domEl.getAttribute(attr)!;
      rangesToCommit.push({ attr, range, newVal });
    }
    rangesToCommit.sort((a, b) => b.range.start - a.range.start);
    for (const c of rangesToCommit) {
      commitOne(h, active, c.range, c.newVal);
    }
    drag = null;
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function allRangesInIndex(index: SvgIndex): AttrRange[] {
  const out: AttrRange[] = [];
  for (const e of index.elements) for (const r of e.ranges.values()) out.push(r);
  return out;
}

function commitOne(
  h: RenderHandle,
  active: ActiveSvg,
  range: AttrRange,
  newVal: string,
) {
  const block = active.block;
  // 1. Splice the block body.
  const { body: newBody, delta } = spliceRange(block.body, range, newVal);
  block.body = newBody;
  // 2. Splice the full source at block.bodyOffset + range.start.
  const absStart = block.bodyOffset + range.start;
  const absEnd = block.bodyOffset + range.end;
  h.currentSrc =
    h.currentSrc.slice(0, absStart) + newVal + h.currentSrc.slice(absEnd);
  // 3. Shift later ranges in this svg index.
  shiftRangesAfter(allRangesInIndex(active.index), range, newVal.length);
  // 4. Shift later svg blocks' bodyOffsets on the SAME slide. (Blocks
  // on other slides will be re-checked next time they mount; their
  // bodyOffset points into currentSrc which has now shifted.)
  for (const otherSvg of h.activeSvgs) {
    if (otherSvg === active) continue;
    if (otherSvg.block.bodyOffset > block.bodyOffset) {
      otherSvg.block.bodyOffset += delta;
    }
  }
  // 5. Also shift bodyOffsets for any non-mounted svg blocks that come
  // after this one in the source. Walk effectiveSlides.
  for (const eff of h.effectiveSlides) {
    if (eff.kind !== "content") continue;
    for (const b of eff.slide.blocks) {
      if (b.kind !== "svg") continue;
      if (b === block) continue;
      if (b.bodyOffset > block.bodyOffset) b.bodyOffset += delta;
    }
  }
}

function teardownAll(h: RenderHandle) {
  for (const a of h.activeBlocks) {
    // Edits live in h.edits, written synchronously on each keystroke, so
    // there is nothing to snapshot here.
    if (a.debounceTimer !== null) clearTimeout(a.debounceTimer);
    a.editor.destroy();
    const outBox = a.containerEl.querySelector<HTMLElement>(".pres-output");
    if (outBox) outBox.remove();
    const errStrip = a.containerEl.querySelector<HTMLElement>(".pres-eval-error");
    if (errStrip) errStrip.remove();
    const hostBox = a.containerEl.querySelector<HTMLElement>(".pres-editor-host");
    if (hostBox) hostBox.remove();
  }
  h.activeBlocks = [];
  for (const a of h.activeSvgs) {
    a.containerEl.innerHTML = "";
  }
  h.activeSvgs = [];
}

function runAndRender(source: string, active: ActiveBlock): void {
  const parsed = parseV2(source);
  if ("message" in parsed) {
    showError(active, `parse error line ${parsed.line}: ${parsed.message}`);
    return;
  }
  const { store, status } = runFixpoint(parsed, GAS, TUPLE_GAS);
  if (status.kind === "gas") {
    showError(active, `gas exceeded (${GAS} iterations)`);
    return;
  }
  clearError(active);
  active.lastValidStore = store;
  renderIntoHosts(store, active.hosts, active.enabled);
}

function renderIntoHosts(
  store: Store,
  hosts: { timeline: HTMLElement; tuples: HTMLElement },
  enabled: { timeline: boolean; tuples: boolean },
): void {
  if (enabled.timeline) renderTimelineH(hosts.timeline, store);
  if (enabled.tuples) renderTuples(hosts.tuples, store, { temporal: true });
}

function showError(active: ActiveBlock, msg: string): void {
  active.errorStrip.textContent = msg;
  active.errorStrip.style.display = "";
  active.outBox.classList.add("stale");
}

function clearError(active: ActiveBlock): void {
  active.errorStrip.textContent = "";
  active.errorStrip.style.display = "none";
  active.outBox.classList.remove("stale");
}

function attachKeyHandler(h: RenderHandle) {
  const gotoStart = () => { h.state.slide = 0; h.state.reveal = 1; renderCurrent(h); };
  const gotoEnd = () => {
    h.state.slide = h.effectiveSlides.length - 1;
    h.state.reveal = h.effectiveSlides[h.state.slide]!.slide.overlayCount;
    renderCurrent(h);
  };
  const toggleTimeline = () => { for (const a of h.activeBlocks) a.toggle("timeline"); };
  const toggleTuples = () => { for (const a of h.activeBlocks) a.toggle("tuples"); };

  const bindings: Record<string, () => void> = {
    "ArrowRight": () => nextReveal(h),
    "l":          () => nextReveal(h),
    " ":          () => nextReveal(h),
    "ArrowLeft":  () => prevReveal(h),
    "h":          () => prevReveal(h),
    "ArrowDown":  () => nextSlide(h),
    "j":          () => nextSlide(h),
    "PageDown":   () => nextSlide(h),
    "ArrowUp":    () => prevSlide(h),
    "k":          () => prevSlide(h),
    "PageUp":     () => prevSlide(h),
    "Home":       gotoStart,
    "p":          gotoStart,
    "End":        gotoEnd,
    "n":          gotoEnd,
    "t":          toggleTimeline,
    "d":          toggleTuples,
    "?":          () => toggleHelp(h),
  };

  document.addEventListener("keydown", ev => {
    if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
    // Any modifier suppresses our handlers — those combos belong to the
    // browser/OS. (`?` is Shift+/, so shiftKey is deliberately allowed.)
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // While the help overlay is open, only `?`/Esc act (both close it);
    // every other key is swallowed so navigation can't run behind it.
    if (helpOpen(h)) {
      if (ev.key === "?" || ev.key === "Escape") { closeHelp(h); ev.preventDefault(); }
      return;
    }
    const fn = bindings[ev.key];
    if (!fn) return;
    fn();
    ev.preventDefault();
  });

  const isCoarsePointer = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;
  h.root.addEventListener("click", ev => {
    if (!isCoarsePointer()) return;
    const target = ev.target as Element | null;
    if (!target) return;
    // Don't hijack interactions with editors, draggable SVG geometry, or form controls.
    if (target.closest(".block.code, .block.svg, textarea, input, button, a, [contenteditable=\"true\"]")) return;
    if (ev.clientX < window.innerWidth / 2) prevReveal(h);
    else nextReveal(h);
  });
}

function nextReveal(h: RenderHandle) {
  const eff = h.effectiveSlides[h.state.slide]!;
  if (h.state.reveal < eff.slide.overlayCount) {
    h.state.reveal++;
  } else if (h.state.slide < h.effectiveSlides.length - 1) {
    h.state.slide++;
    h.state.reveal = 1;
  } else return;
  renderCurrent(h);
}

function prevReveal(h: RenderHandle) {
  if (h.state.reveal > 1) {
    h.state.reveal--;
  } else if (h.state.slide > 0) {
    h.state.slide--;
    h.state.reveal = h.effectiveSlides[h.state.slide]!.slide.overlayCount;
  } else return;
  renderCurrent(h);
}

function nextSlide(h: RenderHandle) {
  if (h.state.slide >= h.effectiveSlides.length - 1) return;
  h.state.slide++;
  h.state.reveal = h.effectiveSlides[h.state.slide]!.slide.overlayCount;
  renderCurrent(h);
}

function prevSlide(h: RenderHandle) {
  if (h.state.slide <= 0) return;
  h.state.slide--;
  h.state.reveal = h.effectiveSlides[h.state.slide]!.slide.overlayCount;
  renderCurrent(h);
}

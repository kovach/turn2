import type { Block, Doc, ListItem, Slide, Span } from "./types.js";
import { Editor } from "../v2/editor.js";
import { renderTuples, renderTimelineH } from "../v2/render-output.js";
import { parse as parseV2 } from "../v2/parse.js";
import { runFixpoint } from "../v2/fixpoint.js";

type State = { slide: number; reveal: number };

type EffectiveSlide = {
  kind: "title" | "content";
  slide: Slide;
};

type ActiveBlock = {
  slideIdx: number;
  blockIdx: number;
  editor: Editor;
  preEl: HTMLElement;
  containerEl: HTMLElement;
  hosts: { timeline: HTMLElement; tuples: HTMLElement };
  enabled: { timeline: boolean; tuples: boolean };
  toggle: (which: "tuples" | "timeline") => void;
  debounceTimer: ReturnType<typeof setTimeout> | null;
};

type RenderHandle = {
  doc: Doc;
  effectiveSlides: EffectiveSlide[];
  state: State;
  root: HTMLElement;
  mountedSlide: number;
  editMap: Map<string, string>;
  active: ActiveBlock | null;
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
  // code
  const segs = b.segments.map(s =>
    `<span class="frag" data-reveal="${s.reveal}">${escapeHtml(s.text)}</span>`
  ).join("");
  const opts = b.opts.length > 0 ? ` data-opts="${b.opts.join(",")}"` : "";
  return `<div class="block code" data-block-idx="${blockIdx}"${opts}><pre class="code-display">${segs}</pre></div>`;
}

function renderSlide(eff: EffectiveSlide, reveal: number): string {
  if (eff.kind === "title") {
    return `<div class="slide title-slide r-${reveal}">
      <h1 class="title-line">${escapeHtml(eff.slide.title)}</h1>
      <div class="meta-author" data-slot="author"></div>
      <div class="meta-date" data-slot="date"></div>
    </div>`;
  }
  const body = eff.slide.blocks.map((b, i) => renderBlock(b, i)).join("");
  return `<div class="slide content-slide r-${reveal}">
    <h1 class="slide-title">${escapeHtml(eff.slide.title)}</h1>
    <div class="slide-body">${body}</div>
  </div>`;
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

export function mount(root: HTMLElement, doc: Doc): RenderHandle {
  const mode = doc.metadata.mode ?? "light";
  document.body.classList.remove("mode-light", "mode-dark");
  document.body.classList.add(`mode-${mode}`);
  const effectiveSlides = buildEffectiveSlides(doc);
  if (effectiveSlides.length === 0) {
    root.innerHTML = `<div class="empty">no slides</div>`;
    return {
      doc, effectiveSlides, state: { slide: 0, reveal: 1 }, root,
      mountedSlide: -1, editMap: new Map(), active: null,
    };
  }
  const init = readUrlHash();
  const state: State = {
    slide: clamp(init.slide ?? 0, 0, effectiveSlides.length - 1),
    reveal: Math.max(1, init.reveal ?? 1),
  };
  const handle: RenderHandle = {
    doc, effectiveSlides, state, root,
    mountedSlide: -1, editMap: new Map(), active: null,
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
    teardownActive(h);
    h.root.innerHTML = renderSlide(eff, h.state.reveal);
    h.mountedSlide = h.state.slide;
    if (eff.kind === "title") {
      const authorEl = h.root.querySelector<HTMLElement>('[data-slot="author"]');
      const dateEl = h.root.querySelector<HTMLElement>('[data-slot="date"]');
      if (authorEl) authorEl.textContent = h.doc.metadata.author ?? "";
      if (dateEl) dateEl.textContent = h.doc.metadata.date ?? "";
    }
  }

  const slideEl = h.root.querySelector<HTMLElement>(".slide");
  if (slideEl) applyReveal(slideEl, h.state.reveal);
  reconcileCodeBlock(h);
  updateUrlHash(h.state);
}

function reconcileCodeBlock(h: RenderHandle) {
  const eff = h.effectiveSlides[h.state.slide]!;
  if (eff.kind !== "content") return;
  const slide = eff.slide;
  const blockIdx = slide.blocks.findIndex(b => b.kind === "code");
  if (blockIdx < 0) return;
  const block = slide.blocks[blockIdx]!;
  if (block.kind !== "code") return;
  // Mount once every segment of the code block is revealed, even if the
  // slide has further [pause]s after the block.
  const codeMaxReveal = block.segments.reduce((m, s) => Math.max(m, s.reveal), 1);
  const fullyShown = h.state.reveal >= codeMaxReveal;

  if (fullyShown && !h.active) {
    mountActive(h, blockIdx);
  } else if (!fullyShown && h.active) {
    teardownActive(h);
  }
}

function editKey(slideIdx: number, blockIdx: number): string {
  return `${slideIdx}/${blockIdx}`;
}

function mountActive(h: RenderHandle, blockIdx: number) {
  const slide = h.effectiveSlides[h.state.slide]!.slide;
  const block = slide.blocks[blockIdx];
  if (!block || block.kind !== "code") return;
  const containerEl = h.root.querySelector<HTMLElement>(`.block.code[data-block-idx="${blockIdx}"]`);
  if (!containerEl) return;
  const preEl = containerEl.querySelector<HTMLElement>(".code-display");
  if (!preEl) return;

  const key = editKey(h.state.slide, blockIdx);
  const initial = h.editMap.get(key) ?? block.segments.map(s => s.text).join("");
  const hostBox = document.createElement("div");
  hostBox.className = "pres-editor-host";
  containerEl.insertBefore(hostBox, preEl);
  preEl.style.display = "none";

  const tuplesHost = document.createElement("div");
  tuplesHost.className = "pres-output-tuples";
  const timelineHost = document.createElement("div");
  timelineHost.className = "pres-output-timeline";
  const outBox = document.createElement("div");
  outBox.className = "pres-output";
  outBox.appendChild(tuplesHost);
  outBox.appendChild(timelineHost);
  containerEl.appendChild(outBox);

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
    if (enabled[which]) runOnce(editor.value);
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
    editor: null!,
    preEl,
    containerEl,
    hosts: { timeline: timelineHost, tuples: tuplesHost },
    enabled,
    toggle: toggleFn,
    debounceTimer: null,
  };

  const runOnce = (source: string) => {
    runAndRender(source, { timeline: timelineHost, tuples: tuplesHost }, enabled);
  };

  const editor = new Editor({
    host: hostBox,
    initial,
    saveBackend: "none",
    autoGrow: true,
    onChange: (value: string) => {
      h.editMap.set(key, value);
      if (active.debounceTimer !== null) clearTimeout(active.debounceTimer);
      active.debounceTimer = setTimeout(() => {
        active.debounceTimer = null;
        runOnce(value);
      }, DEBOUNCE_MS);
    },
  });
  active.editor = editor;
  hostBox.appendChild(toolbar);
  h.active = active;

  // Initial run with the seed text.
  runOnce(initial);
}

function teardownActive(h: RenderHandle) {
  const a = h.active;
  if (!a) return;
  // Snapshot current text in case debounce hasn't fired.
  h.editMap.set(editKey(a.slideIdx, a.blockIdx), a.editor.value);
  if (a.debounceTimer !== null) clearTimeout(a.debounceTimer);
  a.editor.destroy();
  // Remove output box (sibling of preEl).
  const outBox = a.containerEl.querySelector<HTMLElement>(".pres-output");
  if (outBox) outBox.remove();
  // Remove editor host box.
  const hostBox = a.containerEl.querySelector<HTMLElement>(".pres-editor-host");
  if (hostBox) hostBox.remove();
  a.preEl.style.display = "";
  h.active = null;
}

function runAndRender(
  source: string,
  hosts: { timeline: HTMLElement; tuples: HTMLElement },
  enabled: { timeline: boolean; tuples: boolean },
): void {
  const parsed = parseV2(source);
  if ("message" in parsed) {
    showError(hosts, enabled, `parse error line ${parsed.line}: ${parsed.message}`);
    return;
  }
  const { store, status } = runFixpoint(parsed, GAS, TUPLE_GAS);
  if (status.kind === "gas") {
    showError(hosts, enabled, `gas exceeded (${GAS} iterations)`);
    return;
  }
  if (enabled.timeline) renderTimelineH(hosts.timeline, store);
  if (enabled.tuples) renderTuples(hosts.tuples, store, { temporal: true });
}

function showError(
  hosts: { timeline: HTMLElement; tuples: HTMLElement },
  enabled: { timeline: boolean; tuples: boolean },
  msg: string,
): void {
  const html = `<div class="pres-eval-error">${escapeHtml(msg)}</div>`;
  if (enabled.timeline) hosts.timeline.innerHTML = html;
  if (enabled.tuples) hosts.tuples.innerHTML = html;
}

function attachKeyHandler(h: RenderHandle) {
  const gotoStart = () => { h.state.slide = 0; h.state.reveal = 1; renderCurrent(h); };
  const gotoEnd = () => {
    h.state.slide = h.effectiveSlides.length - 1;
    h.state.reveal = h.effectiveSlides[h.state.slide]!.slide.overlayCount;
    renderCurrent(h);
  };
  const toggleTimeline = () => { if (h.active) h.active.toggle("timeline"); };
  const toggleTuples = () => { if (h.active) h.active.toggle("tuples"); };

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
  };

  document.addEventListener("keydown", ev => {
    if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
    // Any modifier suppresses our handlers — those combos belong to the browser/OS.
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const fn = bindings[ev.key];
    if (!fn) return;
    fn();
    ev.preventDefault();
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

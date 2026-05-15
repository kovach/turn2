import type { Block, Doc, Slide, Span } from "./types.js";

type State = { slide: number; reveal: number };

type RenderHandle = {
  doc: Doc;
  effectiveSlides: EffectiveSlide[];
  state: State;
  root: HTMLElement;
};

type EffectiveSlide = {
  kind: "title" | "content";
  slide: Slide;
};

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

function spanHtml(spans: Span[]): string {
  return spans.map(s =>
    `<span class="frag" data-reveal="${s.reveal}">${escapeHtml(s.text)}</span>`
  ).join("");
}

function renderBlock(b: Block): string {
  if (b.kind === "para") {
    return `<p class="block para">${spanHtml(b.spans)}</p>`;
  }
  if (b.kind === "list") {
    const items = b.items.map(item => {
      const firstReveal = item[0]?.reveal ?? 1;
      return `<li class="frag" data-reveal="${firstReveal}">${spanHtml(item)}</li>`;
    }).join("");
    return `<ul class="block list">${items}</ul>`;
  }
  // code
  const segs = b.segments.map(s =>
    `<span class="frag" data-reveal="${s.reveal}">${escapeHtml(s.text)}</span>`
  ).join("");
  const opts = b.opts.length > 0 ? ` data-opts="${b.opts.join(",")}"` : "";
  return `<div class="block code"${opts}><pre class="code-display">${segs}</pre></div>`;
}

function renderSlide(eff: EffectiveSlide, reveal: number): string {
  if (eff.kind === "title") {
    // Title slide: pull from doc metadata at render time.
    return `<div class="slide title-slide r-${reveal}">
      <h1 class="title-line">${escapeHtml(eff.slide.title)}</h1>
      <div class="meta-author" data-slot="author"></div>
      <div class="meta-date" data-slot="date"></div>
    </div>`;
  }
  const body = eff.slide.blocks.map(renderBlock).join("");
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
  // Strip prior r-N classes.
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
    return { doc, effectiveSlides, state: { slide: 0, reveal: 1 }, root };
  }
  const init = readUrlHash();
  const state: State = {
    slide: clamp(init.slide ?? 0, 0, effectiveSlides.length - 1),
    reveal: Math.max(1, init.reveal ?? 1),
  };
  const handle: RenderHandle = { doc, effectiveSlides, state, root };
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
  h.root.innerHTML = renderSlide(eff, h.state.reveal);
  if (eff.kind === "title") {
    const authorEl = h.root.querySelector<HTMLElement>('[data-slot="author"]');
    const dateEl = h.root.querySelector<HTMLElement>('[data-slot="date"]');
    if (authorEl) authorEl.textContent = h.doc.metadata.author ?? "";
    if (dateEl) dateEl.textContent = h.doc.metadata.date ?? "";
  }
  const slideEl = h.root.querySelector<HTMLElement>(".slide");
  if (slideEl) applyReveal(slideEl, h.state.reveal);
  updateUrlHash(h.state);
}

function attachKeyHandler(h: RenderHandle) {
  document.addEventListener("keydown", ev => {
    if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
    let handled = true;
    switch (ev.key) {
      case "ArrowRight":
      case " ":
        nextReveal(h); break;
      case "ArrowLeft":
        prevReveal(h); break;
      case "ArrowDown":
      case "PageDown":
        nextSlide(h); break;
      case "ArrowUp":
      case "PageUp":
        prevSlide(h); break;
      case "Home":
        h.state.slide = 0; h.state.reveal = 1; renderCurrent(h); break;
      case "End":
        h.state.slide = h.effectiveSlides.length - 1;
        h.state.reveal = h.effectiveSlides[h.state.slide]!.slide.overlayCount;
        renderCurrent(h); break;
      default: handled = false;
    }
    if (handled) ev.preventDefault();
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
  h.state.slide++; h.state.reveal = 1; renderCurrent(h);
}

function prevSlide(h: RenderHandle) {
  if (h.state.slide <= 0) return;
  h.state.slide--; h.state.reveal = 1; renderCurrent(h);
}

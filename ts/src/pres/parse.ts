import type { Block, CodeOpt, Doc, Segment, Slide, Span } from "./types.js";

type Tok =
  | { kind: "text"; text: string }
  | { kind: "cmd"; name: string; body: string | null; opts: string[] | null };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let textBuf = "";
  const flushText = () => {
    if (textBuf.length > 0) { toks.push({ kind: "text", text: textBuf }); textBuf = ""; }
  };

  while (i < src.length) {
    if (src[i] === "[" && src[i + 1] !== "%") {
      // Try to read a [name] command.
      const end = src.indexOf("]", i + 1);
      if (end < 0) { textBuf += src[i++]!; continue; }
      const name = src.slice(i + 1, end);
      if (!/^[a-zA-Z][\w-]*$/.test(name)) { textBuf += src[i++]!; continue; }
      let j = end + 1;
      let body: string | null = null;
      let opts: string[] | null = null;
      if (src[j] === "[" && src[j + 1] === "%") {
        const b = readBody(src, j);
        if (b === null) { textBuf += src[i++]!; continue; }
        body = b.body;
        j = b.next;
      }
      if (src[j] === "[" && src[j + 1] !== "%") {
        const optEnd = src.indexOf("]", j + 1);
        if (optEnd >= 0) {
          const inner = src.slice(j + 1, optEnd);
          if (/^[\w,\s-]*$/.test(inner)) {
            opts = inner.split(",").map(s => s.trim()).filter(Boolean);
            j = optEnd + 1;
          }
        }
      }
      flushText();
      toks.push({ kind: "cmd", name, body, opts });
      i = j;
    } else {
      textBuf += src[i++]!;
    }
  }
  flushText();
  return toks;
}

function readBody(src: string, start: number): { body: string; next: number } | null {
  // src[start] === '[', src[start+1] === '%'
  let depth = 1;
  let i = start + 2;
  let out = "";
  while (i < src.length) {
    if (src[i] === "[" && src[i + 1] === "%") { depth++; out += "[%"; i += 2; continue; }
    if (src[i] === "%" && src[i + 1] === "]") {
      depth--;
      if (depth === 0) return { body: out, next: i + 2 };
      out += "%]"; i += 2; continue;
    }
    out += src[i++]!;
  }
  return null;
}

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function resolveMetaValue(s: string): string {
  return s.trim().replace(/\[today\]/g, todayStr());
}

function parseMetadata(body: string, meta: Doc["metadata"]) {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = resolveMetaValue(m[2]!);
    if (key === "title" || key === "author" || key === "date") meta[key] = value;
    else if (key === "mode" && (value === "light" || value === "dark")) meta.mode = value;
  }
}

type Builder = {
  blocks: Block[];
  reveal: number;
  pendingPara: Span[] | null;
  pendingList: Span[][] | null;
  pendingItem: Span[] | null;
};

function newBuilder(): Builder {
  return { blocks: [], reveal: 1, pendingPara: null, pendingList: null, pendingItem: null };
}

function flushPara(b: Builder) {
  if (b.pendingPara && b.pendingPara.length > 0) {
    const allBlank = b.pendingPara.every(s => s.text.trim() === "");
    if (!allBlank) {
      // Trim leading/trailing whitespace from edge spans.
      const spans = b.pendingPara;
      if (spans[0]) spans[0]!.text = spans[0]!.text.replace(/^\s+/, "");
      const last = spans[spans.length - 1];
      if (last) last.text = last.text.replace(/\s+$/, "");
      b.blocks.push({ kind: "para", spans });
    }
  }
  b.pendingPara = null;
}

function flushList(b: Builder) {
  if (b.pendingItem) {
    b.pendingList!.push(b.pendingItem);
    b.pendingItem = null;
  }
  if (b.pendingList && b.pendingList.length > 0) {
    b.blocks.push({ kind: "list", items: b.pendingList });
  }
  b.pendingList = null;
}

function flushAll(b: Builder) {
  flushPara(b);
  flushList(b);
}

function pushSpan(target: Span[], text: string, reveal: number) {
  if (text.length === 0) return;
  const last = target[target.length - 1];
  if (last && last.reveal === reveal) last.text += text;
  else target.push({ text, reveal });
}

// Append a text run from a `Text` token to the current block context,
// splitting on newlines to handle list-item starts.
function appendText(b: Builder, text: string) {
  // Split on newlines but keep them as separators.
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const isLastSegment = k === lines.length - 1;
    let line = lines[k]!;

    // For each segment except the first, we're at the start of a fresh line.
    // For the first segment, we're continuing whatever line context we were in.
    if (k > 0) onLineBoundary(b);

    if (k > 0 && /^\s*-\s/.test(line)) {
      // Start of a list item.
      flushPara(b);
      if (!b.pendingList) b.pendingList = [];
      if (b.pendingItem) b.pendingList.push(b.pendingItem);
      b.pendingItem = [];
      line = line.replace(/^\s*-\s/, "");
      pushSpan(b.pendingItem, line, b.reveal);
    } else if (b.pendingItem) {
      // Continuing a list item across token boundary or wrapped text.
      if (k === 0) pushSpan(b.pendingItem, line, b.reveal);
      else {
        // A plain non-bullet line breaks the list.
        if (line.trim() === "") continue;
        flushList(b);
        if (!b.pendingPara) b.pendingPara = [];
        pushSpan(b.pendingPara, line, b.reveal);
      }
    } else {
      if (line.trim() === "" && k > 0) {
        // Blank line ends a paragraph but is otherwise not structural.
        flushPara(b);
        continue;
      }
      if (k === 0 && /^\s*-\s/.test(line) && !b.pendingPara) {
        flushPara(b);
        if (!b.pendingList) b.pendingList = [];
        b.pendingItem = [];
        line = line.replace(/^\s*-\s/, "");
        pushSpan(b.pendingItem, line, b.reveal);
      } else {
        if (!b.pendingPara) b.pendingPara = [];
        pushSpan(b.pendingPara, line, b.reveal);
      }
    }

    if (!isLastSegment) {
      // We consumed a "\n"; treat as whitespace separator inside the
      // current open block.
      if (b.pendingItem) {
        // Newline within a list item — drop it (text wraps naturally).
        // But if the next line starts a new item, the k>0 branch handles it.
      } else if (b.pendingPara) {
        pushSpan(b.pendingPara, " ", b.reveal);
      }
    }
  }
}

function onLineBoundary(_b: Builder) {
  // Hook in case we later want stricter line-boundary semantics.
}

function parseCodeBody(body: string): { segments: Segment[]; addedPauses: number } {
  // Split on [pause] commands; ignore other bracket commands (treat as literal).
  const segments: Segment[] = [];
  let reveal = 1;
  let buf = "";
  let i = 0;
  let pauseCount = 0;
  while (i < body.length) {
    if (body.startsWith("[pause]", i)) {
      if (buf.length > 0) { segments.push({ text: buf, reveal }); buf = ""; }
      reveal++;
      pauseCount++;
      i += "[pause]".length;
    } else {
      buf += body[i++]!;
    }
  }
  if (buf.length > 0) segments.push({ text: buf, reveal });
  return { segments, addedPauses: pauseCount };
}

export function parse(src: string): Doc {
  const toks = tokenize(src);
  const meta: Doc["metadata"] = {};
  const slides: Slide[] = [];

  let cur: { title: string; builder: Builder } | null = null;
  const openSlide = (title: string) => {
    if (cur) closeSlide();
    cur = { title, builder: newBuilder() };
  };
  const closeSlide = () => {
    if (!cur) return;
    flushAll(cur.builder);
    const overlayCount = Math.max(1, cur.builder.reveal);
    slides.push({ title: cur.title, blocks: cur.builder.blocks, overlayCount });
    cur = null;
  };

  const needCur = (): { title: string; builder: Builder } => {
    if (!cur) openSlide("");
    return cur as { title: string; builder: Builder };
  };

  for (const tok of toks) {
    if (tok.kind === "text") {
      if (!cur && tok.text.trim() === "") continue;
      appendText(needCur().builder, tok.text);
      continue;
    }
    // cmd
    if (tok.name === "metadata") {
      if (tok.body !== null) parseMetadata(tok.body, meta);
      continue;
    }
    if (tok.name === "slide") {
      const title = (tok.body ?? "").trim();
      openSlide(title);
      continue;
    }
    if (tok.name === "pause") {
      if (!cur) continue;
      needCur().builder.reveal++;
      continue;
    }
    if (tok.name === "code") {
      const c = needCur();
      flushAll(c.builder);
      const { segments, addedPauses } = parseCodeBody(tok.body ?? "");
      if (segments.length > 0) {
        segments[0]!.text = segments[0]!.text.replace(/^\n/, "");
        const last = segments[segments.length - 1]!;
        last.text = last.text.replace(/\n$/, "");
      }
      const base = c.builder.reveal - 1;
      const shifted = segments.map(s => ({ text: s.text, reveal: s.reveal + base }));
      const opts: CodeOpt[] = [];
      for (const o of tok.opts ?? []) {
        if (o === "timeline" || o === "tuples") opts.push(o);
      }
      c.builder.blocks.push({ kind: "code", segments: shifted, opts });
      c.builder.reveal += addedPauses;
      continue;
    }
    if (tok.name === "today") {
      if (!cur) continue;
      appendText(needCur().builder, todayStr());
      continue;
    }
    // Unknown command: ignore for now.
  }
  closeSlide();

  // Drop the synthetic empty-title slide if it has no blocks (pre-slide
  // whitespace only).
  while (slides.length > 0 && slides[0]!.title === "" && slides[0]!.blocks.length === 0) {
    slides.shift();
  }

  return { metadata: meta, slides };
}

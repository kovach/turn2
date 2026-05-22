import type { Block, CodeOpt, Doc, ListItem, Segment, Slide, Span } from "./types.js";

type Tok =
  | { kind: "text"; text: string }
  | { kind: "inlineCode"; text: string }
  | { kind: "cmd"; name: string; body: string | null; bodyOffset: number; opts: string[] | null };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let textBuf = "";
  const flushText = () => {
    if (textBuf.length > 0) { toks.push({ kind: "text", text: textBuf }); textBuf = ""; }
  };

  while (i < src.length) {
    if (src[i] === "[" && src[i + 1] === "%") {
      // Bare body — inline code.
      const b = readBody(src, i);
      if (b === null) { textBuf += src[i++]!; continue; }
      flushText();
      toks.push({ kind: "inlineCode", text: b.body });
      i = b.next;
      continue;
    }
    if (src[i] === "[") {
      // Try to read a [name] command.
      const end = src.indexOf("]", i + 1);
      if (end < 0) { textBuf += src[i++]!; continue; }
      const name = src.slice(i + 1, end);
      if (!/^[a-zA-Z][\w-]*$/.test(name)) { textBuf += src[i++]!; continue; }
      let j = end + 1;
      let body: string | null = null;
      let bodyOffset = -1;
      let opts: string[] | null = null;
      if (src[j] === "[" && src[j + 1] === "%") {
        const b = readBody(src, j);
        if (b === null) { textBuf += src[i++]!; continue; }
        body = b.body;
        bodyOffset = j + 2;
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
      toks.push({ kind: "cmd", name, body, bodyOffset, opts });
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
    else if (key === "theme" && (value === "light" || value === "dark")) meta.theme = value;
  }
}

// Split a text run into bold/italic-aware spans.
function emitFormattedText(target: Span[], text: string, reveal: number): void {
  let bold = false;
  let italic = false;
  let buf = "";
  const flush = () => {
    if (buf.length === 0) return;
    const span: Span = { text: buf, reveal };
    if (bold) span.bold = true;
    if (italic) span.italic = true;
    target.push(span);
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === "*" && text[i + 1] === "*") {
      flush();
      bold = !bold;
      i += 2;
    } else if (text[i] === "*") {
      flush();
      italic = !italic;
      i++;
    } else {
      buf += text[i++]!;
    }
  }
  flush();
}

function pushInlineCode(target: Span[], text: string, reveal: number) {
  if (text.length === 0) return;
  target.push({ text, reveal, code: true });
}

type Builder = {
  blocks: Block[];
  reveal: number;
  pendingPara: Span[] | null;
  // Flat list of items with level info; renderer turns into nested <ul>s.
  pendingList: ListItem[] | null;
  pendingItem: ListItem | null;
  // Whether the next text fragment is at the start of a fresh line.
  atLineStart: boolean;
};

function newBuilder(): Builder {
  return {
    blocks: [], reveal: 1,
    pendingPara: null, pendingList: null, pendingItem: null,
    atLineStart: true,
  };
}

function flushPara(b: Builder) {
  if (b.pendingPara && b.pendingPara.length > 0) {
    const allBlank = b.pendingPara.every(s => s.text.trim() === "");
    if (!allBlank) {
      const spans = b.pendingPara;
      const first = spans[0];
      if (first) first.text = first.text.replace(/^\s+/, "");
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

const BULLET_RE = /^([ \t]*)-\s+(.*)$/;

// Determine if a line starts a bullet, returning indent and rest.
function matchBullet(line: string): { level: number; rest: string } | null {
  const m = line.match(BULLET_RE);
  if (!m) return null;
  // 2 spaces per level; tabs count as 2 each.
  const spaces = m[1]!.replace(/\t/g, "  ").length;
  const level = Math.floor(spaces / 2) + 1;
  return { level, rest: m[2]! };
}

// Process a complete line (its text and inline-code fragments) into builder.
// `fragments` is the sequence of inline text/code fragments that make up the
// line, in order; reveal carries per fragment.
type Frag = { kind: "text" | "code"; text: string; reveal: number };

function handleLine(b: Builder, fragments: Frag[], lineRaw: string): void {
  // Detect bullet using the raw text-only join (we treat inline-code as plain
  // for bullet detection; bullets are rare-mixed with code at line start).
  const bullet = matchBullet(lineRaw);
  if (bullet) {
    flushPara(b);
    if (!b.pendingList) b.pendingList = [];
    if (b.pendingItem) b.pendingList.push(b.pendingItem);
    const reveal = fragments.find(f => f.text.trim() !== "")?.reveal ?? b.reveal;
    b.pendingItem = { spans: [], level: bullet.level, reveal };
    // Emit the rest of the bullet line: replay fragments but trim the
    // leading `[ \t]*-\s+` from the first text fragment.
    let trimmedFirst = false;
    for (const f of fragments) {
      let t = f.text;
      if (!trimmedFirst && f.kind === "text") {
        const m = t.match(BULLET_RE);
        if (m) { t = m[2]!; trimmedFirst = true; }
        else continue; // shouldn't happen
      }
      if (f.kind === "text") emitFormattedText(b.pendingItem.spans, t, f.reveal);
      else pushInlineCode(b.pendingItem.spans, t, f.reveal);
    }
    return;
  }

  // Continuation of an existing list item (indented non-bullet line):
  // append to current item's spans.
  if (b.pendingItem && lineRaw.trim() !== "") {
    for (const f of fragments) {
      if (f.kind === "text") emitFormattedText(b.pendingItem.spans, f.text, f.reveal);
      else pushInlineCode(b.pendingItem.spans, f.text, f.reveal);
    }
    return;
  }

  // Blank line: ends para or list.
  if (lineRaw.trim() === "") {
    flushPara(b);
    flushList(b);
    return;
  }

  // Plain paragraph line. End any open list.
  if (b.pendingList) flushList(b);
  if (!b.pendingPara) b.pendingPara = [];
  for (const f of fragments) {
    if (f.kind === "text") emitFormattedText(b.pendingPara, f.text, f.reveal);
    else pushInlineCode(b.pendingPara, f.text, f.reveal);
  }
  // Preserve inter-line whitespace as a single space.
  if (b.pendingPara.length > 0) {
    const last = b.pendingPara[b.pendingPara.length - 1]!;
    if (!/\s$/.test(last.text)) last.text += " ";
  }
}

// Buffer fragments per line and emit them via handleLine on each newline.
type LineBuf = { frags: Frag[]; text: string };

function newLineBuf(): LineBuf { return { frags: [], text: "" }; }

function appendFragToLine(buf: LineBuf, kind: "text" | "code", text: string, reveal: number) {
  if (text.length === 0) return;
  buf.frags.push({ kind, text, reveal });
  buf.text += text;
}

function emitInlineCode(b: Builder, lineBuf: LineBuf, text: string) {
  appendFragToLine(lineBuf, "code", text, b.reveal);
  b.atLineStart = false;
}

function feedText(b: Builder, lineBuf: LineBuf, text: string,
                  emitLine: () => void): void {
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const piece = lines[k]!;
    appendFragToLine(lineBuf, "text", piece, b.reveal);
    if (piece.length > 0) b.atLineStart = false;
    if (k < lines.length - 1) {
      // Newline boundary.
      emitLine();
      lineBuf.frags = [];
      lineBuf.text = "";
      b.atLineStart = true;
    }
  }
}

function parseCodeBody(body: string): { segments: Segment[]; addedPauses: number } {
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

  let cur: { title: string; builder: Builder; lineBuf: LineBuf } | null = null;
  const openSlide = (title: string) => {
    if (cur) closeSlide();
    cur = { title, builder: newBuilder(), lineBuf: newLineBuf() };
  };
  const closeSlide = () => {
    if (!cur) return;
    // Flush any open line as a final paragraph/list line.
    if (cur.lineBuf.frags.length > 0) {
      handleLine(cur.builder, cur.lineBuf.frags, cur.lineBuf.text);
    }
    flushAll(cur.builder);
    const overlayCount = Math.max(1, cur.builder.reveal);
    slides.push({ title: cur.title, blocks: cur.builder.blocks, overlayCount });
    cur = null;
  };

  const need = () => {
    if (!cur) openSlide("");
    return cur as { title: string; builder: Builder; lineBuf: LineBuf };
  };

  const flushLine = () => {
    const c = cur!;
    handleLine(c.builder, c.lineBuf.frags, c.lineBuf.text);
  };

  for (const tok of toks) {
    if (tok.kind === "text") {
      if (!cur && tok.text.trim() === "") continue;
      const c = need();
      feedText(c.builder, c.lineBuf, tok.text, flushLine);
      continue;
    }
    if (tok.kind === "inlineCode") {
      const c = need();
      emitInlineCode(c.builder, c.lineBuf, tok.text);
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
      need().builder.reveal++;
      continue;
    }
    if (tok.name === "code") {
      const c = need();
      // Flush any in-progress line first.
      if (c.lineBuf.frags.length > 0) {
        handleLine(c.builder, c.lineBuf.frags, c.lineBuf.text);
        c.lineBuf = newLineBuf();
      }
      flushAll(c.builder);
      const hasCode = c.builder.blocks.some(b => b.kind === "code");
      if (hasCode) {
        throw new Error(`slide "${c.title}" has more than one [code] block (only one allowed per slide)`);
      }
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
    if (tok.name === "svg") {
      const c = need();
      if (c.lineBuf.frags.length > 0) {
        handleLine(c.builder, c.lineBuf.frags, c.lineBuf.text);
        c.lineBuf = newLineBuf();
      }
      flushAll(c.builder);
      const body = tok.body ?? "";
      if (body.includes("[%") || body.includes("%]")) {
        throw new Error(`[svg] body in slide "${c.title}" may not contain nested [% or %]`);
      }
      const dynamic = (tok.opts ?? []).includes("dynamic-svg");
      c.builder.blocks.push({
        kind: "svg",
        body,
        bodyOffset: tok.bodyOffset,
        reveal: c.builder.reveal,
        dynamic,
      });
      continue;
    }
    if (tok.name === "today") {
      const c = need();
      feedText(c.builder, c.lineBuf, todayStr(), flushLine);
      continue;
    }
    // Unknown command: ignore.
  }
  closeSlide();

  while (slides.length > 0 && slides[0]!.title === "" && slides[0]!.blocks.length === 0) {
    slides.shift();
  }

  return { metadata: meta, slides };
}

export type SaveBackend = "none" | "server" | "url-param";

export interface EditorOptions {
  host?: HTMLElement;
  existing?: HTMLTextAreaElement;
  initial?: string;
  saveBackend: SaveBackend;
  saveTarget?: string;
  onChange?: (value: string) => void;
  autoGrow?: boolean;
}

const SAVE_DEBOUNCE_MS = 400;

export class Editor {
  private readonly ta: HTMLTextAreaElement;
  private readonly wrap: HTMLElement;
  private readonly gutterEl: HTMLElement;
  private readonly opts: EditorOptions;
  private readonly adopted: boolean;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly keyHandler: (ev: KeyboardEvent) => void;
  private readonly inputHandler: () => void;
  private readonly scrollHandler: () => void;
  private lastLineCount = 0;

  constructor(opts: EditorOptions) {
    this.opts = opts;
    if (opts.existing) {
      this.ta = opts.existing;
      this.adopted = true;
      if (opts.initial !== undefined) this.ta.value = opts.initial;
      const parent = this.ta.parentNode;
      if (!parent) throw new Error("Editor: existing textarea has no parent");
      this.wrap = document.createElement("div");
      this.wrap.className = "editor-wrap";
      parent.insertBefore(this.wrap, this.ta);
      this.gutterEl = document.createElement("div");
      this.gutterEl.className = "editor-gutter";
      this.gutterEl.setAttribute("aria-hidden", "true");
      this.wrap.appendChild(this.gutterEl);
      this.wrap.appendChild(this.ta);
    } else {
      if (!opts.host) throw new Error("Editor: host or existing required");
      this.ta = document.createElement("textarea");
      this.ta.className = "editor-textarea";
      this.ta.value = opts.initial ?? "";
      this.ta.spellcheck = false;
      this.ta.autocapitalize = "off";
      this.ta.autocomplete = "off";
      this.wrap = document.createElement("div");
      this.wrap.className = "editor-wrap";
      this.gutterEl = document.createElement("div");
      this.gutterEl.className = "editor-gutter";
      this.gutterEl.setAttribute("aria-hidden", "true");
      this.wrap.appendChild(this.gutterEl);
      this.wrap.appendChild(this.ta);
      opts.host.appendChild(this.wrap);
      this.adopted = false;
    }

    this.keyHandler = (ev) => this.onKeyDown(ev);
    this.inputHandler = () => this.onInput();
    this.scrollHandler = () => { this.gutterEl.scrollTop = this.ta.scrollTop; };
    this.ta.addEventListener("keydown", this.keyHandler);
    this.ta.addEventListener("input", this.inputHandler);
    this.ta.addEventListener("scroll", this.scrollHandler);

    this.rebuildGutter();

    if (opts.autoGrow) {
      this.ta.style.overflowY = "hidden";
      this.ta.style.resize = "none";
      queueMicrotask(() => this.fitHeight());
    }
  }

  get value(): string { return this.ta.value; }
  set value(v: string) {
    this.ta.value = v;
    this.rebuildGutter();
    if (this.opts.autoGrow) this.fitHeight();
  }
  get element(): HTMLTextAreaElement { return this.ta; }
  focus(): void { this.ta.focus(); }

  destroy(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.ta.removeEventListener("keydown", this.keyHandler);
    this.ta.removeEventListener("input", this.inputHandler);
    this.ta.removeEventListener("scroll", this.scrollHandler);
    if (!this.adopted) this.wrap.remove();
  }

  private onInput(): void {
    this.rebuildGutter();
    if (this.opts.autoGrow) this.fitHeight();
    if (this.opts.onChange) this.opts.onChange(this.ta.value);
    this.scheduleSave();
  }

  private fitHeight(): void {
    this.ta.style.height = "auto";
    this.ta.style.height = this.ta.scrollHeight + "px";
    this.gutterEl.style.height = this.ta.style.height;
  }

  private rebuildGutter(): void {
    const value = this.ta.value;
    let n = 1;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) n++;
    if (n === this.lastLineCount) return;
    if (n > this.lastLineCount) {
      for (let i = this.lastLineCount; i < n; i++) {
        const row = document.createElement("div");
        row.textContent = String(i + 1);
        this.gutterEl.appendChild(row);
      }
    } else {
      while (this.gutterEl.childNodes.length > n) {
        this.gutterEl.removeChild(this.gutterEl.lastChild!);
      }
    }
    this.lastLineCount = n;
  }

  // Replace [start, end) in the textarea with `text`, going through
  // execCommand so the edit lands on the native undo stack and the input
  // event fires.
  private replaceRange(start: number, end: number, text: string, caret: number): void {
    this.ta.focus();
    this.ta.setSelectionRange(start, end);
    document.execCommand("insertText", false, text);
    this.ta.setSelectionRange(caret, caret);
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.ta.blur();
      return;
    }
    if (ev.key === "Tab") {
      ev.preventDefault();
      this.indentSelection(ev.shiftKey);
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      this.insertAutoIndent();
      return;
    }
    if (ev.key === "Home" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      this.smartHome(ev.shiftKey);
      return;
    }
    if (ev.key === "Delete" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (this.smartDelete()) ev.preventDefault();
      return;
    }
  }

  private indentSelection(dedent: boolean): void {
    const value = this.ta.value;
    const selStart = this.ta.selectionStart;
    const selEnd = this.ta.selectionEnd;
    const first = lineBoundsAt(value, selStart);
    const last = lineBoundsAt(value, selEnd);
    const start = first.start;
    const endLine = last.end;
    const slice = value.slice(start, endLine);
    const lines = slice.split("\n");
    const lineStartsOrig: number[] = [];
    let cur = start;
    for (const ln of lines) {
      lineStartsOrig.push(cur);
      cur += ln.length + 1;
    }
    const deltas: number[] = lines.map((ln) => {
      if (dedent) {
        if (ln.startsWith("  ")) return -2;
        if (ln.startsWith(" ")) return -1;
        return 0;
      }
      return 2;
    });
    const out = lines.map((ln, i) => (dedent ? ln.slice(-deltas[i]!) : "  " + ln));
    const replacement = out.join("\n");

    const mapOffset = (p: number): number => {
      if (p < start) return p;
      if (p > endLine) return p + (replacement.length - slice.length);
      let shift = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineStart = lineStartsOrig[i]!;
        const lineEnd = lineStart + lines[i]!.length;
        if (p > lineEnd) { shift += deltas[i]!; continue; }
        if (dedent) {
          const removed = -deltas[i]!;
          const colWithin = p - lineStart;
          shift -= Math.min(colWithin, removed);
        } else {
          shift += 2;
        }
        break;
      }
      return p + shift;
    };

    const newStart = mapOffset(selStart);
    const newEnd = mapOffset(selEnd);
    this.ta.focus();
    this.ta.setSelectionRange(start, endLine);
    document.execCommand("insertText", false, replacement);
    this.ta.setSelectionRange(newStart, newEnd);
  }

  private insertAutoIndent(): void {
    const value = this.ta.value;
    const pos = this.ta.selectionStart;
    const { start, end } = lineBoundsAt(value, pos);
    const line = value.slice(start, end);
    this.ta.focus();
    if (line.length > 0 && /^[ \t]+$/.test(line)) {
      // Whitespace-only line: wipe before inserting so the new line starts
      // at column 0 rather than inheriting stale indent.
      this.ta.setSelectionRange(start, end);
      document.execCommand("insertText", false, "\n");
      return;
    }
    const lineToCursor = value.slice(start, pos);
    const indentMatch = lineToCursor.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : "";
    document.execCommand("insertText", false, "\n" + indent);
  }

  private smartHome(shift: boolean): void {
    const value = this.ta.value;
    const selStart = this.ta.selectionStart;
    const selEnd = this.ta.selectionEnd;
    const dir = this.ta.selectionDirection;
    const pos = dir === "backward" ? selStart : selEnd;
    const anchor = dir === "backward" ? selEnd : selStart;
    const { start } = lineBoundsAt(value, pos);
    const before = value.slice(start, pos);
    const indentMatch = value.slice(start).match(/^[ \t]*/);
    const indentEnd = start + (indentMatch ? indentMatch[0].length : 0);
    const target = /^[ \t]*$/.test(before) ? start : indentEnd;
    if (shift) {
      const lo = Math.min(anchor, target);
      const hi = Math.max(anchor, target);
      this.ta.setSelectionRange(lo, hi, target < anchor ? "backward" : "forward");
    } else {
      this.ta.setSelectionRange(target, target);
    }
  }

  // Returns true if it consumed the key.
  private smartDelete(): boolean {
    const value = this.ta.value;
    const selStart = this.ta.selectionStart;
    const selEnd = this.ta.selectionEnd;
    if (selStart !== selEnd) return false;
    const { end } = lineBoundsAt(value, selStart);
    if (selStart !== end) return false;
    if (end >= value.length || value[end] !== "\n") return false;
    const wsMatch = value.slice(end + 1).match(/^[ \t]*/);
    const wsLen = wsMatch ? wsMatch[0].length : 0;
    this.replaceRange(end, end + 1 + wsLen, "", end);
    return true;
  }

  private scheduleSave(): void {
    if (this.opts.saveBackend === "none") return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private flushSave(): void {
    if (this.opts.saveBackend === "url-param") {
      const target = this.opts.saveTarget ?? "code";
      const url = new URL(window.location.href);
      url.searchParams.set(target, b64UrlEncode(this.ta.value));
      window.history.replaceState(null, "", url.toString());
      return;
    }
    if (this.opts.saveBackend === "server") {
      const name = this.opts.saveTarget;
      if (!name) return;
      void fetch(`/api/v2-file/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: this.ta.value,
      });
    }
  }
}

function lineBoundsAt(value: string, pos: number): { start: number; end: number } {
  const start = value.lastIndexOf("\n", pos - 1) + 1;
  const eol = value.indexOf("\n", pos);
  const end = eol < 0 ? value.length : eol;
  return { start, end };
}

function b64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

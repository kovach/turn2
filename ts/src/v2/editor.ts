import { suggestionsFor } from "./autocomplete.js";

export type SaveBackend = "none" | "server" | "url-param";

export interface EditorOptions {
  host?: HTMLElement;
  existing?: HTMLTextAreaElement;
  initial?: string;
  saveBackend: SaveBackend;
  saveTarget?: string;
  onChange?: (value: string) => void;
  autoGrow?: boolean;
  // Symbol/variable completion overlay (plans/v2-editor-autocomplete.md).
  // Default off; index-v2 opts in, pres leaves it off.
  enableAutocomplete?: boolean;
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
  private readonly mouseDownHandler: (ev: MouseEvent) => void;
  private readonly keyUpHandler: (ev: KeyboardEvent) => void;
  private readonly blurHandler: () => void;
  private lastLineCount = 0;
  private _frozen = false;

  // Autocomplete state. `acBox`/`acMirror` are created lazily on first show.
  private readonly acEnabled: boolean;
  private acBox: HTMLDivElement | null = null;
  private acMirror: HTMLDivElement | null = null;
  private acItems: string[] = [];
  private acToken: { start: number; end: number } | null = null;

  constructor(opts: EditorOptions) {
    this.opts = opts;
    if (opts.existing) {
      this.ta = opts.existing;
      this.adopted = true;
      this.ta.classList.add("editor-textarea");
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

    this.acEnabled = opts.enableAutocomplete ?? false;

    this.keyHandler = (ev) => this.onKeyDown(ev);
    this.inputHandler = () => this.onInput();
    this.scrollHandler = () => {
      this.gutterEl.scrollTop = this.ta.scrollTop;
      if (this.acEnabled) this.hideAutocomplete();
    };
    this.mouseDownHandler = (ev) => {
      if (this._frozen) ev.preventDefault();
    };
    // Only refresh the completion box after the keystrokes that build a token:
    // a bare character key (no Ctrl/Meta/Alt modifier) or Backspace. Any other
    // key (caret movement, Enter, shortcuts, etc.) dismisses the box rather
    // than leaving a stale one up. Releases of a bare modifier are ignored, so
    // the Shift-up that ends an uppercase keystroke doesn't kill the box the
    // letter just opened. This keeps the per-keystroke parse/tokenize off the
    // input path while ensuring the box never lingers.
    this.keyUpHandler = (ev) => {
      if (MODIFIER_KEYS.has(ev.key)) return;
      const isChar = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
      if (isChar || ev.key === "Backspace") this.updateAutocomplete();
      else this.hideAutocomplete();
    };
    this.blurHandler = () => this.hideAutocomplete();
    this.ta.addEventListener("keydown", this.keyHandler);
    this.ta.addEventListener("input", this.inputHandler);
    this.ta.addEventListener("scroll", this.scrollHandler);
    this.ta.addEventListener("mousedown", this.mouseDownHandler);
    if (this.acEnabled) {
      this.ta.addEventListener("keyup", this.keyUpHandler);
      this.ta.addEventListener("blur", this.blurHandler);
    }

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

  get frozen(): boolean { return this._frozen; }
  setFrozen(v: boolean): void {
    if (this._frozen === v) return;
    this._frozen = v;
    this.ta.readOnly = v;
    this.ta.classList.toggle("editor-frozen", v);
    if (v && document.activeElement === this.ta) this.ta.blur();
  }

  destroy(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.ta.removeEventListener("keydown", this.keyHandler);
    this.ta.removeEventListener("input", this.inputHandler);
    this.ta.removeEventListener("scroll", this.scrollHandler);
    this.ta.removeEventListener("mousedown", this.mouseDownHandler);
    this.ta.removeEventListener("keyup", this.keyUpHandler);
    this.ta.removeEventListener("blur", this.blurHandler);
    this.acBox?.remove();
    this.acMirror?.remove();
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
    if (this._frozen) {
      // Escape still blurs; everything else: let readOnly drop it.
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.ta.blur();
      }
      return;
    }
    // When the completion box is visible: Tab accepts the first entry, Escape
    // dismisses the box (without blurring). Other keys fall through.
    if (this.acEnabled && this.acBox && this.acItems.length > 0) {
      if (ev.key === "Tab") {
        ev.preventDefault();
        this.acceptFirstCompletion();
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.hideAutocomplete();
        return;
      }
    }
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

  // --- autocomplete ---------------------------------------------------------

  // The partial token the cursor sits at the right end of, or null when no box
  // should show (selection present, cursor not at a token's right edge, empty
  // run, or only a bare marker to the left).
  private currentToken(): { text: string; start: number; end: number } | null {
    const ta = this.ta;
    if (ta.selectionStart !== ta.selectionEnd) return null;
    const pos = ta.selectionStart;
    const value = ta.value;
    // Right edge: whitespace or end-of-text immediately to the right.
    if (pos < value.length && !/\s/.test(value[pos]!)) return null;
    // Scan left over token chars (everything but whitespace / structural
    // separators).
    let start = pos;
    while (start > 0 && !AC_SEP.test(value[start - 1]!)) start--;
    if (start === pos) return null; // nothing to the left
    // Strip a leading literal-type marker when the run begins at the line's
    // first non-whitespace column (e.g. `-foo` typed without a space).
    const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
    const indentLen = value.slice(lineStart).match(/^[ \t]*/)![0]!.length;
    if (start === lineStart + indentLen && isMarkerCh(value[start]!)) start++;
    if (start >= pos) return null;
    return { text: value.slice(start, pos), start, end: pos };
  }

  private updateAutocomplete(): void {
    if (!this.acEnabled || this._frozen) { this.hideAutocomplete(); return; }
    const tok = this.currentToken();
    if (!tok) { this.hideAutocomplete(); return; }
    const value = this.ta.value;
    // Blank out the in-progress token (same length, so offsets/line numbers are
    // preserved) before gathering candidates: otherwise the token counts as its
    // own program symbol/rule variable and exact-matches itself, suppressing the
    // box. Other occurrences of the same name survive, so a genuinely-complete
    // token is still suppressed correctly.
    const masked = value.slice(0, tok.start) + " ".repeat(tok.end - tok.start) + value.slice(tok.end);
    const items = suggestionsFor(masked, tok.text, lineNumberAt(value, tok.start));
    if (items.length === 0) { this.hideAutocomplete(); return; }
    this.acItems = items;
    this.acToken = { start: tok.start, end: tok.end };
    this.showAutocomplete(tok.start, items);
  }

  private showAutocomplete(tokenStart: number, items: string[]): void {
    if (!this.acBox) {
      this.acBox = document.createElement("div");
      this.acBox.className = "editor-autocomplete";
      this.acBox.setAttribute("aria-hidden", "true");
      this.wrap.appendChild(this.acBox);
    }
    const box = this.acBox;
    box.textContent = "";
    items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "editor-autocomplete-item" + (i === 0 ? " is-first" : "");
      row.textContent = it;
      box.appendChild(row);
    });
    const { left, top } = this.caretCoords(tokenStart);
    box.style.left = left + "px";
    box.style.top = top + "px";
    box.style.display = "block";
  }

  private hideAutocomplete(): void {
    this.acItems = [];
    this.acToken = null;
    if (this.acBox) this.acBox.style.display = "none";
  }

  private acceptFirstCompletion(): void {
    const tok = this.acToken;
    const first = this.acItems[0];
    if (!tok || first === undefined) return;
    this.hideAutocomplete();
    this.replaceRange(tok.start, tok.end, first, tok.start + first.length);
  }

  // Pixel position (relative to `this.wrap`) of the caret at offset `pos`,
  // via an off-screen mirror that replicates the textarea's text metrics.
  private caretCoords(pos: number): { left: number; top: number } {
    const ta = this.ta;
    if (!this.acMirror) {
      this.acMirror = document.createElement("div");
      this.acMirror.className = "editor-autocomplete-mirror";
      this.wrap.appendChild(this.acMirror);
    }
    const mirror = this.acMirror;
    const cs = getComputedStyle(ta);
    for (const p of AC_MIRROR_PROPS) mirror.style.setProperty(p, cs.getPropertyValue(p));
    mirror.style.width = ta.clientWidth + "px";
    mirror.style.left = ta.offsetLeft + "px";
    mirror.style.top = ta.offsetTop + "px";
    mirror.textContent = ta.value.slice(0, pos);
    const marker = document.createElement("span");
    marker.textContent = "​";
    mirror.appendChild(marker);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const left = ta.offsetLeft + marker.offsetLeft - ta.scrollLeft;
    const top = ta.offsetTop + marker.offsetTop - ta.scrollTop + lineH;
    return { left, top };
  }
}

// Token-run separators: whitespace plus the structural punctuation the lexer
// breaks on. A symbol/variable token is a maximal run of non-separator chars.
const AC_SEP = /[\s(),.;]/;

// Bare modifier keys: their keyup must neither refresh nor dismiss the box, so
// the Shift-up ending an uppercase keystroke doesn't close what the letter
// opened.
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

function isMarkerCh(ch: string): boolean {
  return ch === "-" || ch === "~" || ch === "+" || ch === "^" || ch === "!" || ch === "?";
}

function lineNumberAt(value: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos; i++) if (value.charCodeAt(i) === 10) n++;
  return n;
}

// Computed-style properties the caret mirror must copy to match text layout.
const AC_MIRROR_PROPS = [
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "line-height", "letter-spacing", "word-spacing", "tab-size",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "box-sizing",
];

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

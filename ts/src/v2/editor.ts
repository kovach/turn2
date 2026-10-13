import { partialTokenAt, suggestionsFor } from "./autocomplete.js";
import { applyRename, renameError, renameOccurrences, renameTargetAt, type RenameTarget } from "./rename.js";
import { highlightLine as hlLine, type HlToken } from "./highlight.js";

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
  // Right-click code-action menu (rename symbol / variable, rename.ts).
  // Default off; index-v2 opts in. Shift+right-click still gets the
  // browser's own menu.
  enableContextMenu?: boolean;
  // Syntax highlighting (highlight.ts): a `<pre>` layer under a textarea
  // whose own text is transparent. Default off.
  syntaxHighlight?: boolean;
  // Number shown in the gutter for the first line (default 1): a rule-browser
  // card shows the file's line numbers for its slice.
  firstLine?: number;
}

// A column range of one line to mark in the highlight layer (setMarks).
export interface EditorMark {
  line: number;     // 1-indexed, in this editor's own text
  startCol: number;
  endCol: number;
}

const SAVE_DEBOUNCE_MS = 400;

// One `name value` pair shown as a faint line note (setLineNotes).
export interface LineNote {
  name: string;
  value: string;
}

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
  private readonly gutterSyncHandler: () => void;
  private readonly mouseDownHandler: (ev: MouseEvent) => void;
  private readonly keyUpHandler: (ev: KeyboardEvent) => void;
  private readonly blurHandler: () => void;
  private lastLineCount = 0;
  private firstLine: number;
  private _frozen = false;

  // Syntax-highlight layer: one block row per line inside `hlCode`, which is
  // translated by the textarea's scroll offsets. Block rows, like the
  // gutter's: their pitch matches the textarea's own lines, where line boxes
  // of one inline run drift by a fraction of a pixel per line.
  // Rows are rewritten only when their text, incoming `#js` state or marks
  // change.
  private hlEl: HTMLPreElement | null = null;
  private hlCode: HTMLElement | null = null;
  private hlRows: HTMLDivElement[] = [];
  private hlKeys: string[] = [];
  private hlMarks = new Map<number, { startCol: number; endCol: number }[]>();
  private hlResize: ResizeObserver | null = null;

  // Line/range-highlight overlay (source ↔ output linking). Lazily created
  // inside `wrap` so it positions against the same origin as the gutter rows —
  // exact alignment regardless of what re-parents the textarea. With
  // `startCol`/`endCol` set the overlay covers only that column range
  // (highlightRange); otherwise it is a full-width line bar (highlightLine).
  private highlightEl: HTMLDivElement | null = null;
  private highlighted: { line: number; startCol?: number; endCol?: number } | null = null;
  // Character-cell metrics for column → pixel mapping, re-measured on each
  // highlightRange call (so font-size changes can't go stale) and reused by
  // repositionHighlight on scroll. Valid because the textarea is monospace,
  // `white-space: pre`, and never soft-wraps (styles/editor.css).
  private chMetrics: { ch: number; padLeft: number } | null = null;
  private chProbe: HTMLSpanElement | null = null;

  // Live-value notes (plans/v2-live-values-in-editor.md): faint `X *17`
  // pairs drawn just right of a line's text. Same overlay technique as the
  // highlight — absolutely positioned children of `wrap`, aligned off the
  // gutter rows, re-laid on scroll/input.
  private notesEl: HTMLDivElement | null = null;
  private notes: Map<number, LineNote[]> | null = null;

  // Autocomplete state. `acBox`/`acMirror` are created lazily on first show.
  private readonly acEnabled: boolean;
  private acBox: HTMLDivElement | null = null;
  private acMirror: HTMLDivElement | null = null;
  private acItems: string[] = [];
  private acToken: { start: number; end: number } | null = null;

  // Context menu state. `menuEl` is created lazily; `menuClose` undoes the
  // document-level listeners that dismiss it.
  private readonly menuEnabled: boolean;
  private readonly contextMenuHandler: (ev: MouseEvent) => void;
  private menuEl: HTMLDivElement | null = null;
  private menuClose: (() => void) | null = null;

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

    this.firstLine = opts.firstLine ?? 1;
    this.acEnabled = opts.enableAutocomplete ?? false;
    this.menuEnabled = opts.enableContextMenu ?? false;
    this.contextMenuHandler = (ev) => this.onContextMenu(ev);

    this.keyHandler = (ev) => this.onKeyDown(ev);
    this.inputHandler = () => this.onInput();
    // The gutter never scrolls on its own: it mirrors the textarea. Anything
    // else that moves it — notably the browser restoring scroll offsets on a
    // page reload, which fires no textarea scroll — would leave line numbers
    // (and every overlay aligned off the gutter rows) offset from the text,
    // so snap it back whenever it moves and once loading has settled.
    this.gutterSyncHandler = () => this.syncGutterScroll();
    this.scrollHandler = () => {
      this.syncGutterScroll();
      this.syncHlScroll();
      this.repositionHighlight();
      this.repositionNotes();
      if (this.acEnabled) this.hideAutocomplete();
      this.hideMenu();
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
    }; // TODO: organize as much autocomplete logic as possible into separate file or class; attach optionally
    this.blurHandler = () => this.hideAutocomplete();
    this.ta.addEventListener("keydown", this.keyHandler);
    this.ta.addEventListener("input", this.inputHandler);
    this.ta.addEventListener("scroll", this.scrollHandler);
    this.gutterEl.addEventListener("scroll", this.gutterSyncHandler);
    window.addEventListener("load", this.gutterSyncHandler);
    window.addEventListener("pageshow", this.gutterSyncHandler);
    this.ta.addEventListener("mousedown", this.mouseDownHandler);
    if (this.menuEnabled) this.ta.addEventListener("contextmenu", this.contextMenuHandler);
    if (this.acEnabled) {
      this.ta.addEventListener("keyup", this.keyUpHandler);
      this.ta.addEventListener("blur", this.blurHandler);
    }

    this.rebuildGutter();
    if (opts.syntaxHighlight) this.initHighlight();

    if (opts.autoGrow) {
      // A textarea's default `rows` is 2, which floors the auto height at
      // two lines; fitHeight sizes it to the content instead.
      this.ta.rows = 1;
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
    this.syncGutterScroll();
    this.renderHighlight();
  }

  // Re-measure after the editor was attached or resized from outside: an
  // auto-grown height (0 while detached) and the highlight layer's box.
  refresh(): void {
    if (this.opts.autoGrow) this.fitHeight();
    else this.layoutHighlight();
  }

  // Renumber the gutter so its first row reads `n`.
  setFirstLine(n: number): void {
    if (n === this.firstLine) return;
    this.firstLine = n;
    this.gutterEl.textContent = "";
    this.lastLineCount = 0;
    this.rebuildGutter();
  }

  // Marks drawn behind the text in the highlight layer (no-op without
  // `syntaxHighlight`). Replaces any previous marks.
  setMarks(marks: EditorMark[]): void {
    this.hlMarks.clear();
    for (const m of marks) {
      let ms = this.hlMarks.get(m.line);
      if (ms === undefined) this.hlMarks.set(m.line, (ms = []));
      ms.push({ startCol: m.startCol, endCol: m.endCol });
    }
    this.hlKeys = [];
    this.renderHighlight();
  }

  private initHighlight(): void {
    this.hlEl = document.createElement("pre");
    this.hlEl.className = "editor-hl";
    this.hlEl.setAttribute("aria-hidden", "true");
    this.hlCode = document.createElement("code");
    this.hlEl.appendChild(this.hlCode);
    this.wrap.insertBefore(this.hlEl, this.ta);
    this.ta.classList.add("editor-hl-on");
    this.hlResize = new ResizeObserver(() => this.layoutHighlight());
    this.hlResize.observe(this.ta);
    this.renderHighlight();
    queueMicrotask(() => this.layoutHighlight());
  }

  // Lay the layer exactly over the textarea's box, with its font metrics.
  private layoutHighlight(): void {
    if (this.hlEl === null) return;
    const cs = getComputedStyle(this.ta);
    const st = this.hlEl.style;
    st.left = `${this.ta.offsetLeft}px`;
    st.top = `${this.ta.offsetTop}px`;
    st.width = `${this.ta.offsetWidth}px`;
    st.height = `${this.ta.offsetHeight}px`;
    st.padding = cs.padding;
    st.borderStyle = "solid";
    st.borderColor = "transparent";
    st.borderWidth = cs.borderWidth;
    st.font = cs.font;
    st.letterSpacing = cs.letterSpacing;
    st.tabSize = cs.tabSize;
    // Rows take the gutter rows' laid-out height, which matches the
    // textarea's line pitch; a row's own line box can come out a fraction of
    // a pixel taller (mixed bold/italic runs), which adds up over a long file.
    const gr = this.gutterEl.firstElementChild?.getBoundingClientRect().height;
    if (gr !== undefined && gr > 0) this.hlCode!.style.setProperty("--hl-row-h", `${gr}px`);
    this.syncHlScroll();
  }

  private syncHlScroll(): void {
    if (this.hlCode === null) return;
    this.hlCode.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`;
  }

  private renderHighlight(): void {
    if (this.hlCode === null) return;
    const lines = this.ta.value.split("\n");
    if (lines.length !== this.hlRows.length) {
      this.hlCode.textContent = "";
      this.hlRows = [];
      this.hlKeys = [];
      for (let i = 0; i < lines.length; i++) {
        const row = document.createElement("div");
        this.hlRows.push(row);
        this.hlCode.appendChild(row);
      }
    }
    const state = { js: 0 };
    lines.forEach((text, i) => {
      const marks = this.hlMarks.get(i + 1);
      const key = `${state.js}\u0000${text}`;
      const toks = hlLine(text, state);
      if (this.hlKeys[i] === key) return;
      this.hlKeys[i] = key;
      renderHlRow(this.hlRows[i]!, text, toks, marks);
    });
  }

  private syncGutterScroll(): void {
    if (this.gutterEl.scrollTop !== this.ta.scrollTop) this.gutterEl.scrollTop = this.ta.scrollTop;
  }
  get element(): HTMLTextAreaElement { return this.ta; }
  focus(): void { this.ta.focus(); }

  // 1-indexed line of the caret (selectionStart).
  caretLine(): number {
    return this.caretPos().line;
  }

  // 1-indexed line and 0-indexed column of the caret (selectionStart), for
  // matching against atom span column ranges (source-link.ts).
  caretPos(): { line: number; col: number } {
    let line = 1;
    let lineStart = 0;
    const pos = this.ta.selectionStart;
    const v = this.ta.value;
    for (let i = 0; i < pos; i++) {
      if (v.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
    }
    return { line, col: pos - lineStart };
  }

  // Show the full-width line-highlight overlay at `line`. Vertical placement
  // is read off the gutter row for that line, so overlay and gutter can't
  // drift.
  highlightLine(line: number): void {
    this.setHighlight({ line });
  }

  // Show the highlight overlay over columns [startCol, endCol) of `line`
  // (0-indexed source columns, per Span).
  highlightRange(line: number, startCol: number, endCol: number): void {
    this.chMetrics = this.measureChMetrics();
    this.setHighlight({ line, startCol, endCol });
  }

  private setHighlight(h: { line: number; startCol?: number; endCol?: number }): void {
    const row = this.gutterEl.children[h.line - 1] as HTMLElement | undefined;
    if (row === undefined) { this.clearHighlight(); return; }
    if (this.highlightEl === null) {
      this.highlightEl = document.createElement("div");
      this.highlightEl.className = "editor-line-highlight";
      this.wrap.appendChild(this.highlightEl);
    }
    this.highlighted = h;
    this.repositionHighlight();
  }

  clearHighlight(): void {
    this.highlighted = null;
    if (this.highlightEl !== null) this.highlightEl.style.display = "none";
  }

  // Show `notes` (line → pairs) to the right of each line's text. Replaces
  // any previous notes; an empty map clears.
  setLineNotes(notes: Map<number, LineNote[]>): void {
    if (notes.size === 0) { this.clearLineNotes(); return; }
    if (this.notesEl === null) {
      this.notesEl = document.createElement("div");
      this.notesEl.className = "editor-notes";
      this.notesEl.setAttribute("aria-hidden", "true");
      this.wrap.appendChild(this.notesEl);
    }
    this.notesEl.textContent = "";
    for (const [line, pairs] of [...notes.entries()].sort((a, b) => a[0] - b[0])) {
      const row = document.createElement("div");
      row.className = "editor-note";
      row.dataset["line"] = String(line);
      pairs.forEach((p, i) => {
        if (i > 0) row.appendChild(document.createTextNode("  "));
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = p.name + ": ";
        const val = document.createElement("span");
        val.className = "val";
        val.textContent = p.value;
        row.appendChild(name);
        row.appendChild(document.createTextNode(" "));
        row.appendChild(val);
      });
      this.notesEl.appendChild(row);
    }
    this.notes = notes;
    this.chMetrics = this.measureChMetrics();
    this.repositionNotes();
  }

  clearLineNotes(): void {
    this.notes = null;
    if (this.notesEl !== null) this.notesEl.textContent = "";
  }

  // Lay each note row just right of its line's text: x from the line's
  // tab-expanded length and the character metrics, y from the gutter row.
  // Rows whose line scrolled out of view (or no longer exists) are hidden.
  private repositionNotes(): void {
    if (this.notesEl === null || this.notes === null) return;
    const lines = this.ta.value.split("\n");
    const tabSize = parseInt(getComputedStyle(this.ta).tabSize, 10) || 2;
    const m = this.chMetrics ?? (this.chMetrics = this.measureChMetrics());
    const viewLeft = this.ta.offsetLeft + this.ta.clientLeft;
    const viewRight = viewLeft + this.ta.clientWidth;
    for (const rowEl of Array.from(this.notesEl.children) as HTMLElement[]) {
      const line = Number(rowEl.dataset["line"]);
      const gutterRow = this.gutterEl.children[line - 1] as HTMLElement | undefined;
      const text = lines[line - 1];
      if (gutterRow === undefined || text === undefined) { rowEl.style.display = "none"; continue; }
      const top = gutterRow.offsetTop - this.ta.scrollTop;
      const h = gutterRow.offsetHeight;
      if (top + h <= this.gutterEl.offsetTop || top >= this.gutterEl.offsetTop + this.ta.clientHeight) {
        rowEl.style.display = "none";
        continue;
      }
      let cols = 0;
      for (const c of text) cols += c === "\t" ? tabSize - (cols % tabSize) : 1;
      const x = viewLeft + m.padLeft + (cols + 2) * m.ch - this.ta.scrollLeft;
      if (x >= viewRight) { rowEl.style.display = "none"; continue; }
      rowEl.style.display = "block";
      rowEl.style.left = `${Math.max(x, viewLeft)}px`;
      rowEl.style.top = `${top}px`;
      rowEl.style.height = `${h}px`;
      rowEl.style.maxWidth = `${viewRight - Math.max(x, viewLeft)}px`;
    }
  }

  // Move the caret to `line` (at `col`, or the line's end) and center it in
  // the viewport. Works on frozen (readOnly) editors — selection is still
  // allowed there.
  focusLine(line: number, col?: number): void {
    const lines = this.ta.value.split("\n");
    const li = Math.min(Math.max(line, 1), lines.length) - 1;
    let lineStart = 0;
    for (let i = 0; i < li; i++) lineStart += lines[i]!.length + 1;
    const lineEnd = lineStart + lines[li]!.length;
    const caret = col === undefined ? lineEnd : Math.min(lineStart + Math.max(col, 0), lineEnd);
    this.ta.focus();
    this.ta.setSelectionRange(caret, caret);
    const row = this.gutterEl.children[li] as HTMLElement | undefined;
    if (row !== undefined) {
      this.ta.scrollTop = row.offsetTop - this.gutterEl.offsetTop
        - this.ta.clientHeight / 2 + row.offsetHeight / 2;
    }
    this.highlightLine(li + 1);
  }

  // Sync the overlay to the current scroll position (vertical and, for a
  // column range, horizontal); hide it when its line is scrolled out of the
  // visible box (or no longer exists).
  private repositionHighlight(): void {
    if (this.highlightEl === null || this.highlighted === null) return;
    const { line, startCol, endCol } = this.highlighted;
    const row = this.gutterEl.children[line - 1] as HTMLElement | undefined;
    if (row === undefined) { this.clearHighlight(); return; }
    // Row offsets are relative to `wrap` (the nearest positioned ancestor);
    // subtract the textarea's scroll to get the visual position.
    const top = row.offsetTop - this.ta.scrollTop;
    const h = row.offsetHeight;
    if (top + h <= this.gutterEl.offsetTop || top >= this.gutterEl.offsetTop + this.ta.clientHeight) {
      this.highlightEl.style.display = "none";
      return;
    }
    const st = this.highlightEl.style;
    if (startCol !== undefined && endCol !== undefined && this.chMetrics !== null) {
      // Column range: monospace + pre + no soft-wrap makes x a linear
      // function of the column. Clip to the textarea's text viewport so a
      // horizontally scrolled-out range doesn't bleed over the gutter.
      const { ch, padLeft } = this.chMetrics;
      const viewLeft = this.ta.offsetLeft + this.ta.clientLeft;
      const viewRight = viewLeft + this.ta.clientWidth;
      const x0 = viewLeft + padLeft + startCol * ch - this.ta.scrollLeft;
      const x1 = viewLeft + padLeft + endCol * ch - this.ta.scrollLeft;
      const left = Math.max(x0, viewLeft);
      const right = Math.min(x1, viewRight);
      if (right <= left) {
        st.display = "none";
        return;
      }
      st.left = `${left}px`;
      st.width = `${right - left}px`;
      st.right = "auto";
    } else {
      st.left = "0";
      st.width = "auto";
      st.right = "0";
    }
    st.display = "block";
    st.top = `${top}px`;
    st.height = `${h}px`;
  }

  // Width of one character cell plus the textarea's left padding, measured
  // from a hidden probe span carrying the textarea's computed font.
  private measureChMetrics(): { ch: number; padLeft: number } {
    if (this.chProbe === null) {
      this.chProbe = document.createElement("span");
      this.chProbe.style.position = "absolute";
      this.chProbe.style.visibility = "hidden";
      this.chProbe.style.whiteSpace = "pre";
      this.chProbe.setAttribute("aria-hidden", "true");
      this.chProbe.textContent = "0".repeat(64);
      this.wrap.appendChild(this.chProbe);
    }
    const cs = getComputedStyle(this.ta);
    this.chProbe.style.font = cs.font;
    this.chProbe.style.letterSpacing = cs.letterSpacing;
    return {
      ch: this.chProbe.getBoundingClientRect().width / 64,
      padLeft: parseFloat(cs.paddingLeft) || 0,
    };
  }

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
    this.gutterEl.removeEventListener("scroll", this.gutterSyncHandler);
    window.removeEventListener("load", this.gutterSyncHandler);
    window.removeEventListener("pageshow", this.gutterSyncHandler);
    this.ta.removeEventListener("mousedown", this.mouseDownHandler);
    this.ta.removeEventListener("keyup", this.keyUpHandler);
    this.ta.removeEventListener("blur", this.blurHandler);
    this.ta.removeEventListener("contextmenu", this.contextMenuHandler);
    this.hideMenu();
    this.menuEl?.remove();
    this.acBox?.remove();
    this.acMirror?.remove();
    this.highlightEl?.remove();
    this.notesEl?.remove();
    this.hlResize?.disconnect();
    this.hlEl?.remove();
    this.chProbe?.remove();
    if (!this.adopted) this.wrap.remove();
  }

  private onInput(): void {
    this.rebuildGutter();
    this.renderHighlight();
    // Line numbers go stale as soon as the text changes.
    this.clearLineNotes();
    if (this.opts.autoGrow) this.fitHeight();
    if (this.opts.onChange) this.opts.onChange(this.ta.value);
    this.scheduleSave();
  }

  private fitHeight(): void {
    this.ta.style.height = "auto";
    this.ta.style.height = this.ta.scrollHeight + "px";
    // A horizontal scrollbar (a line wider than the box) takes its height
    // out of the content area; add it back so the last line stays visible.
    const cs = getComputedStyle(this.ta);
    const bar = this.ta.offsetHeight - this.ta.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    if (bar > 0) this.ta.style.height = this.ta.scrollHeight + bar + "px";
    this.gutterEl.style.height = this.ta.style.height;
    this.layoutHighlight();
  }

  private rebuildGutter(): void {
    const value = this.ta.value;
    let n = 1;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) n++;
    if (n === this.lastLineCount) return;
    if (n > this.lastLineCount) {
      for (let i = this.lastLineCount; i < n; i++) {
        const row = document.createElement("div");
        row.textContent = String(i + this.firstLine);
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
    if (ev.key === "/" && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      this.toggleComment();
      return;
    }
    if (ev.key === "x" && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
      // With a selection, native cut applies. With no selection, select the
      // current line (including its terminal newline) and let the native cut
      // proceed so clipboard and undo behave normally.
      if (this.ta.selectionStart === this.ta.selectionEnd) {
        const { start, end } = lineBoundsAt(this.ta.value, this.ta.selectionStart);
        const cutEnd = end < this.ta.value.length ? end + 1 : end;
        if (start !== cutEnd) this.ta.setSelectionRange(start, cutEnd);
      }
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

  // Toggle `-- ` line comments over the selected lines (Ctrl/Cmd-/). If every
  // non-blank selected line is already commented, uncomment; otherwise comment
  // all non-blank lines, inserting the marker at each line's indent. Blank lines
  // are left untouched. The `-- ` sits after leading whitespace so nesting reads
  // cleanly. Selection is preserved via the same per-line offset map as indent.
  private toggleComment(): void {
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

    const indentOf = (ln: string): number => ln.match(/^[ \t]*/)![0]!.length;
    const nonBlank = lines.filter((ln) => ln.trim().length > 0);
    const uncomment =
      nonBlank.length > 0 &&
      nonBlank.every((ln) => ln.slice(indentOf(ln)).startsWith("--"));

    // Per line: column (within line) where the edit lands and its signed length.
    const editCol: number[] = [];
    const delta: number[] = [];
    const out = lines.map((ln) => {
      const ind = indentOf(ln);
      if (ln.trim().length === 0) {
        editCol.push(ind);
        delta.push(0);
        return ln;
      }
      if (uncomment) {
        const rem = ln.slice(ind).match(/^-- ?/)![0]!.length;
        editCol.push(ind);
        delta.push(-rem);
        return ln.slice(0, ind) + ln.slice(ind + rem);
      }
      editCol.push(ind);
      delta.push(3);
      return ln.slice(0, ind) + "-- " + ln.slice(ind);
    });
    const replacement = out.join("\n");

    const mapOffset = (p: number): number => {
      if (p <= start) return p;
      if (p >= endLine) return p + (replacement.length - slice.length);
      let shift = 0;
      for (let i = 0; i < lines.length; i++) {
        const ls = lineStartsOrig[i]!;
        const le = ls + lines[i]!.length;
        if (p > le) { shift += delta[i]!; continue; }
        const col = p - ls;
        const c = editCol[i]!;
        const d = delta[i]!;
        if (d > 0) {
          if (col >= c) shift += d;
        } else if (d < 0) {
          const rem = -d;
          if (col >= c + rem) shift += d;
          else if (col > c) shift -= col - c;
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
    return partialTokenAt(ta.value, ta.selectionStart);
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
    const { left, top, lineH } = this.caretCoords(tokenStart);
    box.style.left = left + "px";
    box.style.top = top + "px";
    box.style.display = "block";
    // Flip above the caret's line when the box would be clipped below it (by
    // the viewport or a scrolling/overflow-hidden ancestor) and there is more
    // room above.
    const r = box.getBoundingClientRect();
    const clip = visibleClipRect(this.wrap);
    const roomBelow = clip.bottom - r.top;
    const roomAbove = r.top - lineH - clip.top;
    if (r.height > roomBelow && roomAbove > roomBelow) {
      box.style.top = top - lineH - r.height + "px";
    }
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

  // --- context menu ----------------------------------------------------------

  // Right-click: open the code-action menu at the click point, acting on the
  // caret. The browser has already placed the caret on the right-button
  // mousedown (or kept the selection, when the click was inside it), with its
  // own hit test — recomputing the offset from our overlay geometry drifted
  // by whole lines where text-line and gutter-row heights differ.
  private onContextMenu(ev: MouseEvent): void {
    if (ev.shiftKey) return; // escape hatch to the browser's menu
    ev.preventDefault();
    this.hideAutocomplete();
    const target = renameTargetAt(this.ta.value, this.ta.selectionStart);
    const menu = this.openMenu(ev.clientX, ev.clientY);
    const item = document.createElement("div");
    item.className = "editor-menu-item";
    if (target === null || this._frozen) {
      item.classList.add("is-disabled");
      item.textContent = this._frozen ? "Rename (editor is read-only)" : "Rename (no symbol or variable here)";
    } else {
      item.textContent = `Rename ${target.kind} '${target.name}'…`;
      item.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus
      item.addEventListener("click", () => this.showRenameInput(target));
    }
    menu.appendChild(item);
    this.placeMenu();
  }

  // Replace the menu's contents with a name input for `target`. Enter applies
  // the rename (refused names show why and keep the input open); Escape or a
  // click elsewhere cancels.
  private showRenameInput(target: RenameTarget): void {
    const menu = this.menuEl;
    if (menu === null) return;
    const text = this.ta.value;
    const ranges = renameOccurrences(text, target);
    menu.textContent = "";
    const head = document.createElement("div");
    head.className = "editor-menu-head";
    const where = target.kind === "symbol" ? "in this file" : "in this rule";
    head.textContent = `Rename ${target.kind} '${target.name}' · ${ranges.length} occurrence${ranges.length === 1 ? "" : "s"} ${where}`;
    const input = document.createElement("input");
    input.className = "editor-menu-input";
    input.type = "text";
    input.spellcheck = false;
    input.value = target.name;
    const err = document.createElement("div");
    err.className = "editor-menu-error";
    menu.append(head, input, err);
    this.placeMenu();
    input.focus();
    input.select();
    const check = (): string | null => {
      const e = renameError(text, target, input.value.trim());
      err.textContent = e ?? "";
      return e;
    };
    input.addEventListener("input", () => { check(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.hideMenu();
        this.ta.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (check() !== null) return;
        const name = input.value.trim();
        this.hideMenu();
        if (name === target.name || this.ta.value !== text) { this.ta.focus(); return; }
        this.applyRenameEdit(text, target, ranges, name);
      }
    });
  }

  // Rewrite every occurrence as one edit spanning first..last, so the whole
  // rename is a single native undo step. The caret lands at the end of the
  // renamed identifier it started on.
  private applyRenameEdit(text: string, target: RenameTarget, ranges: { start: number; end: number }[], name: string): void {
    if (ranges.length === 0) return;
    const from = ranges[0]!.start;
    const to = ranges[ranges.length - 1]!.end;
    const shifted = ranges.map((r) => ({ start: r.start - from, end: r.end - from }));
    const replacement = applyRename(text.slice(from, to), shifted, name);
    const before = ranges.filter((r) => r.start < target.start).length;
    const caret = target.start + before * (name.length - target.name.length) + name.length;
    this.replaceRange(from, to, replacement, caret);
  }

  // Create (or clear) the menu at a client point and wire up dismissal:
  // a mousedown outside it, Escape, scroll, resize or window blur.
  private openMenu(clientX: number, clientY: number): HTMLDivElement {
    this.hideMenu();
    if (this.menuEl === null) {
      this.menuEl = document.createElement("div");
      this.menuEl.className = "editor-menu";
      this.wrap.appendChild(this.menuEl);
    }
    const menu = this.menuEl;
    menu.textContent = "";
    const w = this.wrap.getBoundingClientRect();
    menu.style.left = clientX - w.left + "px";
    menu.style.top = clientY - w.top + "px";
    menu.dataset["y"] = String(clientY);
    menu.style.display = "block";
    const onDown = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) this.hideMenu(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); this.hideMenu(); } };
    const onAway = () => this.hideMenu();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", onAway);
    this.menuClose = () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("blur", onAway);
    };
    return menu;
  }

  // Keep the menu on screen: open upward from the click point when it would
  // be clipped below, and shift left when it would run off the right edge.
  private placeMenu(): void {
    const menu = this.menuEl;
    if (menu === null) return;
    const w = this.wrap.getBoundingClientRect();
    const y = Number(menu.dataset["y"]);
    menu.style.top = y - w.top + "px";
    const r = menu.getBoundingClientRect();
    const clip = visibleClipRect(this.wrap);
    if (r.bottom > clip.bottom && y - r.height >= clip.top) menu.style.top = y - r.height - w.top + "px";
    const overRight = r.right - window.innerWidth;
    if (overRight > 0) menu.style.left = Math.max(0, r.left - overRight - w.left) + "px";
  }

  private hideMenu(): void {
    this.menuClose?.();
    this.menuClose = null;
    if (this.menuEl !== null) this.menuEl.style.display = "none";
  }

  // Pixel position (relative to `this.wrap`) of the caret at offset `pos`,
  // via an off-screen mirror that replicates the textarea's text metrics.
  private caretCoords(pos: number): { left: number; top: number; lineH: number } {
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
    // Empty the mirror once measured: its text (everything up to the caret)
    // can be taller than the pane, and lingering overflow gives the document
    // a scroll range that lets caret-reveal/scrollIntoView shift the page.
    mirror.textContent = "";
    return { left, top, lineH };
  }
}

// The on-screen region `el`'s descendants can be seen in (client coordinates):
// the viewport intersected with `el` and every ancestor whose overflow clips.
function visibleClipRect(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let a: HTMLElement | null = el; a !== null; a = a.parentElement) {
    const oy = getComputedStyle(a).overflowY;
    if (oy === "visible") continue;
    const r = a.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

// Bare modifier keys: their keyup must neither refresh nor dismiss the box, so
// the Shift-up ending an uppercase keystroke doesn't close what the letter
// opened.
// One highlighted line: text cut at every token and mark boundary, each
// piece a span with its token class (`t-<cls>`) and `hl-mark` when marked.
function renderHlRow(
  row: HTMLDivElement,
  text: string,
  toks: HlToken[],
  marks: { startCol: number; endCol: number }[] | undefined,
): void {
  row.textContent = "";
  const cuts = new Set<number>([0, text.length]);
  for (const t of toks) { cuts.add(t.start); cuts.add(t.end); }
  for (const m of marks ?? []) { cuts.add(Math.min(m.startCol, text.length)); cuts.add(Math.min(m.endCol, text.length)); }
  const xs = [...cuts].sort((a, b) => a - b);
  let ti = 0;
  for (let k = 0; k + 1 < xs.length; k++) {
    const a = xs[k]!, b = xs[k + 1]!;
    while (ti < toks.length && toks[ti]!.end <= a) ti++;
    const tok = ti < toks.length && toks[ti]!.start <= a ? toks[ti] : undefined;
    const marked = (marks ?? []).some((m) => m.startCol <= a && b <= m.endCol);
    const piece = text.slice(a, b);
    if (tok === undefined && !marked) { row.appendChild(document.createTextNode(piece)); continue; }
    const span = document.createElement("span");
    if (tok !== undefined) span.className = `t-${tok.cls}`;
    if (marked) span.classList.add("hl-mark");
    span.textContent = piece;
    row.appendChild(span);
  }
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

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

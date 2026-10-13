// The editor's Tests view (plans/v2-editor-tests.md). After each run of file
// F, re-runs every scenario test (v2/scenario.ts) whose `-- uses:` lists F —
// or F itself, when F is a scenario — with the editor buffer in place of F's
// saved copy. Scenarios come from the server's `--v2-tests` dirs
// (`GET /api/v2-tests`); the other `uses` files are fetched fresh from
// `/data/v2/` each time, since another tab may have edited them. The batch
// runs in a worker (v2-test-worker.ts); a new run terminates the old worker,
// so stale results never land. The view's button and the header chip show
// only while some scenario uses the open file.

import { parseScenario } from "./scenario.js";
import type { TestJob, TestJobResult } from "../v2-test-worker.js";

interface Row {
  name: string;
  result: TestJobResult | null;
}

export interface TestPanelEls {
  view: HTMLElement;
  // Header summary: `tests 3/3`, `tests 2/3 ✗`, `tests …`.
  chip: HTMLElement;
  // The Result pane's Tests button; hidden while no scenario uses the file.
  button: HTMLElement;
  // Clicked to leave the Tests view when it hides (the Timeline button).
  fallback: HTMLElement;
}

export class TestPanel {
  private worker: Worker | null = null;
  private generation = 0;
  private rows: Row[] = [];
  private file = "";
  private error: string | null = null;

  constructor(private readonly els: TestPanelEls) {
    els.chip.addEventListener("click", () => els.button.click());
  }

  // Re-run the tests for `file` with `buffer` as its text. Safe to call on
  // every run: an older call still fetching is abandoned.
  async rerun(file: string, buffer: string): Promise<void> {
    const gen = ++this.generation;
    this.worker?.terminate();
    this.worker = null;
    let tests: { name: string; text: string }[];
    try {
      const res = await fetch("/api/v2-tests");
      tests = res.ok ? ((await res.json()) as { tests: typeof tests }).tests : [];
    } catch {
      tests = [];
    }
    if (gen !== this.generation) return;
    const selected = tests
      .map((t) => (t.name === file ? { name: t.name, text: buffer } : t))
      .filter((t) => t.name === file || parseScenario(t.text).uses.includes(file));
    const show = selected.length > 0;
    if (!show && this.els.button.classList.contains("active")) this.els.fallback.click();
    this.els.button.classList.toggle("hidden", !show);
    this.els.chip.classList.toggle("hidden", !show);
    if (!show) return;
    const others = new Set(selected.flatMap((t) => parseScenario(t.text).uses));
    others.delete(file);
    const texts = new Map<string, string>([[file, buffer]]);
    await Promise.all([...others].map(async (name) => {
      try {
        const res = await fetch(`/data/v2/${encodeURIComponent(name)}`);
        if (res.ok) texts.set(name, await res.text());
      } catch { /* reported by the scenario as a missing file */ }
    }));
    if (gen !== this.generation) return;

    this.file = file;
    this.error = null;
    this.rows = selected.map((t) => ({ name: t.name, result: null }));
    this.render();

    const jobs: TestJob[] = selected.map((t) => ({
      name: t.name,
      text: t.text,
      files: parseScenario(t.text).uses.filter((u) => texts.has(u)).map((u) => [u, texts.get(u)!]),
    }));
    const worker = new Worker(new URL("../v2-test-worker.js", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<TestJobResult>) => {
      if (gen !== this.generation) return;
      const row = this.rows.find((r) => r.name === e.data.name);
      if (row) row.result = e.data;
      this.render();
      if (this.rows.every((r) => r.result !== null)) {
        worker.terminate();
        if (this.worker === worker) this.worker = null;
      }
    };
    worker.onerror = (e) => {
      if (gen !== this.generation) return;
      this.error = `test worker failed: ${e.message}`;
      this.render();
    };
    worker.postMessage(jobs);
  }

  private render(): void {
    const { view, chip } = this.els;
    const total = this.rows.length;
    const finished = this.rows.filter((r) => r.result !== null);
    const failed = finished.filter((r) => r.result!.problems.length > 0).length;
    const running = finished.length < total && this.error === null;
    chip.textContent = running
        ? `tests ${finished.length - failed}/${total} …`
        : `tests ${finished.length - failed}/${total}${failed > 0 || this.error ? " ✗" : ""}`;
    chip.classList.toggle("error", failed > 0 || this.error !== null);
    chip.title = `Scenarios that use ${this.file}`;

    view.innerHTML = "";
    const head = document.createElement("div");
    head.className = "tests-head";
    head.textContent = `Scenarios using ${this.file}, run on the editor's text (${total})`;
    view.appendChild(head);
    if (this.error !== null) {
      const err = document.createElement("div");
      err.className = "tests-problem";
      err.textContent = this.error;
      view.appendChild(err);
    }
    for (const r of this.rows) {
      const row = document.createElement("div");
      row.className = "tests-row";
      const mark = document.createElement("span");
      const ok = r.result !== null && r.result.problems.length === 0;
      mark.className = `tests-mark ${r.result === null ? "running" : ok ? "ok" : "fail"}`;
      mark.textContent = r.result === null ? "…" : ok ? "ok" : "FAIL";
      const link = document.createElement("a");
      link.href = `/v2?file=${encodeURIComponent(r.name)}`;
      link.target = "_blank";
      link.textContent = r.name;
      const ms = document.createElement("span");
      ms.className = "tests-ms";
      ms.textContent = r.result === null ? "" : `${Math.round(r.result.ms)} ms`;
      row.append(mark, link, ms);
      view.appendChild(row);
      for (const p of r.result?.problems ?? []) {
        const line = document.createElement("div");
        line.className = "tests-problem";
        line.textContent = p;
        view.appendChild(line);
      }
    }
  }
}

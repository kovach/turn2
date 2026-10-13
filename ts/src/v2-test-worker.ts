// Web worker for the editor's Tests view (plans/v2-editor-tests.md): runs a
// batch of scenario tests (v2/scenario.ts) off the page's thread and posts
// each result as it finishes. web-v2.ts starts a fresh worker per batch and
// terminates the old one, so a stale batch never reports.

import { runScenario } from "./v2/scenario.js";

export interface TestJob {
  name: string;
  text: string;
  // `uses` file name → text, the edited file's entry being the editor buffer.
  files: [string, string][];
}

export interface TestJobResult {
  name: string;
  problems: string[];
  ms: number;
}

// The DOM lib types `self` as a Window; this file runs as a module worker.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<TestJob[]>) => void) | null;
  postMessage(m: TestJobResult): void;
};

ctx.onmessage = (e) => {
  for (const job of e.data) {
    const { problems, ms } = runScenario(job.text, new Map(job.files));
    ctx.postMessage({ name: job.name, problems, ms });
  }
};

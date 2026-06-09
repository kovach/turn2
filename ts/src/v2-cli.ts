// CLI access to the v2 compilation / evaluation pipeline. Reads source from a
// file argument or stdin and dumps a chosen pipeline stage.
//
//   npm run v2 -- --stage expand foo.t
//   cat foo.t | npm run v2 -- --stage parse
//   tsx src/v2-cli.ts --stage eval --out timeline data/v2/ttt.t
//
// See plans/v2-cli-interface.md.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { parse } from "./v2/parse.js";
import { expand, expandStages } from "./v2/expand.js";
import { runFixpoint } from "./v2/fixpoint.js";
import { renderProgram } from "./v2/print-ir.js";
import { renderTimelineAscii } from "./v2/timeline.js";
import { renderAtomShallow, renderTermShallow, renderDebugDump } from "./v2/print.js";
import type { Program, Rule, RuleAtom } from "./v2/types.js";
import type { Atom } from "./types.js";
import type { Store } from "./v2/store.js";

// The pipeline stages, in order. This is the single source of truth: it drives
// `--stage` validation, the usage message, and the exhaustiveness of
// `runStage` below. Adding a stage here without a matching `runStage` case is a
// compile error (the `never` default), so the CLI can't silently fall behind a
// new pipeline stage.
export const STAGES = [
  "parse",
  "decompose",
  "split",
  "filter",
  "delta",
  "expand",
  "eval",
] as const;
export type Stage = (typeof STAGES)[number];

// One-line doc per stage. `Record<Stage, …>` makes this exhaustive: adding a
// member to `STAGES` without a doc here is a compile error, so the usage text
// (built from it below) can't fall out of sync.
const STAGE_DOC: Record<Stage, string> = {
  parse: "tokenize and parse the source into the pre-expand IR.",
  decompose: "lower each marker (match/episode/fact/…) into the post-expand IR (Match/Emit/Le/AssertLt/Max/Min).",
  split: "slice every rule at each Emit into producer/consumer halves.",
  filter: "drop sliced tails with no observable effect (no Emit, no AssertLt).",
  delta: "clone each surviving rule into its semi-naive delta variants.",
  expand: "the final expanded program the evaluator consumes (= delta).",
  eval: "run the program to fixpoint and render the resulting store.",
};

const STAGE_HELP = STAGES.map((s) => `    ${s.padEnd(11)} ${STAGE_DOC[s]}`).join("\n");

const USAGE = `usage: v2-cli [--stage <stage>] [filters] [--gas N] [--tuple-gas N] [--out tuples|timeline|debug] [file]

  reads source from <file>, or stdin if omitted.

  stages (pipeline order; default eval):
${STAGE_HELP}

  rule-list stages (everything but eval):
    --rule <name>     keep only the rule named <name>
    --emits <sym>     keep rules that emit/assert relation <sym>
    --matches <sym>   keep rules that match relation <sym>
    --lines           annotate each atom with its source line
  filters AND-combine; not valid with --stage eval.

  --out applies to the eval stage only (default: tuples).`;

export type EvalFormat = "tuples" | "timeline" | "debug";

export interface RunOptions {
  gas: number;
  tupleGas: number;
  out: EvalFormat;
  // Rule filters (rule-list stages only; AND-combined when several are set).
  rule: string | undefined;    // keep only the rule with this name
  emits: string | undefined;   // keep rules that emit/assert this head symbol
  matches: string | undefined; // keep rules that match this head symbol
  // Annotate every rendered atom with its source line.
  lines: boolean;
}

export const DEFAULT_OPTIONS: RunOptions = {
  gas: 200,
  tupleGas: 5000,
  out: "tuples",
  rule: undefined,
  emits: undefined,
  matches: undefined,
  lines: false,
};

function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

// The rule list for each non-eval stage. `null` means the stage renders a
// store, not a rule list (i.e. `eval`).
// Maps each rule-list stage to its rules. See STAGE_DOC for what each produces.
function rulesForStage(stage: Exclude<Stage, "eval">, parsed: Program): Rule[] {
  switch (stage) {
    case "parse": return parsed.rules;
    case "decompose": return expandStages(parsed).decomposed;
    case "split": return expandStages(parsed).split;
    case "filter": return expandStages(parsed).filtered;
    case "delta": return expandStages(parsed).variants;
    case "expand": return expand(parsed).rules;
    default: {
      const _exhaustive: never = stage;
      throw new Error(`unhandled stage: ${_exhaustive as string}`);
    }
  }
}

// Render a parsed program at the requested pipeline stage. Returns the text to
// print to stdout. `eval`'s run status is reported separately by the caller.
export function runStage(stage: Stage, parsed: Program, opts: RunOptions): string {
  if (stage === "eval") {
    const { store, status } = runFixpoint(parsed, opts.gas, opts.tupleGas);
    console.error(`status: ${status.kind}`);
    return renderStore(store, opts.out);
  }
  const rules = rulesForStage(stage, parsed).filter((r) => ruleMatches(r, opts));
  if (rules.length === 0 && hasFilter(opts)) console.error("(no rules matched filter)");
  return renderProgram({ ...parsed, rules }, { lines: opts.lines });
}

// ----- rule filtering -----

const headOf = (atom: Atom): string | undefined => {
  const head = atom.terms[0];
  return head !== undefined && head.tag === "Symbol" ? head.name : undefined;
};

// An atom that *produces* a tuple under `sym`: a post-expand `Emit`, or a
// pre-expand assert (`Atom` with a non-`match` marker).
const emitsHead = (a: RuleAtom, sym: string): boolean =>
  (a.tag === "Emit" && headOf(a.atom) === sym) ||
  (a.tag === "Atom" && a.marker !== "match" && headOf(a.atom) === sym);

// An atom that *reads* a tuple under `sym`: a post-expand `Match`, or a
// pre-expand `Atom` with the `match` marker.
const matchesHead = (a: RuleAtom, sym: string): boolean =>
  (a.tag === "Match" && headOf(a.atom) === sym) ||
  (a.tag === "Atom" && a.marker === "match" && headOf(a.atom) === sym);

function hasFilter(opts: RunOptions): boolean {
  return opts.rule !== undefined || opts.emits !== undefined || opts.matches !== undefined;
}

function ruleMatches(r: Rule, opts: RunOptions): boolean {
  if (opts.rule !== undefined && r.name !== opts.rule) return false;
  if (opts.emits !== undefined && !r.body.some((a) => emitsHead(a, opts.emits!))) return false;
  if (opts.matches !== undefined && !r.body.some((a) => matchesHead(a, opts.matches!))) return false;
  return true;
}

function renderStore(store: Store, out: EvalFormat): string {
  switch (out) {
    case "tuples":
      // Shallow renderers stop at `Ref` boundaries (moment chains print as
      // `*<id>` handles). The full `renderTerm`/`renderAtom` expand every Ref
      // and blow up exponentially on real stores — see print.ts.
      return store.tuples
        .map(
          (t) =>
            `${renderAtomShallow(store, t.atom)}  @ ${renderTermShallow(store, t.l)}..${renderTermShallow(store, t.r)}`,
        )
        .join("\n");
    case "timeline":
      return renderTimelineAscii(store, { laneMode: "nested" });
    case "debug": {
      const dump = renderDebugDump(store, store.tuples);
      return JSON.stringify(dump, null, 2);
    }
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function main(argv: string[]): void {
  let stage: Stage = "eval";
  const opts: RunOptions = { ...DEFAULT_OPTIONS };
  let file: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--stage": {
        const v = argv[++i];
        if (v === undefined || !isStage(v)) fail(`bad --stage value: ${v}\n\n${USAGE}`);
        stage = v;
        break;
      }
      case "--gas": {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v)) fail(`bad --gas value\n\n${USAGE}`);
        opts.gas = v;
        break;
      }
      case "--tuple-gas": {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v)) fail(`bad --tuple-gas value\n\n${USAGE}`);
        opts.tupleGas = v;
        break;
      }
      case "--out": {
        const v = argv[++i];
        if (v !== "tuples" && v !== "timeline" && v !== "debug") {
          fail(`bad --out value: ${v}\n\n${USAGE}`);
        }
        opts.out = v;
        break;
      }
      case "--rule": {
        const v = argv[++i];
        if (v === undefined) fail(`--rule needs a value\n\n${USAGE}`);
        opts.rule = v;
        break;
      }
      case "--emits": {
        const v = argv[++i];
        if (v === undefined) fail(`--emits needs a value\n\n${USAGE}`);
        opts.emits = v;
        break;
      }
      case "--matches": {
        const v = argv[++i];
        if (v === undefined) fail(`--matches needs a value\n\n${USAGE}`);
        opts.matches = v;
        break;
      }
      case "--lines":
        opts.lines = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
      default:
        if (arg.startsWith("-")) fail(`unknown flag: ${arg}\n\n${USAGE}`);
        if (file !== undefined) fail(`multiple input files given\n\n${USAGE}`);
        file = arg;
    }
  }

  if (stage === "eval" && (hasFilter(opts) || opts.lines)) {
    fail(`--rule/--emits/--matches/--lines apply to rule-list stages, not eval\n\n${USAGE}`);
  }

  const source = file !== undefined ? readFileSync(file, "utf-8") : readFileSync(0, "utf-8");

  const parsed = parse(source);
  if ("message" in parsed) {
    fail(`parse error (line ${parsed.line}): ${parsed.message}`);
  }

  console.log(runStage(stage, parsed, opts));
}

// Only run when invoked as the entry script — importing for tests must not
// execute main (it would read stdin).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}

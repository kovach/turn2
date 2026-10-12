// Outer loop. The inner loop runs all rules to quiescence (the monotone
// part; no agg or choice knowledge). At quiescence the moment walk
// (moment-walk.ts, plans/v2-moment-walk.md) runs the non-monotone part —
// the handlers in scheduler.ts — at the minimal unresolved moments: if any
// handler adds tuples we re-enter the inner loop; otherwise unblocked
// frontier moments are marked resolved and the walk advances; when every
// frontier moment is blocked on a choice, the choices there surface.

import type { Actor, ComponentOptions, FixpointStatus, Program, ProvLink, Rule } from "./types.js";
import { maxActor } from "./types.js";
import type { Span, Term } from "./term.js";
import { ACC_AT_HEAD, compileJsDefs, evaluateRule, type AccRow, type CompiledJs } from "./eval.js";
import { compileJsRels, type CompiledJsRel } from "./js-rel.js";
import { type Store, createStore, candidatesByHead, demandAcc, intern, tokenOf, GasError } from "./store.js";
import { applyExceptions, expand } from "./expand.js";
import {
  choiceHandler,
  exceptionCheckHandler,
  isInputHandler,
  collectBlockedChooses,
  markDeadChoice,
  programSeededRandom,
  resolveRngChoice,
  type RngCommit,
} from "./scheduler.js";
import { markResolved, settleMoments, runWalkRound, type MomentHandler } from "./moment-walk.js";
import { accHandler, accRowsAt, compileAcc, type AccMode } from "./acc.js";
import { renderTermShallow } from "./print.js";
import { checkConstrainPlacement, computeComponents, type ConstraintPlacementError } from "./constraint-query.js";
import { attachRules, costEnter, costExit, inFrame } from "./stats.js";

export interface FixpointResult {
  store: Store;
  iterations: number;
  status: FixpointStatus;
  // The expanded rules the evaluator actually ran (set by `runFixpoint`;
  // absent on the inner `runLoop` results). Needed to decode per-tuple
  // bindings from the id slot (`tupleBindings` in print.ts).
  rules?: Rule[];
  // Every `rng` choice binding committed during this run, in commit order
  // (plans/v2-choice-actors.md). The harness persists these as `^ is` rows
  // so a roll happens exactly once. Empty when nothing was rolled.
  rngCommits: RngCommit[];
  // Every acc relation's rows at a settled moment, computed on the spot for
  // inspection (acc.ts `accRowsAt`; nothing is written). Set by
  // `runFixpoint` when the program declares acc relations.
  accAt?: (tok: number) => Map<string, AccRow[]> | undefined;
}

export function runFixpoint(
  program: Program,
  gas = 200,
  tupleGas = 5000,
  // `lattice`: moment-lattice semantics for max/min (store.ts "Moment
  // lattice"); off = the original fail-on-incomparable semantics.
  // `accMode`: "demand" (default) computes `#acc` rows only at moments
  // something reads them; "eager" computes them at every settled moment
  // (displays that draw every moment's rows). Ordinary tuples are the same
  // either way (acc.ts). `argIndex: false` turns off the argument indexes
  // (store.ts `argIndexFor`; results are the same, for A/B checks).
  options?: { stats?: boolean; profile?: boolean; random?: () => number; lattice?: boolean; accMode?: AccMode; argIndex?: boolean },
): FixpointResult {
  // Eliminate `{...}` exception atoms first: the generated rules are part
  // of the program the handlers see.
  program = applyExceptions(program);
  const expanded = expand(program);
  const jsFuncs = compileJsDefs(expanded.jsDefs);
  const jsRelFuncs = compileJsRels(expanded.jsRels);
  const store = createStore({ lattice: options?.lattice ?? false, argIndex: options?.argIndex ?? true });
  store.tupleGas = tupleGas;
  store.stats.enabled = options?.stats === true;
  if (options?.profile === true) store.stats.cost = { entries: new Map(), cur: undefined };
  attachRules(store.stats, expanded.rules.map((r) => r.name));
  // Display bookkeeping for the timeline (plans/v2-acc-timeline-display.md):
  // which acc relations exist, and which of them some ordinary rule reads.
  for (const name of expanded.accDecls.keys()) store.accRelations.set(name, { readByRules: false });
  // A read inside `!(...)` counts too: those sub-atoms travel as terms
  // nested in the `_constrain` row an `Emit` writes. Such a read also makes
  // the acc handler demand the relation at every `_constrain` row's moment.
  const constrainReads = new Set<string>();
  const markAccReads = (t: Term): void => {
    if (t.tag !== "Atom" && t.tag !== "Id") return;
    const h = t.atom.terms[0];
    const info = h !== undefined && h.tag === "Symbol" ? store.accRelations.get(h.name) : undefined;
    if (info !== undefined) { info.readByRules = true; constrainReads.add((h as { name: string }).name); }
    for (const u of t.atom.terms) markAccReads(u);
  };
  // Relations some `not` reads (through their `_acc-at r` marker).
  const markerReads = new Set<string>();
  for (const rule of expanded.rules) {
    for (const a of rule.body) {
      if (a.tag === "Emit") {
        const eh = a.atom.terms[0];
        if (eh !== undefined && eh.tag === "Symbol" && eh.name === "_constrain") a.atom.terms.forEach(markAccReads);
        continue;
      }
      if (a.tag !== "Match") continue;
      const h = a.atom.terms[0];
      const info = h !== undefined && h.tag === "Symbol" ? store.accRelations.get(h.name) : undefined;
      if (info !== undefined) info.readByRules = true;
      if (h !== undefined && h.tag === "Symbol" && h.name === ACC_AT_HEAD) markerReads.add(accAtRelation(a.atom));
    }
  }
  // Static acc demand. A read is demanded when the evaluator reaches it
  // (eval.ts `evalMatch`), but a rule whose first match is an acc read (or a
  // `not` read's `_acc-at`) has only that read as its delta, and the
  // inner loop's empty-delta skip never runs it until rows appear there. Its
  // moment is the rule's initial anchor (`bot`): demand it up front. (A read
  // after another match is reached by the variants whose delta is earlier.)
  const rules: Rule[] = [];
  for (const rule of expanded.rules) {
    if (readsNothing(rule)) {
      rules.push({ ...rule, runOnce: true });
      continue;
    }
    const first = rule.body.find((a) => a.tag === "Match");
    const h = first?.tag === "Match" ? first.atom.terms[0] : undefined;
    if (first?.tag !== "Match" || h === undefined || h.tag !== "Symbol" ||
        !(store.accRelations.has(h.name) || h.name === ACC_AT_HEAD)) {
      rules.push(rule);
      continue;
    }
    if (first.l.tag === "Symbol" || first.l.tag === "Ref") {
      demandAcc(store, tokenOf(store, intern(store, first.l)), h.name === ACC_AT_HEAD ? accAtRelation(first.atom) : h.name);
      rules.push(rule);
    } else {
      // Not a fixed moment: never skip the rule, so the read is reached.
      rules.push({ ...rule, deltaSafeSkip: false });
    }
  }
  expanded.rules = rules;
  const compiledAcc = compileAcc(expanded);
  const accAtMemo = new Map<number, Map<string, AccRow[]> | undefined>();
  const accAt = compiledAcc.decls.size === 0 ? {} : {
    accAt: (tok: number): Map<string, AccRow[]> | undefined => {
      if (!accAtMemo.has(tok)) accAtMemo.set(tok, accRowsAt(store, compiledAcc, jsFuncs, jsRelFuncs, tok));
      return accAtMemo.get(tok);
    },
  };
  // The non-monotone part, as moment handlers (plans/v2-moment-walk.md).
  const handlers: MomentHandler[] = [
    isInputHandler(),
    choiceHandler(),
    exceptionCheckHandler(),
    // `#acc` relations (plans/v2-acc-relations.md): the snapshot at a
    // moment is fixed when it settles, once its other handlers are quiet;
    // rows are computed there or on demand (acc.ts).
    accHandler(compiledAcc, jsFuncs, jsRelFuncs, {
      mode: options?.accMode ?? "demand",
      markers: markerReads,
      constrainReads,
    }),
  ];
  let totalIters = 0;
  const rngCommits: RngCommit[] = [];

  // The run's outermost cost frame: its self time is what no rule, fold or
  // handler frame claims (the inner loop's sweep, the moment walk, choice
  // components).
  const cost = store.stats.cost;
  const frame = cost !== undefined ? costEnter(cost, "engine", 0, "engine (rest)") : undefined;
  try {
    const result = runLoop(expanded, store, gas, totalIters, jsFuncs, jsRelFuncs, handlers, options?.random, rngCommits);
    resolveExceptionProvenance(store, program.provLinks);
    return { ...result, rules: expanded.rules, ...accAt };
  } catch (e) {
    if (e instanceof GasError) {
      // Partial (gas-limited) stores feed the views too — fix up their
      // provenance as well.
      resolveExceptionProvenance(store, program.provLinks);
      return { store, iterations: totalIters, status: { kind: "gas", iterations: totalIters, tuples: store.tuples.length }, rules: expanded.rules, rngCommits, ...accAt };
    }
    throw e;
  } finally {
    if (frame !== undefined) costExit(cost!, frame);
  }
}

// Post-fixpoint provenance fixup for exception default rules
// (plans/v2-exception-default-provenance.md). A default rule re-emits a
// matched `_<p>_prime<k>` tuple under the user head with identical argument
// terms and endpoints (only the head symbol and the trailing per-firing id
// slot differ), but its Emit atom's static span is the exception's line. The
// prime tuple keeps the original assertion's span, so re-attribute each
// linked tuple by locating its prime tuple in the store and copying the
// span, following links transitively for chained exceptions. Tuples with no
// structural match (emits that escaped renaming: off-arity)
// keep their own span.
function resolveExceptionProvenance(store: Store, links: ProvLink[] | undefined): void {
  if (links === undefined || links.length === 0) return;
  // Keyed by head only — a head can carry one link per arity (`{x => e}`
  // and `{x A => e}` coexist), so resolution selects by tuple width.
  const byHead = new Map<string, ProvLink[]>();
  for (const l of links) {
    const bucket = byHead.get(l.head);
    if (bucket === undefined) byHead.set(l.head, [l]);
    else bucket.push(l);
  }
  for (const head of byHead.keys()) {
    for (const idx of candidatesByHead(store, head)) {
      const span = chaseProvSpan(store, byHead, idx);
      if (span !== undefined) store.tupleSource[idx] = span;
    }
  }
}

// Span the tuple at `idx` should adopt, or undefined to keep its own: the
// deepest tuple with a defined span reachable by following prime links.
// Chains cannot cycle — link targets are freshly minted prime names.
function chaseProvSpan(
  store: Store,
  byHead: Map<string, ProvLink[]>,
  idx: number,
): Span | undefined {
  const tup = store.tuples[idx]!;
  const width = tup.atom.terms.length;
  const link = byHead
    .get(headName(tup.atom.terms[0]))
    // Stored width = user arity + head + trailing universal id slot.
    ?.find((l) => l.arity + 2 === width);
  if (link === undefined) return undefined;
  const primeIdx = findPrimeTuple(store, link.prime, idx);
  if (primeIdx === undefined) return undefined;
  return chaseProvSpan(store, byHead, primeIdx) ?? store.tupleSource[primeIdx];
}

// The relation of a `_acc-at r _` marker read (expand.ts decomposeAccRead).
function accAtRelation(atom: { terms: Term[] }): string {
  const r = atom.terms[1];
  if (r === undefined || r.tag !== "Symbol") throw new Error("internal: '_acc-at' read without a relation");
  return r.name;
}

function headName(t: { tag: string; name?: string } | undefined): string {
  return t !== undefined && t.tag === "Symbol" && t.name !== undefined ? t.name : "";
}

// Stored prime tuple matching the tuple at `idx`: same width, equal
// argument terms after the head and excluding the trailing id slot, equal
// endpoints — all by hashcons token.
function findPrimeTuple(store: Store, prime: string, idx: number): number | undefined {
  const tup = store.tuples[idx]!;
  const width = tup.atom.terms.length;
  const lTok = tokenOf(store, tup.l);
  const rTok = tokenOf(store, tup.r);
  for (const pIdx of candidatesByHead(store, prime)) {
    const pt = store.tuples[pIdx]!;
    if (pt.atom.terms.length !== width) continue;
    if (tokenOf(store, pt.l) !== lTok || tokenOf(store, pt.r) !== rTok) continue;
    let same = true;
    for (let i = 1; i < width - 1; i++) {
      if (tokenOf(store, tup.atom.terms[i]!) !== tokenOf(store, pt.atom.terms[i]!)) {
        same = false;
        break;
      }
    }
    if (same) return pIdx;
  }
  return undefined;
}

// One-line description of an error status, for hosts (web-v2, v2-cli).
// Null for the non-error kinds.
export function describeErrorStatus(store: Store, status: FixpointStatus): string | null {
  if (status.kind === "empty-fringe-error") {
    const term = renderTermShallow(store, status.activeTerm);
    return status.deferredOnly === true
      ? `empty-fringe-error: choice ${term} has no constraint of its own — its only '!' rows also mention a choice ` +
        `asked at a later moment. Ask them at the same moment for a joint choice, or constrain it on its own`
      : `empty-fringe-error: active term ${term} has no constraint row`;
  }
  if (status.kind === "late-constraint-error") {
    const where = status.line === undefined ? "" : ` (line ${status.line})`;
    const term = renderTermShallow(store, status.activeTerm);
    return status.reason === "late"
      ? `late-constraint-error${where}: this '!' is not at the moment choice ${term} was asked — ` +
        `a '+', '~', ';' or narrowing match sits between the '?' and the '!'. Move the '!' next to its '?'`
      : `late-constraint-error${where}: this '!' ties choice ${term} to a choice asked at an unrelated moment; ` +
        `choices are resolved in temporal order, so there is no order to resolve them in`;
  }
  return null;
}

function lateConstraintStatus(store: Store, e: ConstraintPlacementError): FixpointStatus {
  return {
    kind: "late-constraint-error",
    rowIndex: e.rowIndex,
    activeTerm: e.activeTerm,
    reason: e.reason,
    line: store.tupleSource[e.rowIndex]?.line,
  };
}

function runLoop(expanded: Program, store: Store, gas: number, startIters: number, jsFuncs: Map<string, CompiledJs>, jsRelFuncs: Map<string, CompiledJsRel[]>, handlers: readonly MomentHandler[], explicitRandom: (() => number) | undefined, rngCommits: RngCommit[]): FixpointResult {
  let totalIters = startIters;
  // The random stream is latched at the first rng roll: an explicitly
  // passed options.random wins (harness control); else a program-provided
  // seed (`+ rng-seed n`, read from the store — asserted rules have run to
  // quiescence by then); else Math.random. `rng-seed` tuples appearing
  // after the latch have no effect ("seed once, at startup").
  let random: (() => number) | null = explicitRandom ?? null;
  const cost = store.stats.cost;
  const ranOnce = new Set<Rule>();
  while (true) {
    const innerIters = inFrame(cost, "inner-loop sweeps", () => innerLoop(expanded, store, gas - totalIters, jsFuncs, jsRelFuncs, ranOnce));
    totalIters += innerIters;
    if (totalIters >= gas) {
      return { store, iterations: totalIters, status: { kind: "gas", iterations: totalIters, tuples: store.tuples.length }, rngCommits };
    }

    // The moment walk (plans/v2-moment-walk.md). Each round runs every
    // handler at the frontier (minimal unresolved moments) and at any
    // resolved moment a handler demanded. Rounds that add tuples hand back
    // to the inner loop; rounds that add nothing resolve their unblocked
    // frontier moments and continue without re-running the rules (nothing
    // changed). Only when every frontier moment is blocked do the choices
    // there surface.
    let round = inFrame(cost, "walk rounds", () => runWalkRound(store, handlers));
    let resolvedProgress = false;
    while (!round.progress && !round.exhausted) {
      // A quiet round: the folds at every frontier moment have settled.
      // Settle hooks run now — before anything is marked and before choices
      // surface (acc rows; plans/v2-choice-components-by-moment.md step 6).
      // Rows written here are progress: readers must see them, and may emit
      // at the same moment (even a new `?`), so hand back to the inner loop.
      if (inFrame(cost, "walk settle", () => settleMoments(store, handlers, round.frontier))) {
        resolvedProgress = true;
        break;
      }
      const toMark = round.frontier.filter((tok) => !round.blocked.has(tok));
      if (toMark.length === 0) break;
      inFrame(cost, "walk mark resolved", () => markResolved(store, toMark));
      round = inFrame(cost, "walk rounds", () => runWalkRound(store, handlers));
    }
    if (resolvedProgress) {
      store.iteration++;
      swapHeads(store);
      continue;
    }
    if (round.exhausted) {
      // A constraint whose choices were all resolved before they surfaced
      // (saved `is` rows) was never looked at by `computeComponents`; its
      // placement is still checked.
      const misplaced = checkConstrainPlacement(store);
      if (misplaced !== null) {
        return { store, iterations: totalIters, status: lateConstraintStatus(store, misplaced), rngCommits };
      }
      return { store, iterations: totalIters, status: { kind: "done" }, rngCommits };
    }
    if (round.progress) {
      // Semi-naive: rows emitted by the handlers (acc rows, exception
      // checks, `_acc-at`) are the next inner-loop pass's delta.
      store.iteration++;
      swapHeads(store);
      continue;
    }
    // Every frontier moment (and every late demanded one) is blocked on a
    // choice. Surface the components at those moments only: a choice asked
    // at a later moment is resolved later, even when a constrain row ties it
    // to one asked here (plans/v2-choice-components-by-moment.md).
    if (round.blocked.size === 0) {
      // A round with nothing to run is `exhausted`; one with no progress and
      // no block resolves its frontier above. Only a handler that reports
      // neither for a demanded moment could land here.
      throw new Error("internal: moment walk stalled with no progress, no block, and moments pending");
    }
    const cc = inFrame(cost, "choice components", () => {
      const choices = collectBlockedChooses(store);
      const seedChoices = choices.filter((c) => round.blocked.has(tokenOf(store, c.l)));
      return computeComponents(store, choices, seedChoices, jsRelFuncs);
    });
    if (cc.kind === "late-constraint-error") {
      return { store, iterations: totalIters, status: lateConstraintStatus(store, cc), rngCommits };
    }
    if (cc.kind === "empty-fringe-error") {
      return {
        store,
        iterations: totalIters,
        status: { kind: "empty-fringe-error", choice: cc.choice, activeTerm: cc.activeTerm, deferredOnly: cc.deferredOnly },
        rngCommits,
      };
    }
    // Dead-choice resolution: a surfaced component with zero option
    // tuples can never gain any — temporal monotonicity: the component
    // is evaluated at its moment M, and no fact emitted after this
    // quiescence point can have an interval containing M. Such a
    // component is complete: mark every active term dead (`_dead-choice`
    // rows, read back by collectBlockedChooses / gatherChoiceContext as
    // resolutions) and re-enter the loop instead of blocking forever.
    // The owning asks' continuations simply never fire — the Ceptre
    // "transition not applicable" case. Applies to `you` and `rng`
    // components alike (this supersedes surfacing for empty rng
    // components, which previously fell through to active-choices).
    const emptyComps = cc.components.filter((c) => c.options.length === 0);
    if (emptyComps.length > 0) {
      for (const comp of emptyComps) {
        for (const t of comp.activeTerms) markDeadChoice(store, t);
      }
      // Semi-naive bookkeeping, mirroring the commit paths (the marker
      // rows trigger no rules, but keep every tuple in a proper
      // iteration bucket).
      store.iteration++;
      swapHeads(store);
      continue;
    }

    // rng auto-resolution (plans/v2-choice-actors.md): a component whose
    // controlling (highest) actor is `rng` is resolved by the scheduler —
    // one option tuple picked uniformly at random, all its active terms
    // committed jointly — and the loop re-enters instead of halting. Mixed
    // components (controlling actor `you`) surface untouched: the user's
    // one-at-a-time commits resolve the `you` terms first, and the
    // recomputed all-rng remainder rolls on a later round (highest actor
    // first). If nothing committed (all rng components had zero options),
    // fall through and surface everything rather than looping forever.
    const controlling = (c: ComponentOptions): Actor => c.actors.reduce(maxActor, "rng");
    const rngComps = cc.components.filter((c) => controlling(c) === "rng");
    if (rngComps.length > 0) {
      if (random === null) random = programSeededRandom(store) ?? Math.random;
      let committed = false;
      for (const comp of rngComps) {
        const got = inFrame(cost, "rng choice", () => resolveRngChoice(store, comp, random!));
        if (got !== null) {
          rngCommits.push(...got);
          committed = true;
        }
      }
      if (committed) {
        // Semi-naive: the `is` rows emitted here are the next inner-loop
        // pass's delta, mirroring the agg-result path above.
        store.iteration++;
        swapHeads(store);
        continue;
      }
    }
    return {
      store,
      iterations: totalIters,
      status: { kind: "active-choices", choices: cc.surfaced, components: cc.components },
      rngCommits,
    };
  }
}

// A rule body that reads nothing from the store (`Rule.runOnce`): no match
// of any kind, no `≤` / max / min (they consult the moment order, which
// grows), only term or js `=`, emits, order assertions and js relations.
function readsNothing(rule: Rule): boolean {
  return rule.body.every((a) =>
    a.tag === "Emit" || a.tag === "AssertLt" || a.tag === "JsIterate" ||
    (a.tag === "Equal" && a.rhs.tag !== "Max" && a.rhs.tag !== "Min"));
}

// `ran`: the `runOnce` rules already evaluated this run (they are skipped
// from then on: running one again only re-derives its tuples).
function innerLoop(program: Program, store: Store, gas: number, jsFuncs: Map<string, CompiledJs>, jsRelFuncs: Map<string, CompiledJsRel[]>, ran: Set<Rule>): number {
  let iter = 0;
  while (iter < gas) {
    const before = storeSize(store);
    const dupesBefore = store.tupleDupes;
    let rulesRan = 0;
    let rulesSkipped = 0;
    for (let i = 0; i < program.rules.length; i++) {
      const rule = program.rules[i]!;
      // Empty-delta short-circuit: if the variant's delta atom's head
      // received no inserts in the previous round, the delta bucket is
      // empty and the entire prefix walk would be wasted. Only safe
      // when no positive atom precedes the delta — otherwise we'd skip
      // the early asserts too. `deltaHead` is `undefined` for matchless
      // rules (always run) and `null` when the head is a non-Symbol.
      if (rule.runOnce === true) {
        if (ran.has(rule)) { rulesSkipped++; continue; }
        ran.add(rule);
      }
      const dh = rule.deltaHead;
      if (
        rule.deltaSafeSkip === true
        && dh !== undefined
        && dh !== null
        && !store.prevHeads.has(dh)
      ) {
        rulesSkipped++;
        const rs = store.stats.rules[i];
        if (rs !== undefined) rs.skipped++;
        continue;
      }
      rulesRan++;
      evaluateRule(rule, store, jsFuncs, jsRelFuncs, i);
    }
    const after = storeSize(store);
    store.stats.iterations.push({
      iter: store.iteration,
      tuplesAdded: after - before,
      dupes: store.tupleDupes - dupesBefore,
      rulesRan,
      rulesSkipped,
    });
    iter++;
    if (before === after) break;
    // Semi-naive: bump after a productive sweep so the rows added this
    // round become next round's `delta`. Matching v1's "increment on
    // change" rule keeps the delta bucket non-empty exactly when there's
    // new work to push through it.
    store.iteration++;
    swapHeads(store);
  }
  return iter;
}

function swapHeads(store: Store): void {
  store.prevHeads = store.currHeads;
  store.currHeads = new Set();
}

function storeSize(store: Store): number {
  return store.tuples.length + store.edgeSet.size;
}

// v2 scheduler: the non-monotone part of a program, packaged as moment
// handlers for the moment walk (moment-walk.ts, plans/v2-moment-walk.md).
// Reads store contents at outer-loop quiescence to find blocked choose rows
// and unanswered exception checks; the walk decides *when* each handler runs
// (at the minimal unresolved moments). `#acc` relations have their own
// handler (acc.ts). Knows nothing about rule continuations — paused work
// lives entirely in the store.

import type { Atom, Span, Term } from "./term.js";
import { hashconsTerm, refTagOf } from "./hashcons.js";
import {
  addOrder,
  addTuple,
  candidatesByHead,
  comparable,
  intervalContains,
  lessEq,
  tokenOf,
  type Store,
} from "./store.js";
import type { Actor, BlockedChoose, ComponentOptions, Rule, RuleAtom } from "./types.js";
import { isActor } from "./types.js";
import type { MomentHandler } from "./moment-walk.js";


// Dead-choice marker head: `_dead-choice <activeTerm>`, emitted by the
// fixpoint loop when an earliest-tier choice component has zero option
// tuples. Under the temporal-monotonicity assumption (a component's
// options are fixed once its moment is quiescent) such a component can
// never gain options, so its active terms are complete: they count as
// resolved everywhere — the owning choose rows stop blocking and their
// continuations simply never fire (no `is` row ever appears).
export const SYM_DEAD_CHOICE: Term = { tag: "Symbol", name: "_dead-choice" };

// Mark one active term dead. `(bot, top)` span, mirroring `is` commit
// rows: dead-ness is a resolution, visible for the rest of the run.
export function markDeadChoice(store: Store, activeTerm: Term): void {
  addTuple(store, { terms: [SYM_DEAD_CHOICE, activeTerm] }, store.bot, store.top);
}

// Resolved active-term tokens: `is` commits plus `_dead-choice` markers.
export function resolvedChoiceTokens(store: Store): Set<number> {
  const resolved = new Set<number>();
  for (const idx of candidatesByHead(store, "is")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    if (T === undefined) continue;
    resolved.add(tokenOf(store, T));
  }
  for (const idx of candidatesByHead(store, "_dead-choice")) {
    const t = store.tuples[idx]!;
    const T = t.atom.terms[1];
    if (T === undefined) continue;
    resolved.add(tokenOf(store, T));
  }
  return resolved;
}

// Scan store for choose rows whose wrapped atom contains at least one
// non-Symbol term lacking a matching `is <activeTerm> _` row (or a
// `_dead-choice` marker).
export function collectBlockedChooses(store: Store): BlockedChoose[] {
  const resolved = resolvedChoiceTokens(store);
  const out: BlockedChoose[] = [];
  for (const idx of candidatesByHead(store, "_choose")) {
    const t = store.tuples[idx]!;
    const chooseId = t.atom.terms[1];
    const wrappedTerm = t.atom.terms[2];
    if (chooseId === undefined || wrappedTerm === undefined) continue;
    const wrappedAtom = unwrapAtom(wrappedTerm, store);
    if (wrappedAtom === null) continue;
    // Actor column (plans/v2-choice-actors.md): stored layout is
    // `_choose chooseId (atom) actor emitId`. Default `you` for rows that
    // predate the column (hand-built stores).
    const actorTerm = t.atom.terms[3];
    const actor: Actor =
      actorTerm !== undefined && actorTerm.tag === "Symbol" && isActor(actorTerm.name)
        ? actorTerm.name
        : "you";
    const active: Term[] = [];
    collectActiveTerms(wrappedAtom, store, resolved, active);
    if (active.length > 0) {
      out.push({ rowIndex: idx, chooseId, wrappedAtom, actor, activeTerms: active, l: t.l, r: t.r });
    }
  }
  return out;
}

// One committed rng binding (plans/v2-choice-actors.md).
export interface RngCommit {
  activeTerm: Term;
  value: Term;
}

// mulberry32: a small deterministic PRNG over a 32-bit seed. Used when the
// user program seeds the rng via `+ rng-seed <n>` (plans/v2-choice-actors.md).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Program-provided rng seed: the user relation `rng-seed` with one numeric
// argument (`+ rng-seed 42`, asserted once at startup — i.e. established
// before the first rng choice; the fixpoint loop latches the stream at its
// first roll and later seed tuples have no effect). Returns a mulberry32
// stream for the seed, or null when no `rng-seed` tuple exists. Duplicate
// assertions of the same value are fine (tuples dedup by value anyway);
// distinct values or a non-numeric argument are errors.
export function programSeededRandom(store: Store): (() => number) | null {
  let seed: number | null = null;
  for (const idx of candidatesByHead(store, "rng-seed")) {
    const t = store.tuples[idx]!;
    const arg = t.atom.terms[1];
    const n = arg !== undefined && arg.tag === "Symbol" ? Number(arg.name) : NaN;
    if (!Number.isFinite(n)) {
      throw new Error("rng-seed: argument must be a number");
    }
    if (seed !== null && seed !== n) {
      throw new Error(`rng-seed: asserted with multiple values (${seed} and ${n})`);
    }
    seed = n;
  }
  return seed === null ? null : mulberry32(seed);
}

// Auto-resolve one all-`rng` choice component: pick one of its option tuples
// uniformly at random (options are deduped joint assignments — the
// distribution is uniform over joint assignments, not per-column marginals)
// and commit every active term at once with `installIs`, exactly like a
// harness-supplied `^ is X V` row. Each row carries a `(*rng <activeTerm>)`
// trailing id so arity-saturated user matches (`is C M` ⇒ stored width 4)
// see it. Returns the commits made, or null when the component has no
// options (the caller falls back to surfacing it as an active choice).
export function resolveRngChoice(
  store: Store,
  comp: ComponentOptions,
  random: () => number,
): RngCommit[] | null {
  if (comp.options.length === 0) return null;
  const pick = Math.min(comp.options.length - 1, Math.floor(random() * comp.options.length));
  const row = comp.options[pick]!;
  const isSym: Term = { tag: "Symbol", name: "is" };
  const idHead: Term = { tag: "Symbol", name: "*rng" };
  const commits: RngCommit[] = [];
  for (let i = 0; i < comp.activeTerms.length; i++) {
    const activeTerm = comp.activeTerms[i]!;
    const value = row[i]!;
    const commitId: Term = { tag: "Id", atom: { terms: [idHead, activeTerm] } };
    if (!installIs(store, activeTerm, value, commitId)) {
      throw new Error("internal: rng commit for a choice term with no '_choose' row");
    }
    commits.push({ activeTerm, value });
  }
  return commits;
}

function collectActiveTerms(atom: Atom, store: Store, resolved: Set<number>, out: Term[]): void {
  for (const term of atom.terms) {
    const t = term.tag === "Ref" ? expandRef(term, store) : term;
    if (t === null) continue;
    if (t.tag === "Symbol") continue;
    if (t.tag === "Variable" || t.tag === "Wildcard") continue; // shouldn't occur in stored rows
    if (t.tag === "Atom" || t.tag === "Id") {
      // A fresh-id term has head sym starting with `*id` or `*choose`. Treat
      // any compound atom term as a candidate active term: check resolution.
      const tok = tokenOf(store, term);
      if (!resolved.has(tok)) out.push(term);
      // Don't recurse — active terms are only at the top level of the
      // wrapped atom.
    }
  }
}

function unwrapAtom(term: Term, store: Store): Atom | null {
  let t: Term = term;
  if (t.tag === "Ref") {
    const a = store.hash.refToAtom.get(t.id);
    if (a === undefined) return null;
    return a;
  }
  if (t.tag === "Atom" || t.tag === "Id") return t.atom;
  return null;
}

function expandRef(term: Term, store: Store): Term | null {
  if (term.tag !== "Ref") return term;
  const a = store.hash.refToAtom.get(term.id);
  if (a === undefined) return null;
  // Preserve the Ref's backing tag so callers see Atom vs Id correctly.
  // (Ids are opaque per notes/v2-design.md — callers must not unfold them.)
  const tag = refTagOf(store.hash, term.id);
  return { tag, atom: a };
}

// ----- Choice inputs: `is` rows anchored at their choice -----
//
// A choice's resolution `is T V` lives on `[l, top]`, where `l` is the ask
// moment — the left end of `T`'s `_choose` row (plans/v2-caret-fresh-left.md
// §6.3). A rule reading `is T V` therefore narrows to start at or after the
// ask moment: the asking rule's continuation (`?C, …, is C M`) and any rule
// that reached `C` after the ask (`cell-choice C, is C V`) overlap and
// proceed, while a rule anchored on an episode that ended before the ask
// cannot read the value and place a consequence in the past. (A fresh moment
// strictly after the ask was tried and rejected: it is incomparable to the
// ask's other consequences, so `cell-choice C, is C V` could not join.) The harness's appended `^ is T V` source rows reach the store as
// `_is-input T V` (expand.ts); `isInputHandler` installs them, and rng
// commits go through the same `installIs`.

export const SYM_IS_INPUT: Term = { tag: "Symbol", name: "_is-input" };
const SYM_IS: Term = { tag: "Symbol", name: "is" };

// The anchor of the `_choose` row that asked each choice term (by token).
function askAnchors(store: Store): Map<number, { l: Term; r: Term }> {
  const out = new Map<number, { l: Term; r: Term }>();
  for (const idx of candidatesByHead(store, "_choose")) {
    const t = store.tuples[idx]!;
    const wrapped = t.atom.terms[2];
    if (wrapped === undefined) continue;
    const atom = unwrapAtom(wrapped, store);
    if (atom === null) continue;
    const terms: Term[] = [];
    collectActiveTerms(atom, store, new Set(), terms);
    for (const term of terms) out.set(tokenOf(store, term), { l: t.l, r: t.r });
  }
  return out;
}

// Assert `is term value <id>` from `term`'s ask moment on. False when the
// term has no `_choose` row (yet). `span` is the harness row's source line
// (none for an rng commit).
export function installIs(store: Store, term: Term, value: Term, id: Term, span?: Span): boolean {
  const anchor = askAnchors(store).get(tokenOf(store, term));
  if (anchor === undefined) return false;
  addTuple(store, { terms: [SYM_IS, term, value, id] }, anchor.l, store.top, span);
  return true;
}

interface IsInput { term: Term; value: Term; id: Term; askL: Term; span?: Span }

function pendingIsInputs(store: Store): IsInput[] {
  const installed = new Set<number>();
  for (const idx of candidatesByHead(store, "is")) {
    const T = store.tuples[idx]!.atom.terms[1];
    if (T !== undefined) installed.add(tokenOf(store, T));
  }
  const anchors = askAnchors(store);
  const out: IsInput[] = [];
  for (const idx of candidatesByHead(store, "_is-input")) {
    const t = store.tuples[idx]!;
    const [, term, value, id] = t.atom.terms;
    if (term === undefined || value === undefined || id === undefined) continue;
    if (installed.has(tokenOf(store, term))) continue;
    const anchor = anchors.get(tokenOf(store, term));
    if (anchor === undefined) continue; // asked later (or never)
    const span = store.tupleSource[idx];
    out.push(span === undefined ? { term, value, id, askL: anchor.l } : { term, value, id, askL: anchor.l, span });
  }
  return out;
}

// Installs each pending `_is-input` when the walk reaches its ask moment (a
// choice there blocks the moment until then).
export function isInputHandler(): MomentHandler {
  return {
    name: "is-input",
    run(store, m) {
      const mTok = tokenOf(store, m);
      let progress = false;
      for (const inp of pendingIsInputs(store)) {
        if (tokenOf(store, inp.askL) !== mTok) continue;
        if (installIs(store, inp.term, inp.value, inp.id, inp.span)) progress = true;
      }
      return { progress, blocked: false };
    },
    demanded(store) {
      const out = new Set<number>();
      for (const inp of pendingIsInputs(store)) out.add(tokenOf(store, inp.askL));
      return out;
    },
  };
}

// ----- Moment handlers (plans/v2-moment-walk.md) -----

// Exception default checks (expand.ts decomposeExnCheck): each `_exn-wait
// (flag pat) id` row at `[l, r]` is answered once, with `_exn-clear` when no
// `flag pat` tuple is alive at `l` and `_exn-held` otherwise. Handlers run
// only after the inner loop is quiet, so every watcher that can flag the
// tuple has fired. A wait row at an already-settled moment (a chained
// exception's default re-emitting at the tuple's own start) is `demanded`.
export function exceptionCheckHandler(): MomentHandler {
  return {
    name: "exception-check",
    run(store, m) {
      const mTok = tokenOf(store, m);
      let progress = false;
      for (const w of pendingExnWaits(store)) {
        if (tokenOf(store, w.l) !== mTok) continue;
        if (answerExnWait(store, w)) progress = true;
      }
      return { progress, blocked: false };
    },
    demanded(store) {
      const out = new Set<number>();
      for (const w of pendingExnWaits(store)) out.add(tokenOf(store, w.l));
      return out;
    },
  };
}

interface ExnWait { pattern: Term; id: Term; l: Term; r: Term }

function pendingExnWaits(store: Store): ExnWait[] {
  const answered = new Set<number>();
  for (const head of ["_exn-clear", "_exn-held"]) {
    for (const idx of candidatesByHead(store, head)) {
      const id = store.tuples[idx]!.atom.terms[2];
      if (id !== undefined) answered.add(tokenOf(store, id));
    }
  }
  const out: ExnWait[] = [];
  for (const idx of candidatesByHead(store, "_exn-wait")) {
    const t = store.tuples[idx]!;
    const pattern = t.atom.terms[1];
    const id = t.atom.terms[2];
    if (pattern === undefined || id === undefined) continue;
    if (answered.has(tokenOf(store, id))) continue;
    out.push({ pattern, id, l: t.l, r: t.r });
  }
  return out;
}

function answerExnWait(store: Store, w: ExnWait): boolean {
  const pat = expandRef(w.pattern, store);
  if (pat === null || pat.tag !== "Atom") return false;
  const [head, ...args] = pat.atom.terms;
  if (head === undefined || head.tag !== "Symbol") return false;
  const argToks = args.map((a) => tokenOf(store, a));
  let flagged = false;
  for (const idx of candidatesByHead(store, head.name)) {
    const c = store.tuples[idx]!;
    if (c.atom.terms.length !== args.length + 2) continue; // head, args, id
    if (!argToks.every((tok, i) => tokenOf(store, c.atom.terms[i + 1]!) === tok)) continue;
    if (!intervalContains(store, c.l, c.r, w.l, w.l)) continue;
    flagged = true;
    break;
  }
  const answer: Term = { tag: "Symbol", name: flagged ? "_exn-held" : "_exn-clear" };
  return addTuple(store, { terms: [answer, w.pattern, w.id] }, w.l, w.r);
}

// Choices: a moment with an unresolved `_choose` row is blocked. Surfacing,
// dead-choice marking and rng resolution stay in fixpoint.ts — they need
// the whole blocked set and end the loop. A late choose row at a resolved
// moment is `demanded` so it surfaces instead of hiding behind the frontier.
export function choiceHandler(): MomentHandler {
  return {
    name: "choice",
    run(store, m) {
      const mTok = tokenOf(store, m);
      const blocked = collectBlockedChooses(store).some((c) => tokenOf(store, c.l) === mTok);
      return { progress: false, blocked };
    },
    demanded(store) {
      const out = new Set<number>();
      for (const c of collectBlockedChooses(store)) out.add(tokenOf(store, c.l));
      return out;
    },
  };
}

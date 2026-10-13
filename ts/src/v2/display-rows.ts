// The display relations as of a moment (plans/v2-strings-icon-css.md),
// DOM-free and shared by the default display (default-display.ts) and the
// choice strip (web-v2.ts `renderChoices`), so both label an icon the same.
//
// A relation's rows at moment M: a declared `#acc` relation is computed at M
// through the run's `accAt` (demand mode stores its rows only where a rule
// read it, and never at `top`); a plain relation is the stored tuples whose
// interval contains M. Rows come back as display-kit `KitRow`s; a computed
// acc row is in no tuple, so its `idx` is -1.

import type { Store } from "./store.js";
import { candidatesByHead, intervalContains, tokenOf } from "./store.js";
import { stringValue, type Term } from "./term.js";
import { renderTerm } from "./print.js";
import type { AccRow } from "./eval.js";
import type { KitRow } from "./display-kit.js";

// The relations the default display reads.
export const DISPLAY_RELATIONS = ["icon", "icon:name", "icon:css", "at", "left:right", "above:below"];

// The run's `FixpointResult.accAt`.
export type AccAt = (tok: number, relations?: readonly string[]) => Map<string, AccRow[]> | undefined;

// A relation's rows at the moment, memoized per relation.
export type RowsAt = (head: string) => KitRow[];

export function displayRows(store: Store, M: Term, accAt: AccAt | undefined): RowsAt {
  const accRels = DISPLAY_RELATIONS.filter((r) => store.accRelations.has(r));
  const acc = accRels.length > 0 ? accAt?.(tokenOf(store, M), accRels) : undefined;
  const memo = new Map<string, KitRow[]>();
  return (head) => {
    let out = memo.get(head);
    if (out !== undefined) return out;
    const computed = acc?.get(head);
    if (computed !== undefined) {
      out = computed.map((r) => ({ idx: -1, head, terms: r.terms, l: M, r: M }));
    } else {
      out = [];
      for (const idx of candidatesByHead(store, head)) {
        const t = store.tuples[idx]!;
        if (!intervalContains(store, t.l, t.r, M, M)) continue;
        out.push({ idx, head, terms: t.atom.terms.slice(1, -1), l: t.l, r: t.r });
      }
    }
    memo.set(head, out);
    return out;
  };
}

// A term as display text: a string literal shows its value.
export function displayText(store: Store, t: Term): string {
  return stringValue(t) ?? renderTerm(store, t);
}

// `rel I V` rows (two columns) as text per tokenOf(I). Last writer wins on
// collision; an `#acc rel : e (@last v)` has one row per key.
function byFirst(store: Store, rowsAt: RowsAt, rel: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of rowsAt(rel)) {
    if (row.terms.length !== 2) continue;
    out.set(tokenOf(store, row.terms[0]!), displayText(store, row.terms[1]!));
  }
  return out;
}

// `icon:name I N`: the label for icon I.
export function iconNames(store: Store, rowsAt: RowsAt): Map<number, string> {
  return byFirst(store, rowsAt, "icon:name");
}

// `icon:css I S`: inline CSS for icon I.
export function iconStyles(store: Store, rowsAt: RowsAt): Map<number, string> {
  return byFirst(store, rowsAt, "icon:css");
}

// Every display row about term T (first column T), for its tooltip.
export function rowsAbout(store: Store, rowsAt: RowsAt, T: Term): KitRow[] {
  const key = tokenOf(store, T);
  return DISPLAY_RELATIONS.flatMap((rel) =>
    rowsAt(rel).filter((row) => row.terms.length > 0 && tokenOf(store, row.terms[0]!) === key));
}

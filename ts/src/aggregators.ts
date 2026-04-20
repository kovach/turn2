import type { Term } from "./types.js";
import { sym } from "./types.js";

export interface Aggregator {
  zero: Term;
  fold: (acc: Term, ...args: Term[]) => Term;
}

function parseIntTerm(t: Term): number {
  if (t.tag !== "Symbol") {
    throw new Error(`sum: expected numeric symbol, got ${t.tag}`);
  }
  const n = parseInt(t.name, 10);
  if (isNaN(n)) {
    throw new Error(`sum: expected numeric symbol, got "${t.name}"`);
  }
  return n;
}

export const aggregators: Map<string, Aggregator> = new Map([
  [
    "count",
    {
      zero: sym("z"),
      fold: (acc: Term) => ({ tag: "Atom", atom: { terms: [sym("s"), acc] } }),
    },
  ],
  [
    "sum",
    {
      zero: sym("0"),
      fold: (acc: Term, x: Term) => {
        const a = parseIntTerm(acc);
        const b = parseIntTerm(x);
        return sym(String(a + b));
      },
    },
  ],
  [
    "last",
    {
      zero: sym("none"),
      fold: (_acc: Term, x: Term) => x,
    },
  ],
]);

export function getAggregator(name: string): Aggregator {
  const agg = aggregators.get(name);
  if (!agg) {
    throw new Error(`unknown aggregator: "${name}"`);
  }
  return agg;
}

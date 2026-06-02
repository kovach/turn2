// Term <-> JS value boundary for user-defined `#js` functions.
// See plans/v2-user-js-functions.md.
//
// Mapping:
//   compound (pair x (f y))  <->  array ["pair", "x", ["f", "y"]]
//   Symbol "x" (non-numeric) <->  string "x"
//   Symbol "4" (numeric)      ->  number 4   (encode(4) === encode("4"))
//   boolean (encode only)     ->  Symbol "1" / "0"
//
// Keep this the single place that knows the mapping; the future nat-syntax
// feature (plans/v2-nat-syntax.md) refines the numeric cases here.

import type { Term } from "../types.js";
import { refTagOf, type HashconsState } from "../hashcons.js";

// Decode a ground Term to a JS value. Needs the hashcons store to expand Refs
// (hashconsed compounds bound by an earlier match).
export function decodeTerm(t: Term, hc: HashconsState): unknown {
  switch (t.tag) {
    case "Ref": {
      const atom = hc.refToAtom.get(t.id);
      if (atom === undefined) throw new Error(`internal: @js decode: unknown ref ${t.id}`);
      // Tag doesn't affect the JS shape (both become arrays); recurse on body.
      void refTagOf(hc, t.id);
      return atom.terms.map((x) => decodeTerm(x, hc));
    }
    case "Symbol":
      return /^-?\d+$/.test(t.name) ? Number(t.name) : t.name;
    case "Atom":
    case "Id":
      return t.atom.terms.map((x) => decodeTerm(x, hc));
    default:
      throw new Error("internal: @js arg not ground at decode");
  }
}

// Encode a JS value to a raw (un-hashconsed) Term. unifyTerms/bindable
// hashconses it when binding the JsCall's `out`, so we don't intern here.
export function encodeTerm(v: unknown): Term {
  if (typeof v === "number") return { tag: "Symbol", name: String(v) };
  if (typeof v === "string") return { tag: "Symbol", name: v };
  if (typeof v === "boolean") return { tag: "Symbol", name: v ? "1" : "0" };
  if (Array.isArray(v)) return { tag: "Atom", atom: { terms: v.map(encodeTerm) } };
  throw new Error(`@js: cannot encode return value of type ${typeof v} (${String(v)})`);
}

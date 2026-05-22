// Parses an SVG body string twice: once via DOMParser to get a live DOM
// tree, once via a regex-based pass to record the (start, end) offsets
// of coordinate attribute *values* within the body. The two are paired
// by document order of supported elements.

const DRAGGABLE_TAGS = ["circle", "rect", "line", "ellipse", "text"] as const;
type DraggableTag = typeof DRAGGABLE_TAGS[number];

const COORD_ATTRS: Record<DraggableTag, readonly string[]> = {
  circle: ["cx", "cy", "r"],
  rect: ["x", "y", "width", "height"],
  line: ["x1", "y1", "x2", "y2"],
  ellipse: ["cx", "cy", "rx", "ry"],
  text: ["x", "y"],
};

export type AttrRange = { start: number; end: number };
export type ElementEntry = {
  tag: DraggableTag;
  domEl: SVGElement;
  // Only attributes that were literally present in the source.
  ranges: Map<string, AttrRange>;
};

export type SvgIndex = {
  root: SVGSVGElement;
  elements: ElementEntry[];
};

// Iterate over draggable-tag opening tags in source order, returning
// for each: the tag name and the attribute ranges that we care about.
export type RawTag = { tag: DraggableTag; ranges: Map<string, AttrRange> };

export function scanTags(body: string): RawTag[] {
  const out: RawTag[] = [];
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body)) !== null) {
    const name = m[1]!.toLowerCase();
    if (!(DRAGGABLE_TAGS as readonly string[]).includes(name)) continue;
    const tag = name as DraggableTag;
    const wanted = new Set(COORD_ATTRS[tag]);
    const attrsText = m[2]!;
    const attrsStart = m.index + 1 + m[1]!.length; // after `<name`
    const ranges = new Map<string, AttrRange>();
    // attribute scanner: name = ( "..." | '...' | bare )
    const attrRe = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrsText)) !== null) {
      const attrName = am[1]!;
      if (!wanted.has(attrName)) continue;
      // Locate the value substring offsets within body.
      const matchStart = attrsStart + am.index;
      // Find the `=` then the value start.
      const eq = body.indexOf("=", matchStart);
      let p = eq + 1;
      while (p < body.length && /\s/.test(body[p]!)) p++;
      let valStart: number, valEnd: number;
      const ch = body[p];
      if (ch === '"' || ch === "'") {
        valStart = p + 1;
        valEnd = body.indexOf(ch, valStart);
      } else {
        valStart = p;
        valEnd = valStart;
        while (valEnd < body.length && !/[\s"'/>]/.test(body[valEnd]!)) valEnd++;
      }
      ranges.set(attrName, { start: valStart, end: valEnd });
    }
    out.push({ tag, ranges });
  }
  return out;
}

export function buildSvgIndex(body: string): SvgIndex | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "image/svg+xml");
  const root = doc.documentElement as unknown as SVGSVGElement;
  if (root.nodeName === "parsererror" || root.querySelector("parsererror")) return null;
  const raws = scanTags(body);
  // Walk DOM in document order, picking off draggable tags one by one;
  // pair with raws by position.
  const elements: ElementEntry[] = [];
  let i = 0;
  const walk = (el: Element) => {
    const name = el.localName.toLowerCase();
    if ((DRAGGABLE_TAGS as readonly string[]).includes(name)) {
      const raw = raws[i++];
      if (raw && raw.tag === name) {
        elements.push({ tag: raw.tag, domEl: el as SVGElement, ranges: raw.ranges });
      }
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);
  return { root, elements };
}

// Format a number for emitting back into source: 2 decimals max,
// trim trailing zeros and trailing dot.
export function formatCoord(n: number): string {
  let s = n.toFixed(2);
  if (s.includes(".")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

// Splice newValue into body at [range.start, range.end). Returns
// { body, delta } where delta is the change in length.
export function spliceRange(
  body: string,
  range: AttrRange,
  newValue: string,
): { body: string; delta: number } {
  const before = body.slice(0, range.start);
  const after = body.slice(range.end);
  const newBody = before + newValue + after;
  const delta = newValue.length - (range.end - range.start);
  return { body: newBody, delta };
}

// After splicing one range, shift all other ranges whose start >= the
// edited range.end, and update the edited range's end. Mutates in place.
export function shiftRangesAfter(
  allRanges: Iterable<AttrRange>,
  edited: AttrRange,
  newValueLen: number,
): void {
  const oldEnd = edited.end;
  const delta = newValueLen - (edited.end - edited.start);
  for (const r of allRanges) {
    if (r === edited) continue;
    if (r.start >= oldEnd) {
      r.start += delta;
      r.end += delta;
    }
  }
  edited.end = edited.start + newValueLen;
}

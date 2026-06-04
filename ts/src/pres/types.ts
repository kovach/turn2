export type Doc = {
  metadata: { title?: Span[]; author?: string; date?: string; theme?: "light" | "dark"; showSlideTotal?: boolean };
  slides: Slide[];
};

export type Slide = {
  title: Span[];
  blocks: Block[];
  overlayCount: number;
};

// Structured body of a [% ... %] region: a sequence of plain text and nested
// quotes. Produced by the recursive quote reader so that nested [% %] needs
// no special-case handling at any consumer. `flattenBody` is its inverse.
export type BodyPart =
  | { kind: "text"; text: string }
  | { kind: "quote"; parts: BodyPart[] };

export type Block =
  | { kind: "para"; spans: Span[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "code"; segments: Segment[]; opts: CodeOpt[] }
  | { kind: "svg"; body: string; bodyOffset: number; reveal: number; dynamic: boolean };

export type Span = {
  text: string;
  reveal: number;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};
export type ListItem = { spans: Span[]; level: number; reveal: number };
export type Segment = { text: string; reveal: number };
export type CodeOpt = "timeline" | "tuples";

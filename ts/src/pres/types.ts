export type Doc = {
  metadata: { title?: string; author?: string; date?: string; theme?: "light" | "dark" };
  slides: Slide[];
};

export type Slide = {
  title: string;
  blocks: Block[];
  overlayCount: number;
};

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

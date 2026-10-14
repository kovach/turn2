"""A small syntax highlighter for Turn (v2) source, producing HTML spans.

Token classes (styled in the report's CSS):
  c    comment                     -- ...
  d    directive                   #acc #agg #js-def #type #def
  sl   launch / continue-after     ~  ~>  >
  sa   assertion                   +  ^
  sq   choice                      ?  ?[rng]  !
  ex   exception                   {  }  =>
  op   acc rule / sequencing       /  ;  .
  ag   aggregation op              @sum @last @count ...
  n    number                      3  -7
  v    variable                    Cap  _
  b    builtin                     lt gt le ge is
  r    relation (head of an atom)
  s    other symbol
  js   javascript body of #js / #js-def
"""
import html
import re

BUILTINS = {"lt", "gt", "le", "ge", "is"}

TOKEN = re.compile(r"""
   (?P<ws>\s+)
 | (?P<c>--.*$)
 | (?P<d>\#[a-z][\w-]*)
 | (?P<ask>\?\[[a-z]+\])
 | (?P<sl>~>|~)
 | (?P<ex>=>|[{}])
 | (?P<sa>[+^])
 | (?P<sq>[?!])
 | (?P<gt>>)
 | (?P<ag>@[a-z-]+)
 | (?P<n>-?\d+(?:\.\d+)?)
 | (?P<v>[A-Z][\w']*|_\w*)
 | (?P<id>[a-z*][\w:'*/-]*[\w'*]|[a-z*])
 | (?P<op>[/;.,()=])
 | (?P<other>.)
""", re.X)

# after these tokens, the next identifier is the head of an atom
HEAD_BEFORE = {"sol", ",", "(", "{", "=>", "/", ".", ";", "sigil"}


def esc(s):
    return html.escape(s, quote=False)


def span(cls, text):
    return f'<span class="t-{cls}">{esc(text)}</span>'


def highlight_line(line, state):
    """Highlight one line. `state` carries js-body brace depth across lines."""
    if state.get("js", 0) > 0:
        depth = state["js"] + line.count("{") - line.count("}")
        state["js"] = max(depth, 0)
        return span("js", line)
    m = re.match(r"^(\s*)(#js(?:-def)?)(\s+)(.*)$", line)
    if m:
        ind, kw, sp, rest = m.groups()
        i = rest.find("{")
        head, body = (rest, "") if i < 0 else (rest[:i], rest[i:])
        depth = body.count("{") - body.count("}")
        state["js"] = max(depth, 0)
        head_html = re.sub(r"([+-])([A-Za-z]\w*)",
                           lambda mm: span("sq", mm.group(1)) + span("v", mm.group(2)),
                           esc(head))
        name = re.match(r"(\S+)(.*)", head, re.S)
        if name:
            head_html = span("r", name.group(1)) + re.sub(
                r"([+-])([A-Za-z]\w*)",
                lambda mm: f'<span class="t-sq">{mm.group(1)}</span><span class="t-v">{mm.group(2)}</span>',
                esc(name.group(2)))
        return esc(ind) + span("d", kw) + esc(sp) + head_html + (span("js", body) if body else "")

    out = []
    prev = "sol"
    pos = 0
    while pos < len(line):
        m = TOKEN.match(line, pos)
        kind = m.lastgroup
        text = m.group(kind)
        pos = m.end()
        if kind == "ws":
            out.append(esc(text))
            continue
        if kind == "c":
            out.append(span("c", text))
            continue
        if kind == "ask":
            out.append(span("sq", text)); prev = "sigil"; continue
        if kind in ("sl", "sa", "sq"):
            out.append(span(kind, text)); prev = "sigil"; continue
        if kind == "gt":
            out.append(span("sl", text)); prev = "sigil"; continue
        if kind == "ex":
            out.append(span("ex", text)); prev = text; continue
        if kind == "id":
            if text in BUILTINS:
                cls = "b"
            elif prev in HEAD_BEFORE:
                cls = "r"
            else:
                cls = "s"
            out.append(span(cls, text)); prev = "id"; continue
        if kind == "op":
            cls = "op" if text in "/;." else "p"
            out.append(span(cls, text)); prev = text; continue
        out.append(span(kind if kind in ("d", "ag", "n", "v") else "p", text))
        prev = "sigil" if kind == "d" else kind
    return "".join(out)


def highlight(src):
    state = {}
    return [highlight_line(l, state) for l in src.split("\n")]

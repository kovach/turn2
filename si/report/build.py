"""Build the Spirit Island / Turn findings report.

  python3 -I report/build.py            (run from si/)

Reads findings/*.json, special-rules.json, narrative.html and the .t sources;
writes report/spirit-island-in-turn.html (artifact body, no <html> wrapper)
and report/spirit-island-in-turn.standalone.html (same page, full document).
"""
import glob
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SI = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from turnhl import highlight  # noqa: E402

esc = lambda s: html.escape(s or "", quote=True)

STATUS = {
    "works": ("works", "Pure addition, ran and checked"),
    "works-with-hook": ("needs base hook", "Works after one change to core.t"),
    "partial": ("partial", "Approximated or a subset"),
    "not-expressible": ("not expressible", "Could not be written in Turn as it stands"),
}
EXP_ORDER = ["Base", "Branch & Claw", "Promo Pack 1", "Jagged Earth", "Promo Pack 2",
             "Horizons", "Feather & Flame", "Nature Incarnate"]

WIKI = "https://spiritislandwiki.com/index.php?title="
ARCHIVE = "https://web.archive.org/web/2025/https://spiritislandwiki.com/index.php?title="


SMALL = {"of", "the", "a", "an", "as", "to", "and", "in", "at", "for", "with", "from", "on", "into", "by", "or"}


def nice_title(name):
    words = name.lower().split()
    out = []
    for i, w in enumerate(words):
        if i and w in SMALL:
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# ------------------------------------------------------------------ sources
SOURCE_ORDER = ["run.sh", "base.t", "base-seq.t", "core.t"]


def collect_sources(findings):
    files = []
    for f in SOURCE_ORDER:
        if os.path.exists(os.path.join(SI, f)):
            files.append(f)
    files += sorted(os.path.basename(p) for p in glob.glob(os.path.join(SI, "ext-*.t")))
    order = [f["file"] for f in findings]
    for f in order:
        if f and f not in files and os.path.exists(os.path.join(SI, f)):
            files.append(f)
    for p in sorted(glob.glob(os.path.join(SI, "*.t"))):
        n = os.path.basename(p)
        if n not in files and not n.startswith(("probe", "core-s", "t-")):
            files.append(n)
    for f in findings:
        cv = f.get("core_variant")
        if cv and cv not in files and os.path.exists(os.path.join(SI, cv)):
            files.append(cv)
    return files


def file_anchor(name):
    return "src-" + slugify(name)


def line_anchor(name, n):
    return f"{file_anchor(name)}-L{n}"


def find_line(name, snippet):
    """1-based line of the snippet's first non-blank line in the file, or None."""
    path = os.path.join(SI, name)
    if not name or not os.path.exists(path):
        return None
    lines = open(path).read().split("\n")
    first = next((l.strip() for l in snippet.split("\n") if l.strip()), None)
    if not first:
        return None
    for i, l in enumerate(lines):
        if l.strip() == first:
            return i + 1
    for i, l in enumerate(lines):
        if first[:40] and first[:40] in l:
            return i + 1
    return None


def code_block(src, file=None, start=None, cls=""):
    lines = highlight(src.rstrip("\n"))
    rows = []
    for i, h in enumerate(lines):
        n = (start + i) if start else None
        if n and file:
            num = f'<a class="ln" href="#{line_anchor(file, n)}">{n}</a>'
        else:
            num = '<span class="ln"></span>'
        rows.append(f'<span class="row">{num}<span class="src">{h or " "}</span></span>')
    cap = ""
    if file:
        tgt = f"#{line_anchor(file, start)}" if start else f"#{file_anchor(file)}"
        cap = f'<figcaption><a href="{tgt}">{esc(file)}{":" + str(start) if start else ""}</a></figcaption>'
    return f'<figure class="code {cls}"><pre><code>{"".join(rows)}</code></pre>{cap}</figure>'


def appendix_file(name):
    src = open(os.path.join(SI, name)).read()
    lines = highlight(src.rstrip("\n"))
    rows = []
    for i, h in enumerate(lines, 1):
        a = line_anchor(name, i)
        rows.append(f'<span class="row" id="{a}"><a class="ln" href="#{a}">{i}</a><span class="src">{h or " "}</span></span>')
    n = len(lines)
    return (f'<section class="srcfile" id="{file_anchor(name)}"><h3><code>{esc(name)}</code>'
            f' <span class="meta">{n} lines</span></h3>'
            f'<details{" open" if name in ("core.t",) else ""}><summary>Show source</summary>'
            f'<figure class="code full"><pre><code>{"".join(rows)}</code></pre></figure></details></section>')


# ------------------------------------------------------------------ rule text
ICON_WORDS = {
    "Presence", "Sacred Site", "Dahan", "Beasts", "Blight", "Explorer", "Town", "City", "Fear",
    "Strife", "Disease", "Wilds", "Badlands", "Vitality", "Air", "Water", "Fire", "Earth",
    "Moon", "Sun", "Plant", "Animal", "Fast", "Slow", "Range",
}


def rule_text_html(t):
    t = esc(t)
    def icon(m):
        word = m.group(1).strip()
        if word.startswith("{{{"):
            return '<span class="icon glitch" title="template glitch on the wiki page">?</span>'
        cls = "icon"
        if word in ("Fast", "Fasticon"):
            word, cls = "Fast", "icon fast"
        elif word in ("Slow", "Slowicon"):
            word, cls = "Slow", "icon slow"
        elif word in ("Air", "Water", "Fire", "Earth", "Moon", "Sun", "Plant", "Animal"):
            cls = "icon el"
        elif word in ("Explorer", "Town", "City"):
            cls = "icon inv"
        return f'<span class="{cls}">{word}</span>'
    t = re.sub(r"\[\s*([^\]]+?)\s*\]", icon, t)
    t = re.sub(r"\s+([.,)])", r"\1", t)
    return t


# ------------------------------------------------------------------ main
def main():
    findings = []
    for p in sorted(glob.glob(os.path.join(SI, "findings", "*.json"))):
        try:
            findings.append(json.load(open(p)))
        except Exception as e:  # report but keep going
            print("bad json:", p, e, file=sys.stderr)
    specials = json.load(open(os.path.join(SI, "special-rules.json")))
    wiki_order = list(specials.keys())
    findings.sort(key=lambda f: (wiki_order.index(f["wiki"]) if f.get("wiki") in wiki_order else 999))

    # scoreboard
    counts = {k: 0 for k in STATUS}
    for f in findings:
        for r in f["rules"]:
            counts[r.get("status", "partial")] = counts.get(r.get("status", "partial"), 0) + 1
    total = sum(counts.values())

    # spirit overview table
    rows = []
    for f in findings:
        chips = " ".join(
            f'<a class="chip s-{esc(r.get("status"))}" href="#{slugify(f["slug"])}-{slugify(r["name"])}" '
            f'title="{esc(STATUS.get(r.get("status"), ("?",""))[1])}">{esc(nice_title(r["name"]))}</a>'
            for r in f["rules"])
        rows.append(f'<tr><td><a href="#sp-{slugify(f["slug"])}">{esc(f["spirit"])}</a></td>'
                    f'<td class="exp">{esc(f.get("expansion",""))}</td><td class="chips">{chips}</td></tr>')
    overview = ('<div class="tablewrap"><table class="overview"><thead><tr><th>Spirit</th><th>Expansion</th>'
                '<th>Special rules</th></tr></thead><tbody>' + "".join(rows) + "</tbody></table></div>")

    # per-spirit sections
    secs = []
    for f in findings:
        sid = f"sp-{slugify(f['slug'])}"
        wiki = f.get("wiki", "")
        links = (f'<a href="{WIKI}{wiki}">wiki</a> · <a href="{ARCHIVE}{wiki}">archived copy</a>'
                 f' · <a href="#{file_anchor(f["file"])}"><code>{esc(f["file"])}</code></a>')
        if f.get("core_variant"):
            links += f' · <a href="#{file_anchor(f["core_variant"])}"><code>{esc(f["core_variant"])}</code></a>'
        parts = [f'<section class="spirit" id="{sid}"><header><h3>{esc(f["spirit"])}</h3>'
                 f'<p class="meta">{esc(f.get("expansion",""))} · {links}</p></header>']
        for r in f["rules"]:
            rid = f"{slugify(f['slug'])}-{slugify(r['name'])}"
            st = r.get("status", "partial")
            line = find_line(f["file"], r.get("turn", ""))
            parts.append(
                f'<article class="rule" id="{rid}"><div class="rulehead"><h4>{esc(r["name"])}</h4>'
                f'<span class="chip s-{esc(st)}">{esc(STATUS.get(st, (st,))[0])}</span>'
                f'<span class="mech">{esc(r.get("mechanism",""))}</span></div>'
                f'<blockquote class="ruletext">{rule_text_html(r.get("text",""))}</blockquote>'
                + (code_block(r["turn"], f["file"], line) if r.get("turn") else "")
                + (f'<p class="evidence"><b>Run:</b> {esc(r["evidence"])}</p>' if r.get("evidence") else "")
                + (f'<p class="notes">{esc(r["notes"])}</p>' if r.get("notes") else "")
                + "</article>")
        if f.get("base_ext"):
            parts.append(f'<p class="baseext"><b>Rulebook machinery added alongside:</b> {esc(f["base_ext"])}</p>')
        if f.get("core_diff"):
            parts.append('<details class="diff"><summary>Change to core.t</summary><pre class="diff">'
                         + "".join(
                             f'<span class="{"add" if l.startswith("+") and not l.startswith("+++") else "del" if l.startswith("-") and not l.startswith("---") else ""}">{esc(l)}</span>\n'
                             for l in f["core_diff"].split("\n"))
                         + "</pre></details>")
        if f.get("language_issues"):
            parts.append('<ul class="issues">' + "".join(f"<li>{esc(i)}</li>" for i in f["language_issues"]) + "</ul>")
        parts.append("</section>")
        secs.append("".join(parts))

    # appendix
    files = collect_sources(findings)
    appendix_files = "".join(appendix_file(n) for n in files)
    file_index = "".join(f'<li><a href="#{file_anchor(n)}"><code>{esc(n)}</code></a></li>' for n in files)

    # issues index (all language issues, with the spirit they came from)
    issues = []
    for f in findings:
        for i in f.get("language_issues", []):
            issues.append(f'<li>{esc(i)} <a class="from" href="#sp-{slugify(f["slug"])}">{esc(f["spirit"])}</a></li>')

    narrative = open(os.path.join(HERE, "narrative.html")).read()
    sources = open(os.path.join(HERE, "sources.html")).read()
    style = open(os.path.join(HERE, "style.css")).read()

    def snippet(m):
        """{{code file start end}} -> highlighted excerpt of a source file."""
        name, a, b = m.group(1), int(m.group(2)), int(m.group(3))
        lines = open(os.path.join(SI, name)).read().split("\n")[a - 1:b]
        return code_block("\n".join(lines), name, a)

    def inline(m):
        return code_block(html.unescape(m.group(1)).strip("\n"))

    def grep_snippet(m):
        """{{grep file N text}} -> N lines starting at the first line containing text."""
        name, n, pat = m.group(1), int(m.group(2)), html.unescape(m.group(3))
        lines = open(os.path.join(SI, name)).read().split("\n")
        i = next((k for k, l in enumerate(lines) if pat in l), None)
        if i is None:
            raise SystemExit(f"narrative: {pat!r} not found in {name}")
        return code_block("\n".join(lines[i:i + n]), name, i + 1)

    by_slug = {f["slug"]: f for f in findings}

    def rulecode(m):
        """{{rulecode slug|RULE NAME|N}} -> first N lines of that rule's Turn excerpt, linked."""
        slug, name, n = m.group(1).split("|")
        f = by_slug[slug]
        r = next(r for r in f["rules"] if r["name"] == name)
        all_lines = r["turn"].split("\n")
        if "-" in n[1:]:
            a, b = n.split("-")
            lines = all_lines[int(a) - 1:int(b)]
        elif n.startswith("-"):
            lines = all_lines[int(n):]
        else:
            lines = all_lines[: int(n)]
        line = find_line(f["file"], "\n".join(lines))
        rid = f"{slugify(slug)}-{slugify(name)}"
        return (code_block("\n".join(lines), f["file"], line)
                + f'<p class="from"><a href="#{rid}">{esc(f["spirit"])}: {esc(nice_title(name))}</a></p>')

    narrative = re.sub(r"\{\{rulecode ([^}]+)\}\}", rulecode, narrative)
    narrative = re.sub(r"\{\{code (\S+) (\d+) (\d+)\}\}", snippet, narrative)
    narrative = re.sub(r"\{\{grep (\S+) (\d+) (.+?)\}\}", grep_snippet, narrative)
    narrative = re.sub(r"<turn>(.*?)</turn>", inline, narrative, flags=re.S)
    scoreboard = "".join(
        f'<div class="score s-{k}"><span class="num">{counts[k]}</span><span class="lbl">{esc(v[0])}</span></div>'
        for k, v in STATUS.items())
    bar = "".join(f'<span class="seg s-{k}" style="flex:{counts[k]}" title="{esc(STATUS[k][0])}: {counts[k]}"></span>'
                  for k in STATUS if counts[k])
    nspirits = len(findings)

    body = (narrative
            .replace("%%SCOREBOARD%%", f'<div class="scoreboard">{scoreboard}</div><div class="bar">{bar}</div>'
                     f'<p class="caption">{total} special rules across {nspirits} spirits.</p>')
            .replace("%%OVERVIEW%%", overview)
            .replace("%%SPIRITS%%", "".join(secs))
            .replace("%%ISSUES%%", '<ul class="allissues">' + "".join(issues) + "</ul>")
            .replace("%%FILEINDEX%%", f'<ul class="fileindex">{file_index}</ul>')
            .replace("%%SOURCES%%", sources)
            .replace("%%APPENDIX%%", appendix_files))

    fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alegreya+SC:wght@500;700&family=JetBrains+Mono:wght@400;600&family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&display=swap">'
    page = f"<title>Spirit Island in Turn</title>\n{fonts}\n<style>\n{style}\n</style>\n{body}\n"
    open(os.path.join(HERE, "spirit-island-in-turn.html"), "w").write(page)
    standalone = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                  + page + "</head>")
    standalone = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
                  f"<title>Spirit Island in Turn</title>{fonts}<style>{style}</style></head><body>{body}</body></html>\n")
    open(os.path.join(HERE, "spirit-island-in-turn.standalone.html"), "w").write(standalone)
    print(f"{nspirits} spirits, {total} rules, {len(files)} source files;", counts)


if __name__ == "__main__":
    main()

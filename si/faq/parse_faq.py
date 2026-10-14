import json, os, re, sys, html, urllib.parse
d = sys.argv[1]
idx = json.load(open(os.path.join(d, "index.json")))
base = "https://querki.net/raw/darker/spirit-island-faq/"

def text(fragment):
    fragment = re.sub(r"<li[^>]*>", "\n- ", fragment)
    fragment = re.sub(r"</(div|p|ol|ul)>|<br\s*/?>", "\n", fragment)
    t = html.unescape(re.sub(r"<[^>]+>", "", fragment))
    t = re.sub(r"[ \t]+", " ", t)
    return re.sub(r"\n\s*\n+", "\n", t).strip()

def field(body, name):
    m = re.search(r"<strong>" + name + r":</strong>(.*?)(<br\s*/?>|</div>)", body, re.S)
    if not m:
        return []
    return [html.unescape(re.sub(r"<[^>]+>", "", a)).strip() for a in re.findall(r"<a [^>]*>(.*?)</a>", m.group(1), re.S)] \
        or [text(m.group(1))]

out, missing = [], []
for e in idx:
    fn = os.path.join(d, "pages", urllib.parse.quote(e["href"], safe="") + ".html")
    rec = {"id": e["href"], "url": base + e["href"], "question": e["question"]}
    if not os.path.exists(fn):
        missing.append(e["href"]); out.append(rec); continue
    s = open(fn, encoding="utf-8", errors="replace").read()
    m = re.search(r'<div class="querki-content[^"]*">(.*?)<div class="para"><strong>Category:', s, re.S)
    body = s[s.find('querki-content'):]
    if m:
        ans = re.sub(r"^.*?</h4>", "", m.group(1), count=1, flags=re.S)
        ans = re.sub(r'<div class="para"><strong>Further Discussion:.*$', "", ans, flags=re.S)
        rec["answer"] = text(ans)
    rec["category"] = (field(body, "Category") or [""])[0]
    rec["tags"] = field(body, "Tags")
    rec["products"] = field(body, "Products")
    rec["created"] = (field(body, "Created") or [""])[0]
    rec["modified"] = (field(body, "Last modified") or [""])[0]
    out.append(rec)
json.dump(out, open(os.path.join(d, "faq.json"), "w"), indent=1, ensure_ascii=False)
print(len(out), "entries;", len(missing), "missing;", sum(1 for r in out if r.get("answer")), "with answers")
from collections import Counter
print(Counter(r.get("category", "?") for r in out).most_common())
print(Counter(p for r in out for p in r.get("products", [])).most_common())

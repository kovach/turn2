import json, os, sys, time, urllib.request, urllib.parse
d = sys.argv[1]
idx = json.load(open(os.path.join(d, "index.json")))
os.makedirs(os.path.join(d, "pages"), exist_ok=True)
base = "https://querki.net/raw/darker/spirit-island-faq/"
for i, e in enumerate(idx):
    fn = os.path.join(d, "pages", urllib.parse.quote(e["href"], safe="") + ".html")
    if os.path.exists(fn) and os.path.getsize(fn) > 1000:
        continue
    for attempt in range(4):
        try:
            req = urllib.request.Request(base + e["href"], headers={"User-Agent": "faq-index/1.0 (personal research)"})
            data = urllib.request.urlopen(req, timeout=40).read()
            open(fn, "wb").write(data)
            break
        except Exception as ex:
            print(i, e["href"], "retry", ex, flush=True)
            time.sleep(5 * (attempt + 1))
    time.sleep(0.4)
    if i % 50 == 0:
        print(i, flush=True)
print("done", flush=True)

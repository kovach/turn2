import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
// v2 source/display files: data/v2, then each `--v2-data <dir>` in order.
const v2Dirs = [path.join(ROOT, "data", "v2")];
// Scenario tests (v2/scenario.ts) for the editor's Tests view: every `.t` in
// each `--v2-tests <dir>`. These dirs also join the end of the v2 search
// path, so a scenario opens in the editor by name.
// `data/v2/tests` is always one (the engine's own scenarios, e.g. for ttt.t).
const testDirs: string[] = [path.join(ROOT, "data", "v2", "tests")];
let port = 3000;
let readOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--v2-data" && args[i + 1]) v2Dirs.push(path.resolve(args[++i]!));
  if (args[i] === "--v2-tests" && args[i + 1]) testDirs.push(path.resolve(args[++i]!));
  if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i]!, 10);
  if (args[i] === "--read-only") readOnly = true;
}

v2Dirs.push(...testDirs);

// The first v2 directory holding `name`, or undefined.
function findV2(name: string): string | undefined {
  return v2Dirs.map(d => path.join(d, name)).find(f => fs.existsSync(f));
}

// Every scenario file in the test dirs, read fresh so new tests show up
// without a restart. A name in two dirs is listed once (the first wins, as
// in findV2).
function scenarioFiles(): { name: string; text: string }[] {
  const out = new Map<string, string>();
  for (const d of testDirs) {
    let names: string[];
    try { names = fs.readdirSync(d).filter(f => f.endsWith(".t")).sort(); }
    catch { continue; }
    for (const n of names) {
      if (!out.has(n)) out.set(n, fs.readFileSync(path.join(d, n), "utf8"));
    }
  }
  return [...out].map(([name, text]) => ({ name, text }));
}

function mime(ext: string): string {
  if (ext === ".js") return "application/javascript";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/api/v2-tests" && method === "GET") {
    sendJson(res, 200, { tests: scenarioFiles() });
    return;
  }

  // The editor is the root page; `/v2...` are the old addresses of it.
  if (pathname === "/" || pathname === "/playground" || pathname === "/index-v2.html"
      || pathname === "/v2" || pathname === "/v2/playground") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(ROOT, "index-v2.html")));
    return;
  }

  // the links page that used to be the root
  if (pathname === "/links" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(ROOT, "index.html")));
    return;
  }

  if (pathname === "/pres" || pathname === "/index-pres.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(ROOT, "index-pres.html")));
    return;
  }

  if (pathname.startsWith("/data/pres/")) {
    const file = pathname.slice("/data/pres/".length);
    if (file.includes("..") || file.includes("/")) {
      res.writeHead(400); res.end("Invalid path");
      return;
    }
    try {
      const content = fs.readFileSync(path.join(ROOT, "data", "pres", file));
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }

  // v2 source/display files, looked up in data/v2 and then each --v2-data
  // directory. `/data/v2/*.t` is text; `/data/v2/*.js` is a display module
  // loaded via dynamic import. Plus a tiny GET/PUT API for the editor's
  // `*.t` source files.
  if (pathname.startsWith("/data/v2/")) {
    const file = pathname.slice("/data/v2/".length);
    if (file.includes("..") || file.includes("/")) {
      res.writeHead(400); res.end("Invalid path");
      return;
    }
    try {
      const content = fs.readFileSync(findV2(file) ?? path.join(v2Dirs[0]!, file));
      const ct = file.endsWith(".js")
        ? "application/javascript"
        : "text/plain; charset=utf-8";
      res.writeHead(200, { "Content-Type": ct });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }

  const v2FileMatch = pathname.match(/^\/api\/v2-file\/([^/]+)$/);
  if (v2FileMatch) {
    const name = decodeURIComponent(v2FileMatch[1]!);
    if (name.includes("..") || name.includes("/") || !name.endsWith(".t")) {
      sendJson(res, 400, { error: "invalid filename" });
      return;
    }
    // a new file goes to data/v2; an existing one is written where it was found
    const filePath = findV2(name) ?? path.join(v2Dirs[0]!, name);
    if (method === "GET") {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        sendJson(res, 200, { content });
      } catch { sendJson(res, 404, { error: "not found" }); }
      return;
    }
    if (method === "PUT") {
      if (readOnly) { sendJson(res, 403, { error: "read-only" }); return; }
      try {
        fs.writeFileSync(filePath, await readBody(req), "utf8");
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 500, { error: "write error" }); }
      return;
    }
  }

  if (pathname.startsWith("/styles/")) {
    const file = pathname.slice("/styles/".length);
    if (file.includes("..") || file.includes("/") || !file.endsWith(".css")) {
      res.writeHead(400); res.end("Invalid path");
      return;
    }
    try {
      const content = fs.readFileSync(path.join(ROOT, "styles", file));
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }

  if (pathname.startsWith("/src/")) {
    const file = pathname.slice(5);
    try {
      const content = fs.readFileSync(path.join(ROOT, "dist", file));
      res.writeHead(200, { "Content-Type": mime(path.extname(file)) });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`Slide  http://localhost:${port}`);
  console.log(`v2     ${v2Dirs.join(", ")}`);
  if (testDirs.length > 0) console.log(`tests  ${testDirs.join(", ")}`);
  if (readOnly) console.log(`Mode   read-only (file writes disabled)`);
});

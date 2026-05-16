import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
let dataDir = path.join(ROOT, "data");
let port = 3000;
let readOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--data" && args[i + 1]) dataDir = path.resolve(args[++i]!);
  if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i]!, 10);
  if (args[i] === "--read-only") readOnly = true;
}

function slFiles(): string[] {
  try {
    return fs.readdirSync(dataDir).filter(f => f.endsWith(".sl")).sort();
  } catch {
    return [];
  }
}

function safeFilename(name: string): boolean {
  return name.endsWith(".sl") && !name.includes("/") && !name.includes("..");
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

  if (pathname === "/api/files" && method === "GET") {
    sendJson(res, 200, { files: slFiles() });
    return;
  }

  const fileMatch = pathname.match(/^\/api\/file\/([^/]+)$/);
  if (fileMatch) {
    const name = decodeURIComponent(fileMatch[1]!);
    if (!safeFilename(name)) { sendJson(res, 400, { error: "invalid filename" }); return; }
    const filePath = path.join(dataDir, name);
    const exists = slFiles().includes(name);

    if (method === "GET") {
      if (!exists) { sendJson(res, 404, { error: "not found" }); return; }
      try { sendJson(res, 200, { content: fs.readFileSync(filePath, "utf8") }); }
      catch { sendJson(res, 500, { error: "read error" }); }
      return;
    }

    if (method === "PUT") {
      if (readOnly) { sendJson(res, 403, { error: "read-only" }); return; }
      if (!exists) { sendJson(res, 404, { error: "not found" }); return; }
      try { fs.writeFileSync(filePath, await readBody(req), "utf8"); sendJson(res, 200, { ok: true }); }
      catch { sendJson(res, 500, { error: "write error" }); }
      return;
    }

    if (method === "POST") {
      if (readOnly) { sendJson(res, 403, { error: "read-only" }); return; }
      if (exists) { sendJson(res, 409, { error: "already exists" }); return; }
      try { fs.writeFileSync(filePath, await readBody(req), "utf8"); sendJson(res, 200, { ok: true }); }
      catch { sendJson(res, 500, { error: "write error" }); }
      return;
    }
  }

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(ROOT, "index.html")));
    return;
  }

  if (pathname === "/v2" || pathname === "/index-v2.html" || pathname === "/v2/playground") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(ROOT, "index-v2.html")));
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

  // v2 source/display files. `/data/v2/*.t` is text; `/data/v2/*.js` is a
  // display module loaded via dynamic import. Plus a tiny GET API for the
  // editor to fetch `data/v2/*.t` source files.
  if (pathname.startsWith("/data/v2/")) {
    const file = pathname.slice("/data/v2/".length);
    if (file.includes("..") || file.includes("/")) {
      res.writeHead(400); res.end("Invalid path");
      return;
    }
    try {
      const v2Dir = path.join(ROOT, "data", "v2");
      const content = fs.readFileSync(path.join(v2Dir, file));
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
    const filePath = path.join(ROOT, "data", "v2", name);
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

  if (pathname.startsWith("/src/")) {
    const file = pathname.slice(5);
    try {
      const content = fs.readFileSync(path.join(ROOT, "dist", file));
      res.writeHead(200, { "Content-Type": mime(path.extname(file)) });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }

  if (pathname.startsWith("/data/") && pathname.endsWith(".js")) {
    const file = pathname.slice(6);
    if (file.includes("..") || file.includes("/")) {
      res.writeHead(400); res.end("Invalid path");
      return;
    }
    try {
      const content = fs.readFileSync(path.join(dataDir, file));
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`Slide  http://localhost:${port}`);
  console.log(`Data   ${dataDir}`);
  if (readOnly) console.log(`Mode   read-only (file writes disabled)`);
});

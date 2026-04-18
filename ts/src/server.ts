import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
let dataDir = path.join(ROOT, "data");
let port = 3000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--data" && args[i + 1]) dataDir = path.resolve(args[++i]!);
  if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i]!, 10);
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
      if (!exists) { sendJson(res, 404, { error: "not found" }); return; }
      try { fs.writeFileSync(filePath, await readBody(req), "utf8"); sendJson(res, 200, { ok: true }); }
      catch { sendJson(res, 500, { error: "write error" }); }
      return;
    }

    if (method === "POST") {
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
  console.log(`Data   ${dataDir}`);
});

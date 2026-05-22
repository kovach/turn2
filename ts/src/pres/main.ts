import { parse } from "./parse.js";
import { mount } from "./render.js";

async function load(): Promise<string> {
  const embedded = document.getElementById("pres-src");
  if (embedded instanceof HTMLTemplateElement) return embedded.content.textContent ?? "";
  const params = new URLSearchParams(location.search);
  const doc = params.get("doc") ?? "example.pres";
  const res = await fetch(`/data/pres/${encodeURIComponent(doc)}`);
  if (!res.ok) throw new Error(`failed to load ${doc}: ${res.status}`);
  return res.text();
}

async function main() {
  const root = document.getElementById("pres");
  if (!root) throw new Error("missing #pres element");
  try {
    const src = await load();
    const doc = parse(src);
    mount(root, doc, src);
  } catch (e) {
    root.textContent = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

main();

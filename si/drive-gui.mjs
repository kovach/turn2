// Drive the si-game GUI in headless Chromium through the Chrome DevTools
// Protocol. It plays a throwaway copy (game/si-test.t): the page records
// each choice by appending `is` rows to the file it has open. Each step clicks something in the display, waits for the
// re-run, and saves a screenshot.
//
// Needs the SI dev server (from ts/): tsx watch src/server.ts --port 5175 --v2-data ../si/game
//   node drive-gui.mjs <out-dir> <step> [<step> ...]
// steps:  btn:<text>      click the prompt button whose label contains text
//         land:<a1..a8>   click a highlighted land
//         piece:<kind>    click the first highlighted piece of that kind
//         card:<name>     click a highlighted card (by displayed name)
//         track:<energy|cards>
//         shot:<name>     save a screenshot
//         collapse        fold the editor and database panes
import { spawn } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";

const [outDir, ...steps] = process.argv.slice(2);
copyFileSync(new URL("game/si-game.t", import.meta.url), new URL("game/si-test.t", import.meta.url));
const url = `http://localhost:5175/v2?file=si-test.t`;

const port = 9333;
const chrome = spawn("chromium", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
  "--window-size=2100,1250", "--user-data-dir=/tmp/claude-1000/si-chrome-profile", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
// wait until the status line changes and the display has re-rendered
async function settle(prevStatus) {
  for (let i = 0; i < 400; i++) {
    await sleep(150);
    const s = await evaluate(`document.getElementById("status-line")?.textContent ?? ""`);
    if (s !== prevStatus && !/running/.test(s)) { await sleep(400); return s; }
  }
  throw new Error("timeout waiting for re-run");
}

try {
  let info;
  for (let i = 0; i < 50; i++) {
    try { info = await (await fetch(`http://localhost:${port}/json/list`)).json(); break; } catch { await sleep(200); }
  }
  const page = info.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.navigate", { url });
  let status = "";
  for (let i = 0; i < 200; i++) {
    await sleep(250);
    status = await evaluate(`document.getElementById("status-line")?.textContent ?? ""`);
    if (/active-choices|done|gas/.test(status) && await evaluate(`!!document.querySelector(".si")`)) break;
  }
  console.log("loaded:", status);
  for (const step of steps) {
    const [kind, arg] = [step.slice(0, step.indexOf(":") >>> 0), step.slice(step.indexOf(":") + 1)];
    if (step === "collapse" || step.startsWith("collapse:")) {
      const which = step.includes(":") ? step.split(":")[1].split(",") : ["editor", "db"];
      await evaluate(`for (const k of ${JSON.stringify(which)}) document.querySelector('[data-collapse="'+k+'"]')?.click(); true`);
      await sleep(300);
      continue;
    }
    if (kind === "eval") {
      console.log("eval:", JSON.stringify(await evaluate(arg)).slice(0, 600));
      continue;
    }
    if (kind === "wait") { await sleep(Number(arg)); continue; }
    if (kind === "shot") {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${outDir}/${arg}.png`, Buffer.from(r.data, "base64"));
      console.log("shot", arg);
      continue;
    }
    const sel = {
      btn: `[...document.querySelectorAll(".si-prompt .si-btn")].find(b => b.textContent.includes(${JSON.stringify(arg)}))`,
      land: `[...document.querySelectorAll(".si-land.pick")].find(g => g.querySelector("title").textContent.startsWith("Land " + ${JSON.stringify(arg.slice(1))} + ":"))`,
      piece: `[...document.querySelectorAll(".si-piece.pick")].find(g => g.querySelector("title").textContent.toLowerCase().startsWith(${JSON.stringify(arg)}))`,
      card: `[...document.querySelectorAll(".si-card.pick")].find(c => c.querySelector(".nm").textContent.toLowerCase() === ${JSON.stringify(arg.toLowerCase())})`,
      track: `[...document.querySelectorAll(".si-track.pick")].find(t => t.textContent.toLowerCase().includes(${JSON.stringify(arg === "energy" ? "energy" : "card")}))`,
    }[kind];
    const prompt = await evaluate(`document.querySelector(".si-prompt")?.textContent ?? ""`);
    const ok = await evaluate(`(() => { const e = ${sel}; if (!e) return false; e.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; })()`);
    if (!ok) { console.log(`step ${step}: nothing to click. prompt was: ${prompt}`); break; }
    status = await settle(status);
    const after = await evaluate(`document.querySelector(".si-prompt")?.textContent ?? ""`);
    console.log(`${step} -> ${status} | ${after.slice(0, 140)}`);
  }
} finally {
  ws?.close();
  chrome.kill();
}

// Live smoke test: drive a REAL browser through this MCP server and assert that
// the page actually changed. Offline (serves test-pages/ locally), so it needs
// no network — only a browser with the extension loaded and able to connect.
//
// Run: node mcp-server/tests/live-smoke.js
//
// Chromium/Edge recipe (fresh profile, unpacked extension, auto-connect via WS):
//   msedge.exe --user-data-dir=<tmp> --load-extension=<repo>/browser-extension \
//              --disable-extensions-except=<repo>/browser-extension --no-first-run
// Firefox: load browser-extension/manifest.json via about:debugging, click Connect.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SERVER = path.join(HERE, "..", "index.js");
const PAGES = path.join(ROOT, "test-pages");
const WS_PORT = Number(process.env.BSM_PORT) || 9777;
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT) || 8123;
const PAGE = `http://127.0.0.1:${WEB_PORT}/index.html`;

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures.push(name);
};

// --- static server for the local test pages --------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const web = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  const file = path.join(PAGES, rel);
  if (!file.startsWith(PAGES)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((resolve) => web.listen(WEB_PORT, "127.0.0.1", resolve));
console.log(`[web] serving test-pages on http://127.0.0.1:${WEB_PORT}`);

// --- MCP server over stdio -------------------------------------------------
const server = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: {
    ...process.env,
    BSM_PORT: String(WS_PORT),
    BSM_CONNECT_WAIT_MS: process.env.BSM_CONNECT_WAIT_MS ?? "45000",
    BSM_REQUEST_TIMEOUT_MS: "25000",
    BSM_QUIET: process.env.BSM_QUIET ?? "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));

let rpcId = 0;
const pending = new Map();
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++rpcId;
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const call = (name, args) =>
  rpc("tools/call", { name, arguments: args }).then((res) => {
    if (res.error) throw new Error(res.error.message);
    const text = res.result?.content?.[0]?.text ?? "";
    if (res.result?.isError) throw new Error(text);
    return text;
  });
// evaluate returns raw text for strings, so expressions are JSON-wrapped here.
const evalJson = (expression) => call("evaluate", { expression: `JSON.stringify(${expression})` }).then(JSON.parse);

server.stdout.setEncoding("utf8");
let buf = "";
server.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = msg.id !== undefined && pending.get(msg.id);
    if (!entry) continue;
    pending.delete(msg.id);
    entry(msg);
  }
});

try {
  const started = Date.now();
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "live-smoke", version: "0.0.0" },
  });
  check(
    "MCP initialize handshake",
    init.result?.serverInfo?.name === "browser-session-mcp",
    `v${init.result?.serverInfo?.version}`,
  );
  check("negotiated protocol version", init.result?.protocolVersion === "2025-06-18", init.result?.protocolVersion);

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
  check("11 tools advertised", names.length === 11, names.join(","));

  const nav = JSON.parse(await call("navigate", { url: PAGE, waitForLoad: true }));
  check("navigate reaches the browser", nav.tabId !== undefined, JSON.stringify(nav));
  console.log(`    (browser became reachable after ${Date.now() - started}ms)`);

  const snap = JSON.parse(await call("snapshot", { max: 30 }));
  check("snapshot reads the real page", snap.title === "ZCode 交互实验室", snap.title);
  check("snapshot url is the served page", snap.url === PAGE, snap.url);
  const refs = (snap.elements ?? []).map((e) => e.ref);
  check("snapshot found the target button", refs.includes("#target"), refs.slice(0, 6).join(" "));

  // click must really change page state (the page counts clicks)
  const before = await evalJson("document.getElementById('plain').textContent");
  await call("click", { ref: "#target" });
  const after = await evalJson("document.getElementById('plain').textContent");
  check("click changed real page state", Number(after) === Number(before) + 1, `${before} -> ${after}`);
  check(
    "virtual cursor was injected by the default humanMode path",
    (await evalJson("Boolean(document.getElementById('__bsm_cursor'))")) === true,
  );

  // type must go through the browser editing pipeline (trusted InputEvent)
  await call("evaluate", {
    expression: `(() => {
      const el = document.createElement('input');
      el.id = 'probe';
      document.body.appendChild(el);
      window.__last = null;
      el.addEventListener('input', (e) => { window.__last = { trusted: e.isTrusted, data: e.data, inputType: e.inputType }; });
      return true;
    })()`,
  });
  const typed = JSON.parse(await call("type", { ref: "#probe", text: "hello-世界", humanMode: false }));
  check("type reported the trusted path", typed.via === "execCommand(trusted)", JSON.stringify(typed));
  const value = await evalJson("document.getElementById('probe').value");
  check("typed text is in the input", value === "hello-世界", JSON.stringify(value));
  const inputEvent = JSON.parse(await evalJson("window.__last && JSON.stringify(window.__last)"));
  check("input event is trusted", inputEvent?.trusted === true, JSON.stringify(inputEvent));
  check("input event reports insertText", inputEvent?.inputType === "insertText", inputEvent?.inputType);

  // same-origin iframe: type + click
  await call("type", { ref: "#inner-input", text: "cross-frame", humanMode: false });
  await call("click", { ref: "#inner-btn", humanMode: false });
  const inner = await evalJson(
    "document.getElementById('demo-frame').contentDocument.getElementById('inner-status').textContent",
  );
  check("type + click worked inside an iframe", inner === "收到: cross-frame", inner);

  // only one axis supplied: Chromium rejects `undefined` args, so this guards
  // the runInPage normalization
  await call("evaluate", { expression: "document.body.style.height='3000px'" });
  const scrolled = JSON.parse(await call("scroll", { y: 300 }));
  check("scroll with a single axis works", scrolled.y > 0, JSON.stringify(scrolled));

  const tabs = JSON.parse(await call("tabs_list", {}));
  check("tabs_list sees the page", tabs.some((t) => t.url === PAGE), `${tabs.length} tab(s)`);
  check("tabs_list marks the active tab", tabs.some((t) => t.active === true));

  const shot = await call("screenshot", {});
  const file = shot.replace(/^Screenshot saved: /, "").trim();
  const exists = fs.existsSync(file);
  check("screenshot written by the server", exists, path.basename(file));
  if (exists) {
    const head = fs.readFileSync(file).subarray(0, 8);
    check("screenshot is a real PNG", head.subarray(1, 4).toString() === "PNG");
    check("screenshot is not a placeholder", fs.statSync(file).size > 5000, `${fs.statSync(file).size} bytes`);
    // SMOKE_KEEP_SCREENSHOT=1 keeps the file so a human can eyeball it.
    if (process.env.SMOKE_KEEP_SCREENSHOT === "1") console.log(`    kept: ${file}`);
    else fs.rmSync(file, { force: true });
  }

  const waited = await call("wait", { seconds: 0.2 });
  check("wait tool responds", waited.includes("Waited"), waited);
} catch (err) {
  check(`unexpected failure: ${err?.message ?? err}`, false);
} finally {
  server.kill();
  web.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll live checks passed.");
process.exit(failures.length ? 1 : 0);

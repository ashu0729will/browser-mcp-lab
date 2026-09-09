// Real-site evidence test: proves whether our current click is a "real human
// mouse" action or a synthetic DOM click, by measuring event.isTrusted on a
// live external website (example.com).
// Run: node server/test/real-trust-test.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const PORT = 9777;

const server = spawn(process.execPath, [SERVER], {
  env: { ...process.env, BML_PORT: String(PORT), BML_CONNECT_WAIT_MS: "45000", BML_QUIET: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let rpcId = 0;
const pending = new Map();
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name, args, timeoutMs = 30000) => {
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await Promise.race([
        rpc("tools/call", { name, arguments: args }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timed out`)), timeoutMs)),
      ]);
      const text = res.result?.content?.[0]?.text ?? "";
      if (res.result?.isError) throw new Error(text);
      return text;
    } catch (err) {
      lastErr = err;
      console.log(`  ${name} attempt ${i}: ${String(err.message).slice(0, 70)}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw lastErr;
};

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
    entry.resolve(msg);
  }
});

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures.push(name);
};

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "trust-test", version: "0.0.0" },
  });
  console.log("initialized; waiting for extension...");

  let connected = false;
  for (let i = 1; i <= 12 && !connected; i++) {
    try {
      await call("wait", { seconds: 0.1 }, 40000);
      connected = true;
      console.log(`extension connected (attempt ${i})`);
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!connected) throw new Error("extension never connected");

  // 1. go to a real external site
  await call("navigate", { url: "https://example.com" }, 25000).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  const href = await call("evaluate", { expression: "location.href" });
  check("on example.com", href.includes("example.com"), href.trim());

  // 2. install a click recorder (capture phase, survives bubbling tricks)
  await call("evaluate", {
    expression:
      "window.__clicks = []; document.addEventListener('click', e => window.__clicks.push({ trusted: e.isTrusted, type: e.type, x: e.clientX, y: e.clientY }), true); 'recorder installed'",
  });

  // 3. click the h1 via OUR extension tool (synthetic DOM click)
  await call("click", { ref: "h1" });
  await new Promise((r) => setTimeout(r, 300));
  let ev = await call("evaluate", { expression: "JSON.stringify(window.__clicks)" });
  const clicks = JSON.parse(ev);
  check("our click WAS delivered to the page", clicks.length >= 1, JSON.stringify(clicks));
  check(
    "PROOF: click is SYNTHETIC (isTrusted=false) — not a real human mouse",
    clicks.some((c) => c.trusted === false),
    "isTrusted=" + (clicks[0]?.trusted ?? "?"),
  );
  check(
    "PROOF: no cursor coordinates (clientX/Y both 0)",
    clicks.every((c) => c.x === 0 && c.y === 0),
    JSON.stringify(clicks.map((c) => [c.x, c.y])),
  );

  // 4. ALSO record a REAL human mouse click for contrast: ask nothing — we cannot
  //    move the user's physical mouse; this contrast is what browser-use style
  //    human mode adds (trusted events + visible cursor trajectory).
  console.log("\nSUMMARY: current click = synthetic DOM click (isTrusted=false, no cursor).");
  console.log("Human-mode upgrade (chrome.debugger Input + virtual cursor overlay) is required");
  console.log("for isTrusted=true clicks and visible mouse trajectories.");
} catch (err) {
  check(`unexpected failure: ${err?.message ?? err}`, false);
} finally {
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nEvidence collected.");

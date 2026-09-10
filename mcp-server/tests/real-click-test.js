// Real-machine test: drive OUR extension + server to actually CLICK in the
// user's Firefox. Built for Firefox's suspendable-socket reality: any single
// call may time out even though it executed — so every step verifies state and
// retries through it.
// Run: node mcp-server/tests/real-click-test.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const PORT = 9777;
const PAGE = "http://127.0.0.1:8123/index.html";

const server = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    BSM_PORT: String(PORT),
    BSM_CONNECT_WAIT_MS: "45000",
    BSM_QUIET: process.env.BSM_QUIET ?? "0",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
console.log("boot: MCP server spawning on ws://127.0.0.1:" + PORT, "pid:", server.pid);
server.on("error", (e) => console.log("SERVER SPAWN ERROR:", e.message));
setTimeout(() => {
  console.log(
    "server child state after 2s: pid", server.pid, "exitCode:", server.exitCode, "killed:", server.killed,
  );
}, 2000);

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

let rpcId = 0;
const pending = new Map();
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const rawCall = async (name, args, timeoutMs = 20000) => {
  const res = await Promise.race([
    rpc("tools/call", { name, arguments: args }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timed out`)), timeoutMs)),
  ]);
  const text = res.result?.content?.[0]?.text ?? "";
  if (res.result?.isError) throw new Error(text);
  return text;
};
// Retry a call; tolerate timeouts (the action may still have executed).
async function callRetry(name, args, tries = 4, timeoutMs = 20000) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await rawCall(name, args, timeoutMs);
    } catch (err) {
      lastErr = err;
      console.log(`  ${name} attempt ${i}: ${String(err.message).slice(0, 70)}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw lastErr;
}
async function until(fn, desc, tries = 8, delay = 2500) {
  for (let i = 1; i <= tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep polling */
    }
    console.log(`  waiting for ${desc} (${i}/${tries})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`gave up waiting for ${desc}`);
}

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures.push(name);
};

try {
  const init = await Promise.race([
    rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "real-click-test", version: "0.0.0" },
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("initialize timeout (10s)")), 10000)),
  ]);
  console.log("initialized:", init.result?.serverInfo?.name);
  console.log("initialized; waiting for extension to connect...");

  let connected = false;
  for (let i = 1; i <= 12 && !connected; i++) {
    try {
      await rawCall("wait", { seconds: 0.1 }, 40000);
      connected = true;
      console.log(`extension connected (attempt ${i})`);
    } catch {
      console.log(`attempt ${i}: not connected yet`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!connected) throw new Error("extension never connected");

  // 1. navigate (fast-responding; tolerate a dropped response) and wait for the page
  await rawCall("navigate", { url: PAGE }, 15000).catch(() => console.log("  navigate response dropped (tolerated)"));
  const href = await until(
    async () => {
      const out = await rawCall("evaluate", { expression: "location.href" }, 15000);
      return out.includes("127.0.0.1:8123") ? out : null;
    },
    "lab page to load",
  );
  check("navigated to lab page", href.includes("index.html"), href.trim());

  // 2. click the plain-click button (snapshot first to pick up the ref)
  const snap = JSON.parse(await callRetry("snapshot", {}));
  const btn = snap.elements.find((e) => e.text.includes("多功能按钮")) ?? { ref: "#target" };
  check("snapshot found 多功能按钮", Boolean(btn.ref), btn.ref);
  await callRetry("click", { ref: btn.ref });

  // 3. verify the page's own click handler really ran
  const counter = await callRetry("evaluate", {
    expression: "document.getElementById('plain').textContent",
  });
  const clicks = Number(counter.trim());
  check(`plain click counter >= 1 (real click executed)`, clicks >= 1, `got ${clicks}`);

  // 4. cross-frame: type into iframe input + click its submit
  await callRetry("type", { ref: "#inner-input", text: "真机点击测试" }, 2);
  await callRetry("click", { ref: "#inner-btn" }, 2);
  const status = await callRetry("evaluate", {
    expression:
      "document.getElementById('demo-frame').contentDocument.getElementById('inner-status').textContent",
  });
  check("iframe submit echo", status.includes("真机点击测试"), status.trim().slice(0, 40));

  // 5. screenshot for the record
  const shot = await callRetry("screenshot", {}, 1);
  console.log(shot.trim());
} catch (err) {
  check(`unexpected failure: ${err?.message ?? err}`, false);
} finally {
  server.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");

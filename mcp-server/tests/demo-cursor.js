// Visual demo: start a SLOW (5s) virtual-cursor animation on the test-pages
// page via our extension, then capture a mid-flight screenshot so the moving
// arrow and its trajectory are visible in the saved PNG.
// Run: node mcp-server/tests/demo-cursor.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const PORT = 9777;
const PAGE = "http://127.0.0.1:8123/index.html";

const server = spawn(process.execPath, [SERVER], {
  env: { ...process.env, BSM_PORT: String(PORT), BSM_CONNECT_WAIT_MS: "45000", BSM_QUIET: "1" },
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
      console.log(`  ${name} attempt ${i}: ${String(err.message).slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 2000));
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

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cursor-demo", version: "0.0.0" },
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

  await call("navigate", { url: PAGE }, 25000).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  console.log("on lab page");

  // Start a SLOW 5s animation from bottom-left to the 多功能按钮 area
  const demo = await call("evaluate", {
    expression: `(() => {
      let c = document.getElementById('__bsm_cursor');
      if (!c) {
        c = document.createElement('div');
        c.id = '__bsm_cursor';
        c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;left:80px;top:600px;';
        c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 1.5 L19.5 12 L12.2 13.4 L15.6 20.8 L12.6 22.1 L9.4 14.7 L4 19 Z" fill="#0f172a" stroke="#ffffff" stroke-width="1.3"/></svg>';
        document.body.appendChild(c);
      }
      const sx = 80, sy = 600, tx = 500, ty = 260, dur = 5000;
      const t0 = performance.now();
      function loop(now) {
        let t = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - t, 3);
        const m = 1 - e;
        const x = m*m*m*sx + 3*m*m*e*(sx+(tx-sx)*0.3) + 3*m*e*e*(sx+(tx-sx)*0.7) + e*e*e*tx;
        const y = m*m*m*sy + 3*m*m*e*(sy+(ty-sy)*0.3+100) + 3*m*e*e*(sy+(ty-sy)*0.7-60) + e*e*e*ty;
        c.style.left = x + 'px';
        c.style.top = y + 'px';
        if (t < 1) requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
      return 'slow cursor demo started (5s)';
    })()`,
  });
  console.log("demo:", demo.trim());

  // mid-flight screenshot at ~2.5s
  await new Promise((r) => setTimeout(r, 2500));
  const shot = await call("screenshot", {}, 20000);
  console.log("MID-FLIGHT", shot.trim());

  // let the animation finish, then final position screenshot
  await new Promise((r) => setTimeout(r, 3500));
  const shot2 = await call("screenshot", {}, 20000);
  console.log("FINAL", shot2.trim());
  console.log("\nDEMO-OK");
} catch (err) {
  console.error("DEMO-FAIL:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  server.kill();
}

// Verify the GitHub release exists: navigate + snapshot (no eval — CSP-safe).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const PORT = 9777;

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
async function call(name, args, timeoutMs = 35000, tries = 6) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
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
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw lastErr;
}

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
    clientInfo: { name: "verify", version: "0.0.0" },
  });
  let connected = false;
  for (let i = 1; i <= 12 && !connected; i++) {
    try {
      await call("wait", { seconds: 0.1 }, 40000, 2);
      connected = true;
      console.log(`extension connected (attempt ${i})`);
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!connected) throw new Error("extension never connected");

  await call("navigate", { url: "https://github.com/ashu0729will/browser-mcp-lab/releases/tag/v0.3.0" });
  await new Promise((r) => setTimeout(r, 2000));
  const snap = JSON.parse(await call("snapshot", {}));
  console.log("title:", snap.title);
  console.log("url:", snap.url);
  console.log("text-excerpt:", snap.text.slice(0, 400));
  const ok = snap.title.includes("v0.3.0") && (snap.text.includes("真人模式") || snap.url.includes("releases/tag"));
  console.log(ok ? "\nRELEASE-VERIFIED" : "\nVERIFY-CHECK-MANUALLY");
} catch (err) {
  console.error("VERIFY-FAIL:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  server.kill();
}

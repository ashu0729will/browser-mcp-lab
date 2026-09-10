// Firefox end-to-end: spawn the Browser Session MCP server, wait for the REAL
// extension (already loaded in Firefox) to connect via its alarms-driven
// reconnect, then call snapshot/evaluate against the live browser.
// Run: node mcp-server/tests/e2e-firefox.js   (needs the extension loaded; up to ~70s)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const PORT = 9777;

const server = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    BSM_PORT: String(PORT),
    BSM_CONNECT_WAIT_MS: "45000",
    BSM_QUIET: process.env.BSM_QUIET ?? "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let rpcId = 0;
const pending = new Map();
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name, args, timeoutMs) => {
  const res = await Promise.race([
    rpc("tools/call", { name, arguments: args }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timed out`)), timeoutMs)),
  ]);
  const text = res.result?.content?.[0]?.text ?? "";
  if (res.result?.isError) throw new Error(text);
  return text;
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
    clientInfo: { name: "e2e-firefox", version: "0.0.0" },
  });
  console.log("initialized; waiting for the Firefox extension to connect (alarms, up to ~70s)...");

  // Real agent flow: navigate first (also moves off privileged pages), then snapshot.
  let nav = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      nav = await call("navigate", { url: "https://example.com/" }, 30000);
      console.log(`attempt ${attempt}: navigate OK`);
      break;
    } catch (err) {
      console.log(`attempt ${attempt}: ${String(err.message).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!nav) throw new Error("extension never connected");
  console.log("navigate =>", nav.trim());

  const snap = await call("snapshot", {}, 20000);
  const obj = JSON.parse(snap);
  console.log("\n=== REAL FIREFOX SNAPSHOT ===");
  console.log("title:", obj.title);
  console.log("url:", obj.url);
  console.log("elements:", obj.elements?.length);
  console.log("first 3:", JSON.stringify(obj.elements?.slice(0, 3), null, 1));

  const title = await call("evaluate", { expression: "document.title" }, 15000);
  console.log("\nevaluate document.title =>", JSON.stringify(title));

  const shot = await call("screenshot", {}, 20000);
  console.log("screenshot =>", shot.trim());

  console.log("\nE2E-OK: our extension + our server control the real Firefox tab.");
} catch (err) {
  console.error("\nE2E-FAIL:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  server.kill();
}

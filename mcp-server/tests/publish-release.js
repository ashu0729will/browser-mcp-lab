// Publish the GitHub release using our own Browser Session MCP stack (extension + server),
// with per-call performance timing. Firefox must be logged into GitHub and the
// extension loaded. Run: node mcp-server/tests/publish-release.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const PORT = 9777;
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
// Release content is version-driven: the tag follows package.json and the body
// follows RELEASE-NOTES.md, so a stale literal cannot publish the wrong release.
const TAG = `v${VERSION}`;
const TITLE = `v${VERSION} — 安装、启动与连接恢复`;
const NOTES = fs.readFileSync(new URL("../../RELEASE-NOTES.md", import.meta.url), "utf8").trim();

const server = spawn(process.execPath, [SERVER], {
  env: { ...process.env, BSM_PORT: String(PORT), BSM_CONNECT_WAIT_MS: "45000", BSM_QUIET: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let rpcId = 0;
const pending = new Map();
const perf = [];
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function call(name, args, timeoutMs = 35000, tries = 8) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const res = await Promise.race([
        rpc("tools/call", { name, arguments: args }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timed out`)), timeoutMs)),
      ]);
      const ms = Date.now() - t0;
      perf.push(`${name} ${ms}ms${i > 1 ? ` (retry ${i})` : ""}`);
      const text = res.result?.content?.[0]?.text ?? "";
      if (res.result?.isError) throw new Error(text);
      return text;
    } catch (err) {
      lastErr = err;
      console.log(`  ${name} attempt ${i}: ${String(err.message).slice(0, 70)} (${Date.now() - t0}ms)`);
      await new Promise((r) => setTimeout(r, 2000));
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

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures.push(name);
};

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "release-publisher", version: "0.0.0" },
  });

  let connected = false;
  for (let i = 1; i <= 12 && !connected; i++) {
    try {
      await call("wait", { seconds: 0.1 }, 40000);
      connected = true;
      console.log(`extension connected (attempt ${i})`);
    } catch {
      console.log(`attempt ${i}: not connected yet`);
    }
  }
  if (!connected) throw new Error("extension never connected");

  // 1. open the release form (patient: survives Firefox event-page suspension,
  //    completes as soon as the user clicks 重载 in about:debugging)
  await call(
    "navigate",
    { url: `https://github.com/ashu0729will/browser-mcp-lab/releases/new?tag=${TAG}` },
    35000,
    20,
  );
  await new Promise((r) => setTimeout(r, 2500));

  // 2. locate fields
  let snap = JSON.parse(await call("snapshot", {}));
  const boxes = snap.elements.filter((e) => e.tag === "input" || e.tag === "textarea");
  console.log("textboxes:", JSON.stringify(boxes.map((b) => ({ ref: b.ref, tag: b.tag, text: b.text }))));
  const titleBox = boxes.find((b) => b.tag === "input") ?? boxes[0];
  const descBox = boxes.find((b) => b.tag === "textarea");
  if (!titleBox || !descBox) throw new Error("form fields not found in snapshot");
  check("title field located", Boolean(titleBox.ref), titleBox.ref);
  check("description field located", Boolean(descBox.ref), descBox.ref);

  // 3. fill title + notes
  await call("type", { ref: titleBox.ref, text: TITLE, clear: true });
  const titleVal = await call("evaluate", { expression: "document.getElementById('release_name') ? document.getElementById('release_name').value : 'n/a'" }).catch(() => "n/a");
  console.log("title value check:", titleVal.trim());
  await call("type", { ref: descBox.ref, text: NOTES, clear: true });

  // 4. publish
  snap = JSON.parse(await call("snapshot", {}));
  const pub = snap.elements.find((e) => e.tag === "button" && /publish release/i.test(e.text));
  if (!pub) throw new Error("Publish release button not found");
  await call("click", { ref: pub.ref, humanMode: false }); // no cursor anim on the exact click; keep it quick

  // 5. verify
  await new Promise((r) => setTimeout(r, 3500));
  const url = await call("evaluate", { expression: "location.pathname" });
  check("release page reached", url.includes(`/releases/tag/${TAG}`), url.trim());
} catch (err) {
  check(`unexpected failure: ${err?.message ?? err}`, false);
} finally {
  server.kill();
}

console.log("\n=== 性能（每次工具调用往返耗时）===");
for (const p of perf) console.log("  " + p);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");

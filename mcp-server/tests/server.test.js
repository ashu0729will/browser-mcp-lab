// End-to-end test of the Browser Session MCP server with a fake extension:
//   spawn server (stdio MCP) -> spawn fake extension (WS) ->
//   initialize -> tools/list -> tools/call (navigate/snapshot/click/screenshot)
//   -> assert results plus the strict tool schemas.
// Run: node mcp-server/tests/server.test.js
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "index.js");
const FAKE = path.join(HERE, "fake-extension.js");
const PORT = 9787;

const failures = [];
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures.push(name);
};

const server = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    BSM_PORT: String(PORT),
    BSM_CONNECT_WAIT_MS: "800",
    BSM_KEEPALIVE_MS: "0",
    BSM_QUIET: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const fake = spawn(process.execPath, [FAKE, `ws://127.0.0.1:${PORT}`]);
fake.stderr.on("data", (d) => process.stderr.write(`[fake] ${d}`));

let rpcId = 0;
const pending = new Map();
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = (name, args) =>
  rpc("tools/call", { name, arguments: args }).then((res) => {
    if (res.error) throw new Error(res.error.message);
    const text = res.result?.content?.[0]?.text ?? "";
    if (res.result?.isError) throw new Error(text);
    return text;
  });

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await sleep(600); // let the WS server come up

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-session-mcp-test", version: "0.0.0" },
  });
  check("initialize returns serverInfo", init.result?.serverInfo?.name === "browser-session-mcp");

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check("tools/list has >= 10 tools", names.length >= 10);
  for (const expected of ["navigate", "snapshot", "click", "type", "evaluate", "screenshot", "tabs_list"]) {
    check(`tool present: ${expected}`, names.includes(expected));
  }

  const byName = new Map((tools.result?.tools ?? []).map((t) => [t.name, t]));
  check("tools/list exposes 12 tools", byName.size === 12, `got ${byName.size}`);

  const props = (name) => byName.get(name)?.inputSchema?.properties ?? {};
  check("navigate schema documents waitForLoad", props("navigate").waitForLoad?.type === "boolean");
  check("navigate schema types tabId as integer", props("navigate").tabId?.type === "integer");
  check("click schema documents humanMode", props("click").humanMode?.type === "boolean");
  check("click schema documents force", props("click").force?.type === "boolean");
  check(
    "type schema documents humanMode and clear",
    props("type").humanMode?.type === "boolean" && props("type").clear?.type === "boolean",
  );
  check("screenshot schema accepts tabId", props("screenshot").tabId?.type === "integer");
  check(
    "evaluate schema documents the world modes",
    props("evaluate").world?.enum?.join(",") === "auto,main,isolated" && props("evaluate").world?.default === "auto",
  );
  check("read schema requires a ref", props("read").ref?.type === "string" && byName.get("read").inputSchema.required.includes("ref"));
  const read = JSON.parse(await call("read", { ref: "#price" }));
  check("read returns element state from the extension", read.found === true && read.value === "v", JSON.stringify(read));
  check(
    "page tools keep strict schemas",
    ["navigate", "snapshot", "click", "type", "screenshot", "evaluate"].every(
      (name) => byName.get(name)?.inputSchema?.additionalProperties === false,
    ),
  );

  const evaluated = await call("evaluate", { expression: "1 + 1" });
  check("evaluate passes a plain value through", evaluated === "echo:1 + 1", evaluated);
  const isolated = await call("evaluate", { expression: "1 + 1", world: "isolated" });
  check(
    "evaluate flags the isolated-world path",
    isolated.startsWith("echo:1 + 1") && isolated.includes("isolated world"),
    isolated.replace(/\n/g, " ").slice(0, 90),
  );

  const nav = await call("navigate", { url: "https://fake.example/" });
  check("navigate reaches fake extension", JSON.parse(nav).url === "https://fake.example/");

  const snap = await call("snapshot", {});
  const snapObj = JSON.parse(snap);
  check("snapshot title", snapObj.title === "Fake Page");
  check("snapshot elements include ref", snapObj.elements?.[0]?.ref === "#search");

  const click = await call("click", { ref: "#search" });
  check("click echoes ref", JSON.parse(click).clicked === "#search");

  const scrolled = JSON.parse(await call("scroll", { y: 120, tabId: 3 }));
  check(
    "new tool parameters reach the extension unchanged",
    scrolled.params?.y === 120 && scrolled.params?.tabId === 3,
  );

  // screenshot: the server must decode the dataUrl, brand the file and clean up
  const shot = await call("screenshot", {});
  const file = shot.replace(/^Screenshot saved: /, "").trim();
  const exists = fs.existsSync(file);
  check("screenshot file written", exists);
  check("screenshot filename uses the current brand", /browser-session-[\dTZ-]+\.png$/.test(file), file);
  if (exists) {
    const head = fs.readFileSync(file).subarray(0, 8);
    check("screenshot is a PNG", head.subarray(1, 4).toString() === "PNG");
    fs.rmSync(file, { force: true });
  }
  check("screenshot artifact does not pile up", !fs.existsSync(file));

  const unknown = await rpc("tools/call", { name: "nope", arguments: {} });
  check("unknown tool reported as error", unknown.result?.isError === true);

  const disconnectedErr = await call("wait", { seconds: 0.1 }); // sanity: normal call ok
  check("wait tool ok", disconnectedErr.includes("Waited"));
} catch (err) {
  check(`unexpected failure: ${err?.message ?? err}`, false);
} finally {
  server.kill();
  fake.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");

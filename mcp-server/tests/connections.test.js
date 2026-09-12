// Bounded stdio + fake WebSocket regression; never opens a browser/profile.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverFile = fileURLToPath(new URL("../index.js", import.meta.url));
// Read the version the release actually ships instead of a literal, so a
// version bump cannot silently desynchronise this assertion.
const VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test("offline diagnosis, multiple clients, source binding, replacement and recovery", { timeout: 20000 }, async t => {
  const port = await freePort();
  const cwd = mkdtempSync(path.join(os.tmpdir(), "bsm-connections-"));
  const sockets = [];
  const requests = new Map();
  let seq = 0;
  const child = spawn(process.execPath, [serverFile], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BSM_PORT: String(port), BSM_CONNECT_WAIT_MS: "0", BSM_KEEPALIVE_MS: "0", BSM_REQUEST_TIMEOUT_MS: "500", BSM_QUIET: "1", BSM_DISCONNECT_GRACE_MS: "50", BSM_EXIT_ON_DISCONNECT: "", BML_EXIT_ON_DISCONNECT: "" },
  });
  t.after(async () => {
    for (const socket of sockets) socket.close();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(1000)]);
    for (const entry of requests.values()) clearTimeout(entry.timer);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  child.stderr.resume();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const entry = requests.get(msg.id);
      if (entry) { requests.delete(msg.id); clearTimeout(entry.timer); entry.resolve(msg.result); }
    }
  });
  function rpc(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 4000);
      requests.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  const status = async () => (await call("connection_status")).structuredContent;
  const init = await rpc("initialize");
  assert.equal(init.serverInfo.version, VERSION);
  assert.match(init.instructions, /connection_status.*browser_select.*tabs_list.*tabId/);
  assert.equal((await status()).state, "disconnected");
  assert.match((await status()).nextAction, /Connect/);
  assert.equal((await call("tabs_list")).isError, true);

  async function connect(clientId) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.frames = [];
    ws.addEventListener("message", event => {
      const msg = JSON.parse(event.data);
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      else if (msg.id) ws.frames.push(msg);
    });
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    ws.send(JSON.stringify({ type: "hello", clientId, browser: clientId === "a" ? "Firefox" : "Edge", transport: "websocket", version: "0.4.0" }));
    await until(async () => (await status()).clients.some(c => c.clientId === clientId), "hello");
    return ws;
  }
  const a = await connect("a");
  const b = await connect("b");
  assert.equal((await status()).clients.length, 2);
  assert.equal((await status()).selectedClientId, "a", "new browser cannot steal selection");
  assert.equal((await call("browser_select", { clientId: "missing" })).isError, true);
  await call("browser_select", { clientId: "b" });
  assert.equal((await status()).selectedClientId, "b");

  let settled = false;
  const first = call("tabs_list").then(result => { settled = true; return result; });
  const frame = await until(() => b.frames.shift(), "request bound to b");
  a.send(JSON.stringify({ id: frame.id, ok: true, result: ["WRONG SOURCE"] }));
  await sleep(70);
  assert.equal(settled, false, "wrong source must not resolve pending");
  b.send(JSON.stringify({ id: frame.id, ok: true, result: ["right source"] }));
  assert.match((await first).content[0].text, /right source/);
  assert.equal(a.frames.length, 0, "no page work sent to unselected client");

  const interrupted = call("click", { ref: "#fake" });
  await until(() => b.frames.shift(), "pending action");
  b.close();
  const error = await interrupted;
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /BROWSER_DISCONNECTED.*may already have executed.*do not automatically retry/i);
  assert.equal((await status()).state, "selected_disconnected");
  assert.match((await status()).nextAction, /browser_select[\s\S]*clientId/i, "selected_disconnected must point at browser_select when another client is online");
  assert.equal((await call("tabs_list")).isError, true);
  assert.equal(a.frames.length, 0, "disconnect does not fall through to another browser");
  a.close();
  await until(async () => (await status()).clients.length === 0, "all disconnected");
  await sleep(150);
  assert.equal(child.exitCode, null, "stdio server stays alive by default");
  assert.deepEqual(await rpc("ping"), {});

  const recovered = await connect("b");
  assert.equal((await status()).state, "connected");
  const replacing = call("click", { ref: "#fake" });
  await until(() => recovered.frames.shift(), "request before replacement");
  const replacement = await connect("b");
  const replaced = await replacing;
  assert.match(replaced.content[0].text, /CONNECTION_REPLACED.*do not automatically retry/i);
  assert.equal((await status()).clients.length, 1);
  const timedOut = await call("click", { ref: "#fake" });
  assert.match(timedOut.content[0].text, /RESPONSE_TIMEOUT.*may already have executed/i);
  replacement.frames.length = 0;
  const resumed = call("tabs_list");
  const resumedFrame = await until(() => replacement.frames.shift(), "resumed request");
  replacement.send(JSON.stringify({ id: resumedFrame.id, ok: true, result: [] }));
  assert.equal((await resumed).isError, undefined);
});

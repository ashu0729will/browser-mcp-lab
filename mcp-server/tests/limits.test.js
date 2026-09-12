// Behavioral test for the outbound message cap.
// A single oversized frame makes the MCP client drop the server, after which
// every tool fails with "unknown mcp tool". The server must therefore answer an
// oversized tool result with a bounded, actionable tool error and stay healthy —
// and it must never bound its own protocol frames (tools/list) away.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";

const serverFile = fileURLToPath(new URL("../index.js", import.meta.url));
const fakeFile = fileURLToPath(new URL("./fake-extension.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FLOOR = 65536; // documented minimum for BSM_MAX_MESSAGE_BYTES
const TOOL_COUNT = 14;

async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const settled = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2000)]);

// Ambient BSM_/BML_ keys would silently change what these tests exercise.
function baseEnv(port, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(BSM|BML)_(MAX_MESSAGE_BYTES)$/.test(key)) delete env[key];
  }
  return {
    ...env,
    BSM_PORT: String(port),
    BSM_CONNECT_WAIT_MS: "4000",
    BSM_KEEPALIVE_MS: "0",
    BSM_REQUEST_TIMEOUT_MS: "8000",
    BSM_QUIET: "1",
    ...extra,
  };
}

// One server plus one fake extension, with line-exact frame capture.
async function session(t, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverFile], {
    cwd: os.tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
    env: baseEnv(port, extraEnv),
  });
  const fake = spawn(process.execPath, [fakeFile, `ws://127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(async () => {
    child.kill();
    fake.kill();
    await Promise.all([settled(child), settled(fake)]);
  });

  const frames = [];
  const waiting = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      // Measured exactly as the server writes it, newline included.
      frames.push({ line, bytes: Buffer.byteLength(line + "\n", "utf8") });
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = waiting.get(msg.id);
      if (resolve) {
        waiting.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.resume();

  let seq = 0;
  const rpc = (method, params = {}) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 10000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ id, msg });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).msg;

  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "limits-test", version: "0" } });

  const waitConnected = async () => {
    let status = null;
    // The fake extension retries a refused connect for up to 8s, so allow for it.
    for (let i = 0; i < 200; i++) {
      status = (await call("connection_status")).result?.structuredContent;
      if (status?.state === "connected") return status;
      await sleep(50);
    }
    return status;
  };

  return { child, frames, rpc, call, waitConnected };
}

test("an oversized tool result is bounded, measured in bytes, and the session survives", { timeout: 60000 }, async (t) => {
  const CAP = FLOOR;
  const { child, frames, rpc, call, waitConnected } = await session(t, { BSM_MAX_MESSAGE_BYTES: String(CAP) });

  // Tool discovery is a protocol frame, not a tool result: the cap must not eat it.
  const list = (await rpc("tools/list")).msg;
  assert.equal(list.error, undefined, `tools/list must not be bounded: ${JSON.stringify(list).slice(0, 200)}`);
  assert.equal(list.result.tools.length, TOOL_COUNT, "all tools must still be advertised at the minimum cap");

  const status = await waitConnected();
  assert.equal(status?.state, "connected", "fake extension must register");

  // 1. ASCII payload far above the cap.
  const big = "x".repeat(200000);
  const { id: bigId, msg: bounded } = await rpc("tools/call", { name: "evaluate", arguments: { expression: big } });
  await sleep(100); // let any stray chunk arrive before measuring
  assert.equal(bounded.id, bigId, "the bounded reply must keep the request id");
  assert.equal(bounded.error, undefined, "an oversized tool result is a tool error, not a protocol error");
  assert.equal(bounded.result?.isError, true, "an oversized result must be reported as a tool error");
  const text = bounded.result.content[0].text;
  assert.match(text, /RESULT_TOO_LARGE/);
  assert.match(text, /connection is still healthy/);
  assert.match(text, /BSM_MAX_MESSAGE_BYTES/, "the error must say how to change the cap");

  // 2. The cap is a byte measurement, not a character count: this payload is
  //    under the cap in JS characters but three times over it in UTF-8 bytes.
  const cjk = "汉".repeat(30000);
  assert.ok(cjk.length < CAP, "precondition: the CJK payload is under the cap in characters");
  assert.ok(Buffer.byteLength(cjk, "utf8") > CAP, "precondition: and over it in bytes");
  const { msg: cjkBounded } = await rpc("tools/call", { name: "evaluate", arguments: { expression: cjk } });
  assert.equal(cjkBounded.result?.isError, true, "the cap must be measured in UTF-8 bytes");

  // 3. Nothing on the wire ever exceeded the cap.
  const biggest = Math.max(...frames.map((f) => f.bytes));
  assert.ok(biggest <= CAP, `no frame may exceed the cap (saw ${biggest} > ${CAP})`);

  // 4. The session is still usable, and a small result is delivered untouched.
  const small = "y".repeat(200);
  const ok = await call("evaluate", { expression: small });
  assert.notEqual(ok.result?.isError, true, "a result under the cap must pass through");
  assert.equal(ok.result.content[0].text, `echo:${small}`);
  assert.equal((await call("connection_status")).result?.structuredContent?.state, "connected");
  assert.equal(child.exitCode, null, "the server must still be running");
});

test("a cap below the minimum is clamped, not applied", { timeout: 60000 }, async (t) => {
  const { rpc, waitConnected } = await session(t, { BSM_MAX_MESSAGE_BYTES: "100" });
  // 100 is below the floor; the server must clamp to the floor so that its own
  // tools/list frame still fits — otherwise every tool would disappear.
  const list = (await rpc("tools/list")).msg;
  assert.equal(list.error, undefined, "a below-minimum cap must not swallow tools/list");
  assert.equal(list.result.tools.length, TOOL_COUNT);
  const status = await waitConnected();
  assert.equal(status?.state, "connected", "fake extension must register");
  const ok = await rpc("tools/call", { name: "evaluate", arguments: { expression: "z".repeat(200) } });
  assert.equal(ok.msg.result.content[0].text, `echo:${"z".repeat(200)}`);
});

test("the default cap leaves ordinary results untouched", { timeout: 60000 }, async (t) => {
  const { frames, call, waitConnected } = await session(t);
  const status = await waitConnected();
  assert.equal(status?.state, "connected", "fake extension must register");
  // 200 KB is under the 1 MiB default cap and must not be truncated or refused.
  const medium = "w".repeat(200000);
  const ok = await call("evaluate", { expression: medium });
  assert.notEqual(ok.result?.isError, true, "results below the default cap must not be bounded");
  assert.equal(ok.result.content[0].text, `echo:${medium}`);
  assert.ok(Math.max(...frames.map((f) => f.bytes)) > 200000, "a 200 KB frame must have been sent as-is");
});

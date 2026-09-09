// Automated test of the native-messaging bridge:
//   fake browser --(stdio NM frames)--> bridge --(WS)--> fake lab server
// Verifies tool requests forward to the server, responses come back, and
// server pings are answered with pongs.
// Run: node server/test/bridge.test.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "..", "..", "native-host", "bridge.js");
const PORT = 9788;

// fake lab server (accepts the bridge's WS connection, echoes tool calls)
const { createWsServer } = await import(pathToFileURL(path.join(HERE, "..", "websocket.js")));

let serverConn = null;
let serverRequests = [];
await createWsServer({
  port: PORT,
  onConnection: (conn) => {
    conn.onmessage = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      serverRequests.push(msg);
      if (msg?.type === "ping") {
        conn.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg?.id !== undefined) {
        conn.send(JSON.stringify({ id: msg.id, ok: true, result: { echo: msg.tool, params: msg.params } }));
      }
    };
  },
});

// the bridge (browser side simulated over its stdio)
const bridge = spawn(process.execPath, [BRIDGE], {
  env: { ...process.env, BML_WS_URL: `ws://127.0.0.1:${PORT}` },
  stdio: ["pipe", "pipe", "pipe"],
});

const frames = [];
let outBuf = Buffer.alloc(0);
bridge.stdout.on("data", (chunk) => {
  outBuf = Buffer.concat([outBuf, chunk]);
  while (outBuf.length >= 4) {
    const len = outBuf.readUInt32LE(0);
    if (outBuf.length < 4 + len) break;
    frames.push(JSON.parse(outBuf.subarray(4, 4 + len).toString("utf8")));
    outBuf = outBuf.subarray(4 + len);
  }
});

function nmWrite(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  bridge.stdin.write(Buffer.concat([len, json]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures.push(name);
};

try {
  await sleep(700); // WS connect + bridge startup

  nmWrite({ id: "t1", tool: "ping", params: {} });
  await sleep(300);
  nmWrite({ id: "t2", tool: "snapshot", params: {} });
  await sleep(600);

  const r1 = frames.find((f) => f.id === "t1");
  check("t1 response forwarded back", Boolean(r1) && r1.ok === true);
  const r2 = frames.find((f) => f.id === "t2");
  check("t2 response forwarded back", Boolean(r2) && r2.ok === true && r2.result?.echo === "snapshot");

  // server-initiated ping: browser must answer pong (heartbeat roundtrip)
  nmWrite({ type: "ping" });
  await sleep(400);
  const pong = frames.find((f) => f.type === "pong");
  check("server ping answered with pong", Boolean(pong));

  check("no unexpected frames", frames.every((f) => ["t1", "t2"].includes(f.id) || f.type === "pong"));
} catch (err) {
  check(`unexpected failure: ${err?.message ?? err}`, false);
} finally {
  bridge.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
// The fake lab server keeps listening, which would hold the event loop open
// forever; exit explicitly so this script is safe inside `npm test`.
process.exit(0);

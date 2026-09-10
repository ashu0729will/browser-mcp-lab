// Automated test of the native-messaging bridge:
//   fake browser --(stdio NM frames)--> bridge --(WS)--> fake MCP server
// Verifies request forwarding, response return, heartbeat round trip, and the
// configure control frame that lets the extension move the bridge to another port.
// Run: node mcp-server/tests/bridge.test.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "..", "..", "native-messaging-host", "bridge.js");
const PORT_A = 9788;
const PORT_B = 9791;

const { createWsServer } = await import(pathToFileURL(path.join(HERE, "..", "websocket.js")));

async function startFakeServer(port, label) {
  const state = { label, requests: [], conn: null };
  await createWsServer({
    port,
    onConnection: (conn) => {
      state.conn = conn;
      conn.onmessage = (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        state.requests.push(msg);
        if (msg?.type === "ping") {
          conn.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (msg?.id !== undefined) {
          conn.send(
            JSON.stringify({
              id: msg.id,
              ok: true,
              result: { server: label, tool: msg.tool, params: msg.params },
            }),
          );
        }
      };
    },
  });
  return state;
}

const serverA = await startFakeServer(PORT_A, "A");
const serverB = await startFakeServer(PORT_B, "B");

const bridge = spawn(process.execPath, [BRIDGE], {
  env: { ...process.env, BSM_WS_URL: `ws://127.0.0.1:${PORT_A}` },
  stdio: ["pipe", "pipe", "pipe"],
});
bridge.stderr.on("data", (chunk) => {
  const text = String(chunk);
  if (!/server connected|refusing/.test(text)) process.stderr.write(`[bridge] ${text}`);
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
  check("request reaches the initially configured server", serverA.requests.some((m) => m.id === "t1"));
  const r1 = frames.find((f) => f.id === "t1");
  check("response is forwarded back to the browser", Boolean(r1) && r1.ok === true && r1.result?.server === "A");

  nmWrite({ type: "ping" });
  await sleep(400);
  check("server-initiated ping is answered with pong", Boolean(frames.find((f) => f.type === "pong")));

  // The configure frame is a bridge-local control message: consume, don't forward.
  nmWrite({ type: "configure", port: PORT_B });
  await sleep(700);
  check(
    "configure frame is not forwarded downstream",
    !serverA.requests.some((m) => m.type === "configure") &&
      !serverB.requests.some((m) => m.type === "configure"),
  );

  nmWrite({ id: "t2", tool: "snapshot", params: { max: 5 } });
  await sleep(500);
  const r2 = frames.find((f) => f.id === "t2");
  check("bridge reconnects to the newly configured port", Boolean(r2) && r2.result?.server === "B");
  check("old server receives nothing after the switch", !serverA.requests.some((m) => m.id === "t2"));
  check("tool parameters survive the bridge", r2?.result?.params?.max === 5);

  nmWrite({ type: "configure", port: 0 });
  await sleep(200);
  check(
    "invalid configure port is ignored",
    !serverA.requests.some((m) => m.type === "configure") && !serverB.requests.some((m) => m.type === "configure"),
  );
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
// The fake servers keep listening, which would hold the event loop open forever;
// exit explicitly so this script is safe inside `npm test`.
process.exit(0);

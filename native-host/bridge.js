// Native messaging bridge: extension ↔ stdio (4-byte LE length + JSON) ↔ MCP server (WS).
// Launched by the browser via bridge.bat; exits when stdin closes.
const WS_URL = process.env.BML_WS_URL || "ws://127.0.0.1:9777";

let ws = null;
const queue = [];
let dieTimer = null;

function sendToBrowser(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

function wsSend(obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function handleBrowserMessage(msg) {
  if (!wsSend(msg)) {
    queue.push(msg);
    if (queue.length > 50) queue.shift();
  }
}

function flushQueue() {
  while (queue.length && wsSend(queue.shift())) {
    /* drain */
  }
}

// --- stdin: native messaging frames from the browser ---
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const text = buf.subarray(4, 4 + len).toString("utf8");
    buf = buf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      continue;
    }
    handleBrowserMessage(msg);
  }
});
process.stdin.on("end", () => {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

// --- WS client to the lab server (Node 22+ built-in WebSocket) ---
function connectWs() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    console.error("[bridge] lab server connected");
    flushQueue();
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    // everything from the server goes to the browser (requests, pings, pongs)
    sendToBrowser(msg);
  });
  ws.addEventListener("close", () => {
    ws = null;
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 3000);
  reconnectTimer.unref?.();
}

connectWs();
// hold the process open while the browser keeps the port; stdin EOF exits above
const hold = setInterval(() => {}, 1 << 30);
hold.unref?.();

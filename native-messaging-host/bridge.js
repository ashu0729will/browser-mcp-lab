// Browser Session MCP native messaging bridge:
// browser stdio (4-byte LE length + JSON) ↔ loopback WebSocket MCP server.
// The browser owns this process; closing native-messaging stdin shuts it down.
// BSM_WS_URL only sets the initial server URL — the extension's `configure`
// frame stays authoritative, so the popup port keeps working.

const ENV_WS_URL = process.env.BSM_WS_URL || process.env.BML_WS_URL;
const MAX_QUEUE_SIZE = 50;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const RECONNECT_DELAY_MS = 3000;

let wsUrl = ENV_WS_URL || "ws://127.0.0.1:9777";
let ws = null;
let wsGeneration = 0;
let reconnectTimer = null;
let shuttingDown = false;
const queue = [];

function sendToBrowser(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

function wsSend(obj) {
  const socket = ws;
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function enqueue(obj) {
  queue.push(obj);
  if (queue.length > MAX_QUEUE_SIZE) queue.shift();
}

function flushQueue() {
  while (queue.length) {
    if (!wsSend(queue[0])) break;
    queue.shift();
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, RECONNECT_DELAY_MS);
  reconnectTimer.unref?.();
}

function replaceWsUrl(nextUrl) {
  if (nextUrl === wsUrl) return;
  wsUrl = nextUrl;
  clearReconnectTimer();
  wsGeneration += 1;
  const old = ws;
  ws = null;
  try {
    old?.close();
  } catch {
    /* already closed */
  }
  connectWs();
}

function handleBrowserMessage(msg) {
  if (msg?.type === "configure") {
    const port = Number(msg.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      replaceWsUrl(`ws://127.0.0.1:${port}`);
    }
    return; // bridge control frames are never forwarded to the MCP server
  }
  if (!wsSend(msg)) enqueue(msg);
}

// --- stdin: native messaging frames from the browser ---
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len > MAX_FRAME_BYTES) {
      console.error(`[browser-session-mcp bridge] refusing oversized native frame: ${len} bytes`);
      shutdown(1);
      return;
    }
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

// --- WS client to the MCP server (Node 22+ built-in WebSocket) ---
function connectWs() {
  if (shuttingDown || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
  if (typeof WebSocket === "undefined") {
    console.error("[browser-session-mcp bridge] Node.js 22 or newer is required");
    shutdown(1);
    return;
  }

  const generation = wsGeneration;
  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener("open", () => {
    if (shuttingDown || generation !== wsGeneration || ws !== socket) return;
    socket.wasOpen = true;
    console.error(`[browser-session-mcp bridge] server connected: ${wsUrl}`);
    flushQueue();
  });
  socket.addEventListener("message", (ev) => {
    if (generation !== wsGeneration || ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    sendToBrowser(msg);
  });
  socket.addEventListener("close", () => {
    if (generation !== wsGeneration || ws !== socket) return;
    ws = null;
    // Never carry an in-flight action/reply into a new server session.
    // Let the extension observe disconnect and establish a fresh transport.
    if (socket.wasOpen) return shutdown(0);
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (generation !== wsGeneration || ws !== socket) return;
    try {
      socket.close();
    } catch {
      ws = null;
      scheduleReconnect();
    }
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearReconnectTimer();
  wsGeneration += 1;
  const socket = ws;
  ws = null;
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
  process.exit(code);
}

process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", () => shutdown(1));
process.stdin.resume();
connectWs();

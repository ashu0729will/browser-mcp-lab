// Fake extension for testing the Browser Session MCP server without a browser.
// Connects like the real extension and answers tool calls with canned data.
// Protocol: {id, tool, params} -> {id, ok, result} | {id, ok:false, error}
import crypto from "node:crypto";

const url = process.argv[2] ?? "ws://127.0.0.1:9787";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let ws = null;

function reply(id, result) {
  ws.send(JSON.stringify({ id, ok: true, result }));
}

function hello(socket) {
  socket.send(JSON.stringify({ type: "hello", name: "fake-extension", version: "0.0.0" }));
}

function onMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  } catch {
    return;
  }
  if (msg?.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }
  if (msg?.id === undefined || typeof msg?.tool !== "string") return;
  const p = msg.params ?? {};
  switch (msg.tool) {
    case "snapshot":
      reply(msg.id, {
        title: "Fake Page",
        url: p.url ?? "https://fake.example/",
        elements: [
          { ref: "#search", tag: "input", text: "Fake search box" },
          { ref: 'a:nth-of-type(1)', tag: "a", text: "Fake link" },
        ],
        text: "This is the fake page used by the automated test.",
      });
      break;
    case "navigate":
      reply(msg.id, { tabId: 1, status: "complete", url: p.url });
      break;
    case "screenshot":
      reply(msg.id, { dataUrl: "data:image/png;base64," + TINY_PNG });
      break;
    case "click":
      reply(msg.id, { clicked: p.ref });
      break;
    case "evaluate":
      // Mirrors the real extension's contract: { value, via "main" | "isolated" }.
      reply(msg.id, {
        value: `echo:${p.expression}`,
        via: p.world === "isolated" ? "isolated" : "main",
      });
      break;
    case "read":
      reply(msg.id, { found: true, ref: p.ref, tag: "input", text: "", value: "v", attributes: {} });
      break;
    default:
      reply(msg.id, { done: true, tool: msg.tool, params: p });
  }
}

// The server may still be binding its port when a test spawns this process, so a
// refused or failed connect is retried for a bounded window instead of dying and
// stalling the test. Once opened, a later close is intentional (disconnect test)
// and is not reconnected.
const deadline = Date.now() + 8000;
let opened = false;
let retryScheduled = false;

function retry(socket) {
  if (opened) {
    socket.close();
    return;
  }
  if (retryScheduled) return;
  if (Date.now() >= deadline) {
    console.error("fake-extension: server never accepted the connection");
    process.exit(2);
  }
  retryScheduled = true;
  setTimeout(() => {
    retryScheduled = false;
    connect();
  }, 100);
}

function connect() {
  const socket = new WebSocket(url);
  ws = socket;
  socket.addEventListener("open", () => {
    opened = true;
    hello(socket);
  });
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", () => retry(socket));
  socket.addEventListener("close", () => retry(socket));
}

connect();

// keep the process alive until killed
setInterval(() => {}, 1000);
void crypto;

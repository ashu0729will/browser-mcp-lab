// Fake extension for testing the Browser Session MCP server without a browser.
// Connects like the real extension and answers tool calls with canned data.
// Protocol: {id, tool, params} -> {id, ok, result} | {id, ok:false, error}
import crypto from "node:crypto";

const url = process.argv[2] ?? "ws://127.0.0.1:9787";
const ws = new WebSocket(url);

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function reply(id, result) {
  ws.send(JSON.stringify({ id, ok: true, result }));
}

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({ type: "hello", name: "fake-extension", version: "0.0.0" }),
  );
});

ws.addEventListener("message", (ev) => {
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
});

// keep the process alive until killed
setInterval(() => {}, 1000);
void crypto;

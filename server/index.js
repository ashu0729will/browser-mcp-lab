#!/usr/bin/env node
// MCP server over stdio (JSON-RPC 2.0, newline-delimited), zero dependencies.
// Accepts the extension (or its native-messaging bridge) over loopback WebSocket.
// Protocol: { id, tool, params } -> { id, ok, result | error }; status: hello/ping/pong.
// Env: BML_PORT BML_CONNECT_WAIT_MS BML_KEEPALIVE_MS BML_REQUEST_TIMEOUT_MS BML_QUIET
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createWsServer, isPortInUse } from "./websocket.js";

const VERSION = "0.3.2";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`browser-mcp-lab-server ${VERSION}`);
  process.exit(0);
}

const intEnv = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const PORT = intEnv("BML_PORT", 9777);
const CONNECT_WAIT_MS = intEnv("BML_CONNECT_WAIT_MS", 3000);
const KEEPALIVE_MS = intEnv("BML_KEEPALIVE_MS", 5000); // fast heartbeat: keeps the
// Firefox event page from suspending (each suspension destroys pending responses)
const REQUEST_TIMEOUT_MS = intEnv("BML_REQUEST_TIMEOUT_MS", 30000);
const QUIET = process.env.BML_QUIET === "1";
// When the browser (extension) goes away, release the port by exiting after a
// grace period. Disable with BML_EXIT_ON_DISCONNECT=0.
const EXIT_ON_DISCONNECT = process.env.BML_EXIT_ON_DISCONNECT !== "0";
const DISCONNECT_GRACE_MS = intEnv("BML_DISCONNECT_GRACE_MS", 15000);

const log = (...parts) => {
  if (!QUIET) console.error(`[lab-server] ${parts.join(" ")}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Extension connection management
// ---------------------------------------------------------------------------

let conn = null; // current WsConnection from our extension
const pending = new Map(); // request id -> {resolve, reject, timer}

let disconnectTimer = null;

function adoptConnection(next) {
  if (conn && conn !== next) {
    log("replacing existing extension connection");
    try {
      conn.close(1001);
    } catch {
      /* already gone */
    }
  }
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
    log("browser came back; port-release timer cancelled");
  }
  conn = next;
  next.onmessage = (text) => handleExtensionMessage(next, text);
  next.onclose = () => {
    if (conn !== next) return; // stale socket already superseded
    conn = null;
    log("extension disconnected");
    if (EXIT_ON_DISCONNECT) {
      log(
        `no browser attached — releasing port ${PORT} in ${DISCONNECT_GRACE_MS / 1000}s ` +
          `(set BML_EXIT_ON_DISCONNECT=0 to keep waiting)`,
      );
      disconnectTimer = setTimeout(() => {
        log("browser did not come back; exiting so the port is released");
        shutdown();
      }, DISCONNECT_GRACE_MS);
      disconnectTimer.unref?.();
    }
  };
  log("extension connected");
  if (KEEPALIVE_MS > 0) sendKeepalive(next);
}

function handleExtensionMessage(source, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // not JSON — ignore
  }
  if (msg?.type === "hello") {
    log(`extension hello: ${msg.name ?? "?"} v${msg.version ?? "?"}`);
    return;
  }
  if (msg?.type === "ping") {
    // Roundtrip heartbeat: replying proves this socket is alive end-to-end.
    try {
      source.send(JSON.stringify({ type: "pong" }));
    } catch {
      /* dying connection */
    }
    return;
  }
  if (msg?.type !== undefined) return; // pong / future status frames
  const requestId = msg?.id;
  const entry = requestId !== undefined && pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  if (msg.ok === false) entry.reject(new Error(String(msg.error ?? "extension error")));
  else entry.resolve(msg.result);
}

async function acquireConnection(waitMs = CONNECT_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (conn && conn.open) return conn;
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

async function sendToExtension(tool, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const started = Date.now();
  const target = await acquireConnection();
  if (!target || !target.open) {
    throw new Error(
      `No connection to the browser extension (waited ${Date.now() - started}ms). ` +
        `Open the browser and click the "Browser MCP Lab" extension icon, then press Connect. ` +
        `If it claims to be connected already, toggle Disconnect then Connect to revive the MV3 worker.`,
    );
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Extension response timeout after ${timeoutMs}ms (tool: ${tool})`));
          }, timeoutMs)
        : undefined;
    pending.set(id, { resolve, reject, timer });
    try {
      target.send(JSON.stringify({ id, tool, params }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`WebSocket error occurred: ${err.message}`));
    }
  });
}

// App-level keepalive: any incoming frame resets Chrome's MV3 worker idle
// timer, which is what kills the extension's socket when it goes quiet.
function sendKeepalive(target) {
  try {
    if (!target.open) return;
    target.send(JSON.stringify({ type: "ping" }));
  } catch {
    /* connection is dying; the sweep below will clean it up */
  }
}

const keepaliveTimer =
  KEEPALIVE_MS > 0
    ? setInterval(() => {
        if (conn && conn.open) {
          sendKeepalive(conn);
          conn.ping();
          if (Date.now() - conn.lastActivity > 2.5 * KEEPALIVE_MS) {
            log("extension connection appears dead (no activity), closing it");
            conn.destroy();
            conn = null;
          }
        }
      }, KEEPALIVE_MS)
    : null;
if (keepaliveTimer) keepaliveTimer.unref();

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const text = (t) => ({ content: [{ type: "text", text: t }] });

function saveScreenshot(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Extension returned no PNG screenshot data");
  const dir = path.join(process.cwd(), "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lab-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  fs.writeFileSync(file, Buffer.from(match[1], "base64"));
  return file;
}

const TOOLS = [
  {
    name: "navigate",
    description: "Navigate the active tab (or a given tabId) to a URL",
    inputSchema: obj(
      {
        url: { type: "string", description: "The URL to navigate to" },
        tabId: { type: "number", description: "Optional tab id (defaults to active tab)" },
      },
      ["url"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("navigate", args))),
  },
  {
    name: "snapshot",
    description:
      "Capture the current page: title, url, interactive elements (each with a CSS-selector `ref` you can pass to click/type) and a plain-text excerpt. This is how you find targets.",
    inputSchema: obj({
      max: {
        type: "number",
        description: "Maximum interactive elements to return (default 80; raise it on dense pages)",
      },
    }),
    handle: async (args) => text(JSON.stringify(await sendToExtension("snapshot", args), null, 1)),
  },
  {
    name: "click",
    description:
      "Click an element. `ref` is the CSS selector returned by snapshot (any CSS selector works). Set force:true to click through a client-side disabled state (removes disabled/aria-disabled in the same task before clicking; server-side validation still applies).",
    inputSchema: obj(
      {
        ref: { type: "string", description: "CSS selector of the element" },
        force: {
          type: "boolean",
          description: "Bypass a client-side `disabled` gate before clicking (default false)",
        },
      },
      ["ref"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("click", args))),
  },
  {
    name: "type",
    description:
      "Type text into an editable element (input/textarea/contenteditable). Uses the browser's own editing pipeline in the page's MAIN world, so the resulting InputEvent is trusted; falls back to synthetic per-character events when the page refuses.",
    inputSchema: obj(
      {
        ref: { type: "string", description: "CSS selector of the element" },
        text: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Replace existing text (default true); false appends" },
      },
      ["ref", "text"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("type", args))),
  },
  {
    name: "press_key",
    description:
      "Best-effort key press on the currently focused element (synthetic KeyboardEvent; some pages ignore synthetic keys)",
    inputSchema: obj({ key: { type: "string", description: "Key value, e.g. Enter, ArrowLeft, a" } }, ["key"]),
    handle: async (args) => text(JSON.stringify(await sendToExtension("press_key", args))),
  },
  {
    name: "evaluate",
    description:
      "Evaluate a JavaScript expression in the page (MAIN world) and return the JSON-serializable result",
    inputSchema: obj(
      { expression: { type: "string", description: "JS expression, e.g. document.title" } },
      ["expression"],
    ),
    handle: async (args) => {
      const result = await sendToExtension("evaluate", args);
      return text(
        typeof result === "string" ? result : JSON.stringify(result, null, 1) ?? "undefined",
      );
    },
  },
  {
    name: "screenshot",
    description: "Capture the visible tab as PNG; saved under ./screenshots/ and the file path is returned",
    inputSchema: obj({}),
    handle: async () => {
      const { dataUrl } = await sendToExtension("screenshot", {});
      const file = saveScreenshot(dataUrl);
      return text(`Screenshot saved: ${file}`);
    },
  },
  {
    name: "scroll",
    description: "Scroll the page by the given pixels (defaults to one viewport down)",
    inputSchema: obj({ x: { type: "number" }, y: { type: "number" } }),
    handle: async (args) => text(JSON.stringify(await sendToExtension("scroll", args))),
  },
  {
    name: "tabs_list",
    description: "List open tabs (id, title, url, active)",
    inputSchema: obj({}),
    handle: async () => text(JSON.stringify(await sendToExtension("tabs_list", {}), null, 1)),
  },
  {
    name: "tab_select",
    description: "Bring a tab to the front",
    inputSchema: obj({ tabId: { type: "number", description: "Tab id from tabs_list" } }, ["tabId"]),
    handle: async (args) => text(JSON.stringify(await sendToExtension("tab_select", args))),
  },
  {
    name: "wait",
    description: "Wait for a specified time in seconds",
    inputSchema: obj({ seconds: { type: "number" } }, ["seconds"]),
    handle: async ({ seconds = 1 }) => {
      await sleep(Math.min(Number(seconds) || 0, 60) * 1000);
      return text(`Waited for ${seconds} seconds`);
    },
  },
];

// ---------------------------------------------------------------------------
// MCP over stdio (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) =>
  write({ jsonrpc: "2.0", id, error: { code, message } });

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "browser-mcp-lab-server", version: VERSION },
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return reply(id, {
          content: [{ type: "text", text: `Tool "${name}" not found` }],
          isError: true,
        });
      }
      try {
        return reply(id, await tool.handle(args));
      } catch (err) {
        return reply(id, {
          content: [{ type: "text", text: String(err?.message ?? err) }],
          isError: true,
        });
      }
    }
    // Not advertised, but some clients probe them anyway.
    case "resources/list":
      return reply(id, { resources: [] });
    case "prompts/list":
      return reply(id, { prompts: [] });
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let lineBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  lineBuffer += chunk;
  let idx;
  while ((idx = lineBuffer.indexOf("\n")) >= 0) {
    const line = lineBuffer.slice(0, idx).trim();
    lineBuffer = lineBuffer.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    if (!msg || typeof msg !== "object") continue;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      if (msg.id !== undefined) replyError(msg.id, -32600, "Invalid Request");
      continue;
    }
    if (msg.id === undefined || msg.id === null) continue; // notification
    handleRequest(msg).catch((err) => replyError(msg.id, -32603, String(err)));
  }
});

// ---------------------------------------------------------------------------
// Lifecycle — clean shutdown, one bug never takes the server down
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  if (disconnectTimer) clearTimeout(disconnectTimer);
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Server is shutting down"));
  }
  pending.clear();
  try {
    conn?.close(1001);
  } catch {
    /* already gone */
  }
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGHUP", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => log("uncaught exception (recovered):", String(err)));
process.on("unhandledRejection", (err) => log("unhandled rejection (recovered):", String(err)));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const deadline = Date.now() + 2500;
  for (;;) {
    if (!(await isPortInUse(PORT))) break;
    if (Date.now() >= deadline) {
      console.error(
        `[lab-server] Port ${PORT} is already in use — another browser-mcp-lab server instance is probably running. ` +
          `Set BML_PORT to change the port.`,
      );
      process.exit(1);
    }
    await sleep(150);
  }
  await createWsServer({ port: PORT, onConnection: adoptConnection });
  log(`v${VERSION} ready — waiting for the extension on ws://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error(`[lab-server] failed to start: ${err?.message ?? err}`);
  process.exit(1);
});

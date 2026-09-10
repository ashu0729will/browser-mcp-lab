#!/usr/bin/env node
// MCP server over stdio (JSON-RPC 2.0, newline-delimited), zero dependencies.
// Accepts the extension (or its native-messaging bridge) over loopback WebSocket.
// Protocol: { id, tool, params } -> { id, ok, result | error }; status: hello/ping/pong.
// Env: BSM_PORT BSM_CONNECT_WAIT_MS BSM_KEEPALIVE_MS BSM_REQUEST_TIMEOUT_MS
//      BSM_DISCONNECT_GRACE_MS BSM_EXIT_ON_DISCONNECT BSM_QUIET (legacy BML_* aliases work)
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWsServer, isPortInUse } from "./websocket.js";

const VERSION = "0.3.3";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`browser-session-mcp ${VERSION}`);
  process.exit(0);
}

const envValue = (key, legacyKey) => {
  const current = process.env[key];
  if (current !== undefined && current !== "") return current;
  return process.env[legacyKey];
};

// Misconfigured environment variables are reported loudly instead of being
// silently replaced by a default the user did not ask for.
const envWarnings = [];
const warnEnv = (message) => envWarnings.push(message);

const intEnv = (key, legacyKey, fallback, { min = 0 } = {}) => {
  const raw = envValue(key, legacyKey);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warnEnv(`${key}="${raw}" is not a number — using ${fallback}`);
    return fallback;
  }
  if (n < min) {
    warnEnv(`${key}=${n} is below the minimum ${min} — using ${min}`);
    return min;
  }
  return n;
};

const boolEnv = (key, legacyKey, fallback) => {
  const raw = envValue(key, legacyKey);
  if (raw === undefined || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  warnEnv(`${key}="${raw}" is not a boolean — using ${fallback}`);
  return fallback;
};

const configuredPort = intEnv("BSM_PORT", "BML_PORT", 9777, { min: 1 });
let PORT = Number.isInteger(configuredPort) ? configuredPort : 9777;
if (PORT > 65535) {
  warnEnv(`BSM_PORT=${PORT} is above 65535 — using 9777`);
  PORT = 9777;
}
const CONNECT_WAIT_MS = intEnv("BSM_CONNECT_WAIT_MS", "BML_CONNECT_WAIT_MS", 3000);
const KEEPALIVE_MS = intEnv("BSM_KEEPALIVE_MS", "BML_KEEPALIVE_MS", 5000);
// Fast heartbeats keep Firefox's event page awake while requests are pending.
const REQUEST_TIMEOUT_MS = intEnv("BSM_REQUEST_TIMEOUT_MS", "BML_REQUEST_TIMEOUT_MS", 30000);
const QUIET = boolEnv("BSM_QUIET", "BML_QUIET", false);
const EXIT_ON_DISCONNECT = boolEnv("BSM_EXIT_ON_DISCONNECT", "BML_EXIT_ON_DISCONNECT", true);
const DISCONNECT_GRACE_MS = intEnv("BSM_DISCONNECT_GRACE_MS", "BML_DISCONNECT_GRACE_MS", 15000);

const log = (...parts) => {
  if (!QUIET) console.error(`[browser-session-mcp] ${parts.join(" ")}`);
};

// Always visible (even under BSM_QUIET): a wrong value changes real behaviour.
for (const warning of envWarnings) console.error(`[browser-session-mcp] env: ${warning}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --doctor runs before main() so no server or socket is started. It sits after
// the configuration constants because it reads PORT/intEnv/sleep — a dispatch
// placed next to the --version check would hit their temporal dead zone.
if (process.argv.includes("--doctor")) {
  await runDoctor();
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Extension connection management
// ---------------------------------------------------------------------------

let conn = null; // current WsConnection from our extension
const pending = new Map(); // request id -> {resolve, reject, timer}

let disconnectTimer = null;

// Connection history: makes connection errors actionable and feeds --doctor.
const history = {
  everConnected: false,
  connections: 0,
  lastConnectedAt: null,
  lastClosedAt: null,
  lastCloseReason: null,
  waitTimeouts: 0,
};

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
  history.everConnected = true;
  history.connections += 1;
  history.lastConnectedAt = new Date().toISOString();
  next.onmessage = (text) => handleExtensionMessage(next, text);
  next.onclose = () => {
    if (conn !== next) return; // stale socket already superseded
    conn = null;
    history.lastClosedAt = new Date().toISOString();
    history.lastCloseReason = EXIT_ON_DISCONNECT
      ? "extension disconnected; port released after grace"
      : "extension disconnected";
    log("extension disconnected");
    if (EXIT_ON_DISCONNECT) {
      log(
        `no browser attached — releasing port ${PORT} in ${DISCONNECT_GRACE_MS / 1000}s ` +
          `(set BSM_EXIT_ON_DISCONNECT=0 to keep waiting)`,
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
    history.waitTimeouts += 1;
    const waited = Date.now() - started;
    if (!history.everConnected) {
      throw new Error(
        `No browser has connected to this server yet (waited ${waited}ms on port ${PORT}). ` +
          `Open the browser, click the "Browser Session MCP" extension icon and press Connect. ` +
          `Diagnose with: node mcp-server/index.js --doctor`,
      );
    }
    const ago = history.lastClosedAt
      ? `${Math.round((Date.now() - Date.parse(history.lastClosedAt)) / 1000)}s ago`
      : "recently";
    const reason = history.lastCloseReason ? `: ${history.lastCloseReason}` : "";
    throw new Error(
      `The browser extension is not connected right now (last connection ended ${ago}${reason}; ` +
        `waited ${waited}ms on port ${PORT}). Revive it from the extension popup (Disconnect then Connect). ` +
        `Diagnose with: node mcp-server/index.js --doctor`,
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
  const file = path.join(
    dir,
    `browser-session-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
  );
  fs.writeFileSync(file, Buffer.from(match[1], "base64"));
  return file;
}

const TAB_ID = {
  type: "integer",
  description: "Optional tab id from tabs_list (defaults to the active tab)",
};
const withTab = (properties = {}) => ({ tabId: TAB_ID, ...properties });

const TOOLS = [
  {
    name: "navigate",
    description: "Navigate the active tab (or a given tabId) to a URL",
    inputSchema: obj(
      withTab({
        url: { type: "string", description: "The URL to navigate to" },
        waitForLoad: {
          type: "boolean",
          default: false,
          description: "Wait until the tab reports complete (default false)",
        },
      }),
      ["url"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("navigate", args))),
  },
  {
    name: "snapshot",
    description:
      "Capture page title, URL, interactive elements with reusable CSS refs, and a text excerpt.",
    inputSchema: obj(
      withTab({
        max: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 80,
          description: "Maximum interactive elements to return (default 80)",
        },
      }),
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("snapshot", args), null, 1)),
  },
  {
    name: "click",
    description:
      "Click a CSS ref from snapshot. Human cursor animation is enabled by default; force can bypass client-side disabled state only.",
    inputSchema: obj(
      withTab({
        ref: { type: "string", description: "CSS selector of the element" },
        humanMode: {
          type: "boolean",
          default: true,
          description: "Animate a human-like cursor before clicking (default true)",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Temporarily remove disabled/aria-disabled before clicking (default false)",
        },
      }),
      ["ref"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("click", args))),
  },
  {
    name: "type",
    description:
      "Type into input/textarea/contenteditable through the browser editing pipeline; falls back to synthetic events when needed.",
    inputSchema: obj(
      withTab({
        ref: { type: "string", description: "CSS selector of the element" },
        text: { type: "string", description: "Text to type" },
        clear: {
          type: "boolean",
          default: true,
          description: "Replace existing text (default true); false appends",
        },
        humanMode: {
          type: "boolean",
          default: true,
          description: "Animate a human-like cursor before typing (default true)",
        },
      }),
      ["ref", "text"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("type", args))),
  },
  {
    name: "press_key",
    description:
      "Best-effort key press on the focused element (synthetic KeyboardEvent; some pages ignore it)",
    inputSchema: obj(
      withTab({ key: { type: "string", description: "Key value, e.g. Enter, ArrowLeft, a" } }),
      ["key"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("press_key", args))),
  },
  {
    name: "evaluate",
    description:
      "Evaluate a JavaScript expression against the page. Runs in the page's MAIN world so the page's own globals are visible; if the page's CSP forbids eval, it retries in the extension's isolated world and says so in the result.",
    inputSchema: obj(
      withTab({
        expression: { type: "string", description: "JS expression, e.g. document.title" },
        world: {
          type: "string",
          enum: ["auto", "main", "isolated"],
          default: "auto",
          description:
            "auto (default) tries the page world, then the isolated world; main requires the page world; isolated never touches it",
        },
      }),
      ["expression"],
    ),
    handle: async (args) => {
      const result = await sendToExtension("evaluate", args);
      // Older builds returned the bare value; newer ones return { value, via }.
      const payload =
        result && typeof result === "object" && "via" in result ? result : { value: result, via: "main" };
      const body =
        typeof payload.value === "string"
          ? payload.value
          : JSON.stringify(payload.value, null, 1) ?? "undefined";
      if (payload.via !== "isolated") return text(body);
      const why = payload.mainWorldError ? `the page world failed: ${payload.mainWorldError}` : "the page world was skipped";
      return text(`${body}\n\n[isolated world — ${why}; the page's own globals are not visible here]`);
    },
  },
  {
    name: "read",
    description:
      "Read one element's state without running JavaScript: text, value, checked/disabled, visibility and attributes. Works on pages whose CSP blocks evaluate, which is where it is the way to inspect a page.",
    inputSchema: obj(
      withTab({ ref: { type: "string", description: "CSS selector, e.g. #price or a[href]" } }),
      ["ref"],
    ),
    handle: async (args) => text(JSON.stringify(await sendToExtension("read", args), null, 1)),
  },
  {
    name: "screenshot",
    description:
      "Capture a tab as PNG under ./screenshots/. On Chromium, a non-active target is activated briefly for capture.",
    inputSchema: obj(withTab()),
    handle: async (args) => {
      const { dataUrl } = await sendToExtension("screenshot", args);
      const file = saveScreenshot(dataUrl);
      return text(`Screenshot saved: ${file}`);
    },
  },
  {
    name: "scroll",
    description: "Scroll a page by pixels (defaults to one viewport down)",
    inputSchema: obj(withTab({ x: { type: "number" }, y: { type: "number" } })),
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
    inputSchema: obj({ tabId: { ...TAB_ID, description: "Tab id from tabs_list" } }, ["tabId"]),
    handle: async (args) => text(JSON.stringify(await sendToExtension("tab_select", args))),
  },
  {
    name: "wait",
    description: "Wait for a specified time in seconds (maximum 60)",
    inputSchema: obj(
      { seconds: { type: "number", minimum: 0, maximum: 60, description: "Seconds to wait" } },
      ["seconds"],
    ),
    handle: async ({ seconds = 1 }) => {
      const waited = Math.min(Math.max(Number(seconds) || 0, 0), 60);
      await sleep(waited * 1000);
      return text(`Waited for ${waited} seconds`);
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
        serverInfo: { name: "browser-session-mcp", version: VERSION },
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
// --doctor: one-shot, read-only diagnosis (stdout, never touches BSM_QUIET)
// ---------------------------------------------------------------------------

async function runDoctor() {
  const hostDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native-messaging-host");
  const chromeIdFile = path.join(hostDir, "chrome-extension-id.txt");
  const nativeHostName = "browser_session_mcp";
  const waitMs = intEnv("BSM_DOCTOR_WAIT_MS", undefined, 3000);
  const line = (level, name, detail) => console.log(`${level}  ${name}  ${detail}`);

  // 1. Can this server listen where it was told to?
  const busy = await isPortInUse(PORT);
  if (busy) {
    line(
      "WARN",
      "port",
      `${PORT} is already in use — another Browser Session MCP instance or another program holds it; set BSM_PORT to move this server`,
    );
  } else {
    line("OK", "port", `${PORT} is free on 127.0.0.1`);
  }

  // 2. Chromium needs the unpacked extension id to build a native-messaging manifest.
  let extensionId = null;
  try {
    extensionId = fs.readFileSync(chromeIdFile, "utf8").trim();
  } catch {
    /* file missing */
  }
  if (extensionId && /^[a-p]{32}$/.test(extensionId)) {
    line("OK", "extension-id-file", `${chromeIdFile} → ${extensionId}`);
  } else {
    line(
      "WARN",
      "extension-id-file",
      "missing or invalid — Chromium native messaging stays unavailable and the extension uses the WebSocket fallback (expected degradation)",
    );
  }

  // 3. Native-messaging registry entries (per browser) and their manifest files.
  if (process.platform !== "win32") {
    line("WARN", "native-host", "registry check is Windows-only — cannot verify native messaging registration");
  } else {
    const registrations = [
      ["Mozilla", `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${nativeHostName}`],
      ["Chrome", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${nativeHostName}`],
      ["Edge", `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${nativeHostName}`],
    ];
    for (const [browser, key] of registrations) {
      let manifest = null;
      try {
        const output = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8" });
        manifest = /REG_SZ\s+(.+)/.exec(output)?.[1]?.trim() ?? null;
      } catch {
        /* key not registered */
      }
      if (!manifest) {
        line("WARN", "native-host", `${browser}: not registered — the WebSocket fallback will be used`);
      } else if (!fs.existsSync(manifest)) {
        line("FAIL", "native-host", `${browser}: registered → ${manifest} (manifest file is missing)`);
      } else {
        line("OK", "native-host", `${browser}: registered → ${manifest}`);
      }
    }
  }

  // 4. Really listen on the configured port and see whether anything connects.
  let clientConnected = false;
  let clientInfo = null;
  if (busy) {
    line("WARN", "client", `cannot probe 127.0.0.1:${PORT} while the port is busy`);
  } else {
    let server = null;
    let conn = null;
    try {
      server = await createWsServer({
        port: PORT,
        onConnection: (next) => {
          conn = next;
          clientConnected = true;
          next.onmessage = (text) => {
            try {
              const msg = JSON.parse(text);
              if (msg?.type === "hello") clientInfo = `${msg.name ?? "?"} v${msg.version ?? "?"}`;
            } catch {
              /* not a hello frame */
            }
          };
        },
      });
      const deadline = Date.now() + waitMs;
      while (!clientConnected && Date.now() < deadline) {
        await sleep(Math.max(1, Math.min(100, deadline - Date.now())));
      }
    } catch (err) {
      line("FAIL", "client", `could not listen on 127.0.0.1:${PORT}: ${err?.message ?? err}`);
    } finally {
      try {
        conn?.destroy();
      } catch {
        /* already gone */
      }
      if (server) await new Promise((resolve) => server.close(resolve));
    }
    if (clientConnected) {
      line(
        "OK",
        "client",
        `a client connected on 127.0.0.1:${PORT} within ${waitMs}ms${clientInfo ? ` (${clientInfo})` : ""}`,
      );
    } else {
      line(
        "WARN",
        "client",
        `no client connected within ${waitMs}ms — open the browser, click the "Browser Session MCP" extension icon and press Connect`,
      );
    }
  }

  if (clientConnected) {
    console.log(
      "VERDICT: extension-connected — the transport works from this machine; restart your MCP server if it still reports no connection",
    );
  } else if (busy) {
    console.log(
      `VERDICT: port-busy — port ${PORT} is held by another process; stop it or set BSM_PORT for this server`,
    );
  } else {
    console.log(
      'VERDICT: no-client-yet — open the browser, click the "Browser Session MCP" extension icon and press Connect',
    );
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const deadline = Date.now() + 2500;
  for (;;) {
    if (!(await isPortInUse(PORT))) break;
    if (Date.now() >= deadline) {
      console.error(
        `[browser-session-mcp] Port ${PORT} is already in use — another Browser Session MCP server may be running. ` +
          `Set BSM_PORT to change the port (legacy BML_PORT is also accepted).`,
      );
      process.exit(1);
    }
    await sleep(150);
  }
  await createWsServer({ port: PORT, onConnection: adoptConnection });
  log(`v${VERSION} ready — waiting for the extension on ws://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  console.error(`[browser-session-mcp] failed to start: ${err?.message ?? err}`);
  process.exit(1);
});

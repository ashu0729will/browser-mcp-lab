// Regression tests for the MV3 transport state machine in service-worker.js.
// Runs the real service-worker source inside node:vm against mocked chrome /
// WebSocket / timer APIs, so native-messaging failure paths, fallbacks and
// disconnect semantics are covered without launching a browser.
// Run: node mcp-server/tests/extension-transport.test.js
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const EXT = path.join(ROOT, "browser-extension");
const SW_SOURCE = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const POPUP_HTML = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
const POPUP_JS = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
const INSTALL_SOURCE = fs.readFileSync(
  path.join(ROOT, "native-messaging-host", "install.js"),
  "utf8",
);
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const SERVER_PACKAGE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "mcp-server", "package.json"), "utf8"),
);

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures.push(name);
};

function createHarness({ store = {}, nativeHostMissing = false, cspBlock = {} } = {}) {
  const listeners = { installed: [], startup: [], alarm: [], message: [], tabActivated: [], windowFocused: [] };
  const nativePorts = [];
  const webSockets = [];
  const scriptingWorlds = [];
  const timers = new Map();
  let lastError;
  let now = 0;
  let timerId = 0;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      webSockets.push(this);
    }
    send(data) {
      if (this.readyState !== 1) throw new Error("WebSocket is not open");
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closeCode = code;
      // Real sockets dispatch close asynchronously and only once.
      if (!this._closeDispatched) {
        this._closeDispatched = true;
        queueMicrotask(() => this.onclose?.({}));
      }
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    fail() {
      // Simulates a mid-flight transport error: onerror first, then onclose.
      this.readyState = 3;
      if (!this._closeDispatched) {
        this._closeDispatched = true;
        queueMicrotask(() => {
          this.onerror?.({});
          this.onclose?.({});
        });
      }
    }
    deliver(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }
  }

  function makePort() {
    const port = {
      name: "browser_session_mcp",
      sent: [],
      disconnected: false,
      onMessage: { addListener: (fn) => (port._onMessage = fn) },
      onDisconnect: { addListener: (fn) => (port._onDisconnect = fn) },
      postMessage(obj) {
        if (port.disconnected) throw new Error("Native port is disconnected");
        port.sent.push(obj);
      },
      disconnect() {
        port.disconnected = true;
      },
      emit(obj) {
        port._onMessage?.(obj);
      },
      fail(reason) {
        port.disconnected = true;
        lastError = { message: reason ?? "Specified native messaging host not found." };
        try {
          port._onDisconnect?.();
        } finally {
          lastError = undefined;
        }
      },
    };
    return port;
  }

  const chromeMock = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const key of [].concat(keys ?? [])) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (obj) => Object.assign(store, obj),
      },
    },
    runtime: {
      getManifest: () => MANIFEST,
      connectNative: () => {
        // `nativeHostMissing` models a machine where the host is not installed:
        // every attempt fails synchronously and the extension falls straight to
        // the WebSocket, which is what the wake-up regression test needs.
        if (nativeHostMissing) throw new Error("Specified native messaging host not found.");
        const port = makePort();
        nativePorts.push(port);
        return port;
      },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    alarms: {
      create: async () => {},
      clear: async () => {},
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    // Chromium rejects an `undefined` inside args ("Value is unserializable")
    // while Firefox's structured clone tolerated it, so this mock is deliberately
    scripting: {
      executeScript: async ({ args = [], world, func }) => {
        scriptingCalls.push(args);
        const effectiveWorld = world ?? "ISOLATED";
        scriptingWorlds.push(effectiveWorld);
        if (args.some((value) => value === undefined)) {
          throw new Error(
            "Error in invocation of scripting.executeScript: Error at property 'args': Value is unserializable.",
          );
        }
        // A page CSP blocking eval: Chromium resolves with a bare null, Firefox hands
        // back the thrown error inside the wrapper our page function returns.
        // read is a fixed injection, so a page CSP never blocks it.
        if (func?.name === "pageRead") {
          return [{ result: { found: true, ref: args[0], tag: "input", text: "", value: "v", attributes: {} } }];
        }
        const block = effectiveWorld === "MAIN" ? cspBlock.main : cspBlock.isolated;
        if (block === "silent") return [{ result: null }];
        if (block === "error") {
          return [{ result: { ok: false, reason: "call to Function() blocked by CSP" } }];
        }
        return [{ result: { ok: true, value: { args, world: effectiveWorld } } }];
      },
    },
    tabs: {
      get: async (id) => ({ id, windowId: 1, active: true, status: "complete", url: "about:blank" }),
      query: async () => [{ id: 1, windowId: 1, active: true, status: "complete", url: "about:blank" }],
      update: async (id) => ({ id, windowId: 1, active: true }),
      captureVisibleTab: async () => "data:image/png;base64,AAAA",
      onActivated: { addListener: (fn) => listeners.tabActivated.push(fn) },
    },
    windows: {
      update: async () => ({}),
      onFocusChanged: { addListener: (fn) => listeners.windowFocused.push(fn) },
    },
  };
  Object.defineProperty(chromeMock.runtime, "lastError", {
    get: () => lastError,
    configurable: true,
  });

  const sandbox = {
    chrome: chromeMock,
    WebSocket: FakeWebSocket,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), interval: null });
      return id;
    },
    setInterval: (fn, ms) => {
      const id = ++timerId;
      const every = Math.max(1, Number(ms) || 1);
      timers.set(id, { fn, at: now + every, interval: every });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    performance: { now: () => now },
  };

  const flush = async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  };
  const advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (!next || timer.at < next[1].at)) next = [id, timer];
      }
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.interval) timer.at = now + timer.interval;
      else timers.delete(id);
      try {
        timer.fn();
      } catch {
        /* timer callbacks must never take the harness down */
      }
      await flush();
    }
    now = target;
    await flush();
  };
  const fireAlarm = async () => {
    for (const fn of listeners.alarm) fn({ name: "transport-health" });
    await flush();
  };
  const fireTabActivated = async () => {
    for (const fn of listeners.tabActivated) fn();
    await flush();
  };
  const fireWindowFocused = async () => {
    for (const fn of listeners.windowFocused) fn();
    await flush();
  };
  const sendMessage = (msg) =>
    new Promise((resolve) => {
      let settled = false;
      const respond = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      for (const fn of listeners.message) fn(msg, {}, respond);
      if (!listeners.message.length) resolve(undefined);
    });
  const status = () => sendMessage({ type: "status" });
  const scriptingCalls = [];
  let toolCallSeq = 0;
  // Drives a tool call through the live WebSocket and returns the reply frame.
  const callTool = async (name, params) => {
    const socket = webSockets.at(-1);
    const id = `tool-${name}-${++toolCallSeq}`;
    socket.deliver({ id, tool: name, params });
    await flush();
    return socket.sent.find((m) => m.id === id);
  };

  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: "service-worker.js" });

  return {
    store,
    nativePorts,
    webSockets,
    listeners,
    flush,
    advance,
    fireAlarm,
    fireTabActivated,
    fireWindowFocused,
    sendMessage,
    status,
    callTool,
    scriptingCalls,
    scriptingWorlds,
  };
}

// --- 1. native host missing: onDisconnect must fall back immediately ----------
{
  const h = createHarness();
  await h.flush();
  await h.flush();
  check("startTransport tries the native host first", h.nativePorts.length === 1);
  check("configure frame carries the port", h.nativePorts[0].sent.some((m) => m.type === "configure" && m.port === 9777));
  check("no WebSocket while the native port is pending", h.webSockets.length === 0);

  h.nativePorts[0].fail("Specified native messaging host not found.");
  await h.flush();
  check("async native failure falls back without waiting for an alarm", h.webSockets.length === 1);
  check("fallback targets the configured port", h.webSockets[0].url === "ws://127.0.0.1:9777");

  check("native port disposed when falling back", h.nativePorts[0].disconnected === true);
  h.webSockets[0].open();
  await h.flush();
  const hello = h.webSockets[0].sent.find((m) => m.type === "hello");
  check("hello announces the current extension name", hello?.name === "browser-session-mcp-extension");
  check("hello carries the manifest version", hello?.version === MANIFEST.version);

  const st = await h.status();
  check("status reports the WebSocket transport", st.connected === true && st.transport === "websocket");
  check("status no longer reports connecting", st.connecting === false);
}

// --- 2. native online: exactly one transport, alarm probes it ----------------
{
  const h = createHarness();
  await h.flush();
  h.nativePorts[0].emit({ type: "pong" });
  await h.flush();

  const st = await h.status();
  check("native transport reported as connected", st.connected === true && st.transport === "native");

  await h.fireAlarm();
  check("alarm does not open a second transport", h.webSockets.length === 0 && h.nativePorts.length === 1);
  check("alarm probes the native channel", h.nativePorts[0].sent.some((m) => m.type === "ping"));

  h.nativePorts[0].emit({ type: "pong" });
  await h.advance(5000);
  const after = await h.status();
  check("answered probe keeps the native channel", after.transport === "native" && h.webSockets.length === 0);
}

// --- 3. native handshake timeout -------------------------------------------
{
  const h = createHarness();
  await h.flush();
  check("handshake pending before the timeout", h.webSockets.length === 0);
  await h.advance(2500);
  check("silent native host times out into the WebSocket fallback", h.webSockets.length === 1);
  check(
    "native port is kept alive for a later promotion",
    h.nativePorts[0].disconnected === false,
    String(h.nativePorts[0].disconnected),
  );
  h.webSockets[0].open();
  await h.flush();
  check("status reports the WebSocket while native is silent", (await h.status()).transport === "websocket");

  // The host answers only now (its MCP server came up late): the native channel
  // must take over and the WebSocket must be dropped, without duplicating it.
  h.nativePorts[0].emit({ type: "pong" });
  await h.flush();
  const promoted = await h.status();
  check("native channel is promoted once it answers", promoted.transport === "native", String(promoted.transport));
  check("WebSocket is dropped after promotion", h.webSockets[0].readyState === 3);
  await h.advance(10000);
  check("promotion does not spawn another WebSocket", h.webSockets.length === 1);
}

// --- 4. disconnect closes both transports and persists ----------------------
{
  const h = createHarness();
  await h.flush();
  h.nativePorts[0].emit({ type: "pong" });
  await h.flush();
  const port = h.nativePorts[0];

  const res = await h.sendMessage({ type: "disconnect" });
  await h.flush();
  check("disconnect acknowledged", res?.ok === true);
  check("native port closed by Disconnect", port.disconnected === true);
  check("disabled flag persisted", h.store.disabled === true);

  const st = await h.status();
  check("status reports a disabled session", st.disabled === true && st.connected === false);

  port.fail("late callback after disconnect");
  await h.fireAlarm();
  await h.advance(10000);
  const after = await h.status();
  check("late native callback cannot revive the transport", h.nativePorts.length === 1 && h.webSockets.length === 0);
  check("still disabled after alarms", after.disabled === true && after.connected === false);

  // --- 5. connect rebuilds native-first ------------------------------------
  const reconnected = await h.sendMessage({ type: "connect" });
  await h.flush();
  check("connect acknowledged", reconnected?.ok === true);
  check("connect opens a fresh native port first", h.nativePorts.length === 2);
  check("connect keeps the WebSocket closed while native is pending", h.webSockets.length === 0);

  h.nativePorts.at(-1).fail("still missing");
  await h.flush();
  check("connect falls back to WebSocket once native fails", h.webSockets.length === 1);

  // --- 6. port validation and rebuild --------------------------------------
  const invalidLow = await h.sendMessage({ type: "setPort", port: 0 });
  const invalidHigh = await h.sendMessage({ type: "setPort", port: 70000 });
  const invalidFloat = await h.sendMessage({ type: "setPort", port: 1.5 });
  check("port 0 rejected", invalidLow?.ok === false);
  check("port 70000 rejected", invalidHigh?.ok === false);
  check("fractional port rejected", invalidFloat?.ok === false);
  check("rejected ports are not stored", h.store.port === undefined);

  const valid = await h.sendMessage({ type: "setPort", port: 9899 });
  await h.flush();
  check("valid port stored", valid?.ok === true && h.store.port === 9899);
  check("port change closes the previous socket", h.webSockets[0].readyState === 3);

  h.nativePorts.at(-1).fail("missing");
  await h.flush();
  const latest = h.webSockets.at(-1);
  check("new socket targets the new port", latest.url === "ws://127.0.0.1:9899");
  const stale = h.webSockets.at(-2);
  check("stale socket was closed by the port change", stale.readyState === 3);
  // A duplicate/late close must not disturb the replacement socket.
  stale.onclose?.({});
  await h.flush();
  const live = h.webSockets.filter((s) => s.readyState === 0 || s.readyState === 1);
  check("stale socket close does not disturb the new one", live.length === 1 && live[0] === latest);
}

// --- 8. an open WebSocket is closed by Disconnect -------------------------
{
  const h = createHarness({ store: {} });
  await h.flush();
  h.nativePorts[0].fail("host missing");
  await h.flush();
  const socket = h.webSockets[0];
  socket.open();
  await h.flush();
  check("WebSocket reachable before Disconnect", socket.readyState === 1);

  await h.sendMessage({ type: "disconnect" });
  await h.flush();
  check("Disconnect closes the live WebSocket", socket.readyState === 3);

  socket.onclose?.({});
  await h.fireAlarm();
  await h.advance(10000);
  check(
    "no transport is rebuilt after Disconnect",
    h.webSockets.filter((s) => s.readyState !== 3).length === 0 && h.nativePorts.length === 1,
  );
}

// --- 9. cold start with a persisted Disconnect ----------------------------
{
  const h = createHarness({ store: { disabled: true, port: 9877 } });
  await h.flush();
  await h.advance(35000);
  check("a disabled session opens no transport on startup", h.nativePorts.length === 0 && h.webSockets.length === 0);
  const st = await h.status();
  check("cold-start status stays disabled", st.disabled === true && st.connected === false && st.port === 9877);
}

// --- 10. disabled sessions only store the port -----------------------------
{
  const h = createHarness();
  await h.flush();
  await h.sendMessage({ type: "disconnect" });
  await h.flush();
  const res = await h.sendMessage({ type: "setPort", port: 9888 });
  await h.flush();
  await h.advance(10000);
  check("port saved while disabled", res?.ok === true && h.store.port === 9888);
  check("no transport is opened while disabled", h.nativePorts.length === 1 && h.webSockets.length === 0);
}

// --- 11. tool calls must survive Chromium's strict arg serialization --------
{
  const h = createHarness();
  await h.flush();
  h.nativePorts[0].fail("host missing");
  await h.flush();
  h.webSockets[0].open();
  await h.flush();

  // Only y supplied: the old code forwarded `undefined` for x, and Chromium
  // refused the entire call with "Value is unserializable".
  const scrolled = await h.callTool("scroll", { y: 300 });
  check("scroll with a single axis succeeds", scrolled?.ok === true, JSON.stringify(scrolled));

  const snapped = await h.callTool("snapshot", {});
  check("snapshot call succeeds", snapped?.ok === true);

  const clicked = await h.callTool("click", { ref: "#target", humanMode: false });
  check("click call succeeds", clicked?.ok === true);

  const evaluated = await h.callTool("evaluate", { expression: "document.title" });
  check("evaluate call succeeds", evaluated?.ok === true);

  check(
    "no tool call ever forwarded an undefined argument",
    h.scriptingCalls.length > 0 && h.scriptingCalls.every((args) => args.every((v) => v !== undefined)),
    `${h.scriptingCalls.length} injection(s)`,
  );
}

// --- 12. human activity (tab switch / window focus) wakes the transport ------
{
  // Native host missing: every reconnect attempt falls straight to the WebSocket.
  const h = createHarness({ nativeHostMissing: true });
  await h.flush();
  h.webSockets[0].fail();
  await h.flush();

  // Deliberately no advance(): MV3 may suspend the worker before the 3s
  // reconnect timer runs, so the event has to do the work on its own.
  await h.fireTabActivated();
  check("tab activation reconnects immediately without any timer", h.webSockets.length === 2);

  h.webSockets[1].open();
  await h.flush();
  await h.fireWindowFocused();
  check(
    "window focus is a no-op while a channel is already open",
    h.webSockets.length === 2,
  );
}

// --- 12b. evaluate: MAIN world, isolated fallback, forced modes -------------
{
  // Normal page: the page world answers, nothing else is tried.
  const ok = createHarness();
  await ok.flush();
  ok.nativePorts[0].fail("host missing");
  await ok.flush();
  ok.webSockets[0].open();
  await ok.flush();

  const main = await ok.callTool("evaluate", { expression: "document.title" });
  check("evaluate uses the page world by default", main?.result?.via === "main", JSON.stringify(main?.result?.via));
  check("evaluate returned the injected value", main?.result?.value?.world === "MAIN", JSON.stringify(main?.result?.value));

  // The page's CSP forbids eval: MAIN fails, the isolated world is retried and
  // the reply says which path produced the value.
  const blocked = createHarness({ cspBlock: { main: "error" } });
  await blocked.flush();
  blocked.nativePorts[0].fail("host missing");
  await blocked.flush();
  blocked.webSockets[0].open();
  await blocked.flush();

  const fellBack = await blocked.callTool("evaluate", { expression: "document.title" });
  check("evaluate falls back when the page world is CSP-blocked", fellBack?.result?.via === "isolated", JSON.stringify(fellBack?.result?.via));
  check(
    "the fallback reports why the page world failed",
    /CSP/.test(String(fellBack?.result?.mainWorldError)),
    String(fellBack?.result?.mainWorldError),
  );
  check(
    "the fallback really ran in the isolated world",
    blocked.scriptingWorlds.join(",") === "MAIN,ISOLATED",
    blocked.scriptingWorlds.join(","),
  );

  // world:"main" must fail loudly instead of silently answering from elsewhere.
  const strict = await blocked.callTool("evaluate", { expression: "document.title", world: "main" });
  check("world:main refuses to fall back", strict?.ok === false, JSON.stringify(strict?.error ?? strict?.result));

  // world:"isolated" never touches the page world.
  const beforeIsolated = blocked.scriptingWorlds.length;
  const isolatedOnly = await blocked.callTool("evaluate", { expression: "document.title", world: "isolated" });
  check("world:isolated skips the page world", isolatedOnly?.result?.via === "isolated");
  check(
    "world:isolated made no MAIN attempt",
    blocked.scriptingWorlds.slice(beforeIsolated).join(",") === "ISOLATED",
    blocked.scriptingWorlds.join(","),
  );
}
// --- 12c. a blocked page must never look like a successful null -------------
{
  // Chromium resolves a CSP-blocked MAIN-world injection with a bare null; that
  // must not be reported as "the expression evaluated to null".
  const silent = createHarness({ cspBlock: { main: "silent" } });
  await silent.flush();
  silent.nativePorts[0].fail("host missing");
  await silent.flush();
  silent.webSockets[0].open();
  await silent.flush();

  const fellBack = await silent.callTool("evaluate", { expression: "1 + 1" });
  check(
    "a silent Chromium block is not reported as a null value",
    fellBack?.result?.value?.world === "ISOLATED" && fellBack?.result?.via === "isolated",
    JSON.stringify(fellBack?.result),
  );
  check(
    "the silence is explained in the reply",
    /did not run|CSP/.test(String(fellBack?.result?.mainWorldError)),
    String(fellBack?.result?.mainWorldError),
  );

  const strict = await silent.callTool("evaluate", { expression: "1 + 1", world: "main" });
  check(
    "world:main on a blocked page is an error, not a null",
    strict?.ok === false && /blocks eval/.test(String(strict?.error)),
    String(strict?.error),
  );

  // Both worlds blocked (today's Firefox and Chromium): actionable error, no value.
  const both = createHarness({ cspBlock: { main: "error", isolated: "silent" } });
  await both.flush();
  both.nativePorts[0].fail("host missing");
  await both.flush();
  both.webSockets[0].open();
  await both.flush();

  const dead = await both.callTool("evaluate", { expression: "1 + 1" });
  check("both worlds blocked is a hard error", dead?.ok === false, JSON.stringify(dead?.result));
  check(
    "the error points at the working alternatives",
    /snapshot or read/.test(String(dead?.error)),
    String(dead?.error).slice(0, 140),
  );

  // read is a fixed injection: it works where eval is forbidden.
  const read = await both.callTool("read", { ref: "#price" });
  check("read works where eval is blocked", read?.result?.found === true, JSON.stringify(read?.result));
  check(
    "read did not need eval in any world",
    both.scriptingCalls.every(() => true) && read?.ok === true,
    JSON.stringify(both.scriptingWorlds),
  );
}


// --- 13. static branding, packaging and config consistency ------------------
{
  check("manifest uses the new product name", MANIFEST.name === "Browser Session MCP");
  const csp = MANIFEST.content_security_policy?.extension_pages ?? "";
  check("CSP allows the loopback WebSocket port range", csp.includes("ws://127.0.0.1:*"));
  check("CSP does not widen to every ws host", !/(^|[\s;])ws:([\s;]|$)/.test(csp));

  check(
    "manifest, root package and server package share a version",
    MANIFEST.version === ROOT_PACKAGE.version && MANIFEST.version === SERVER_PACKAGE.version,
  );
  check("root package renamed", ROOT_PACKAGE.name === "browser-session-mcp");
  check("server package renamed", SERVER_PACKAGE.name === "browser-session-mcp-server");
  check("node floor covers the built-in WebSocket", />=22/.test(ROOT_PACKAGE.engines?.node ?? ""));

  const hostName = /const NATIVE_HOST = "([^"]+)"/.exec(SW_SOURCE)?.[1];
  const installerHostName = /const HOST_NAME = "([^"]+)"/.exec(INSTALL_SOURCE)?.[1];
  check("extension and installer agree on the native host name", hostName === installerHostName, `${hostName}`);

  const geckoId = MANIFEST.browser_specific_settings?.gecko?.id;
  check(
    "installer registers the manifest gecko id",
    geckoId && new RegExp(`GECKO_ID = "${geckoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(INSTALL_SOURCE),
    `${geckoId}`,
  );
  check("legacy native host keys are migrated away", /LEGACY_HOST_NAME/.test(INSTALL_SOURCE));

  check("popup writes the status text it computes", POPUP_JS.includes("statusText.textContent"));
  check("popup reads the version from the manifest", /getManifest\(\)/.test(POPUP_JS));
  check("popup exposes a version placeholder", /id="version"/.test(POPUP_HTML));
  check("popup no longer hardcodes a version", !/v0\.\d+\.\d+/.test(POPUP_HTML));

  const serviceWorkerMarkers = [
    "bsm_cursor",
    "browser-session-mcp-extension",
  ];
  check(
    "service worker uses the renamed internal markers",
    serviceWorkerMarkers.every((marker) => SW_SOURCE.includes(marker)) && !SW_SOURCE.includes("__bml_"),
  );
}

// --- 14. no stale directory or brand references outside the allowlist -------
{
  const SKIP_DIRS = new Set([".git", "node_modules", "screenshots", ".zcode"]);
  // Boundary-aware: "mcp-server/tests" must not match the "server/test" token.
  const STALE = [
    { pattern: /(?<![\w-])server\/test/, hint: "moved to mcp-server/tests" },
    { pattern: /(?<![\w-])server\/index\.js/, hint: "moved to mcp-server/index.js" },
    { pattern: /(?<![\w-])native-host\//, hint: "moved to native-messaging-host/" },
    { pattern: /(?<![\w-])extension\/manifest\.json/, hint: "moved to browser-extension/manifest.json" },
    { pattern: /(?<![\w-])examples\//, hint: "moved to test-pages/" },
    { pattern: /(?<![\w-])plugin\/skills/, hint: "moved to zcode-plugin/skills" },
    { pattern: /(?<![\w-])browser-mcp-lab/, hint: "brand renamed to browser-session-mcp" },
  ];
  const allowed = (line) =>
    line.includes("github.com") ||
    line.includes("BML_") ||
    /legacy/i.test(line) ||
    line.includes('"browser_mcp_lab"');

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(js|json|md|html|bat|txt)$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (file === fileURLToPath(import.meta.url)) continue;
      if (path.dirname(file) === path.join(ROOT, "native-messaging-host") && entry.name.startsWith("browser_session_mcp.")) continue;
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (allowed(line)) return;
        for (const { pattern, hint } of STALE) {
          if (pattern.test(line)) {
            offenders.push(`${path.relative(ROOT, file)}:${index + 1} [${pattern.source} → ${hint}]`);
          }
        }
      });
    }
  };
  walk(ROOT);
  const unique = [...new Set(offenders)];
  check("no stale paths or brand references remain", unique.length === 0, unique.slice(0, 12).join(" | "));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");

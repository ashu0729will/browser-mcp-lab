// MV3 service worker: executes tool calls through chrome.tabs / chrome.scripting.
// Transport is native messaging first, with loopback WebSocket as a verified fallback.
// Protocol: { id, tool, params } -> { id, ok, result | error }; status: hello/ping/pong.

const DEFAULT_PORT = 9777;
const LOAD_TIMEOUT_MS = 15000;
const NATIVE_HOST = "browser_session_mcp";
const NATIVE_CONNECT_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 3000;
const RECONNECT_DELAY_MS = 3000;
const HEALTH_ALARM = "transport-health";

let ws = null;
let nmPort = null;
let nativeReady = false;
let disabled = false;
let transportGeneration = 0;
let startingGeneration = null;
let nativeConnectTimer = null;
let reconnectTimer = null;
let probeState = null;

// ---------------------------------------------------------------------------
// transport lifecycle
// ---------------------------------------------------------------------------

async function loadSettings() {
  const st = await chrome.storage.local.get(["port", "disabled"]);
  const savedPort = Number(st.port);
  return {
    port:
      Number.isInteger(savedPort) && savedPort >= 1 && savedPort <= 65535
        ? savedPort
        : DEFAULT_PORT,
    disabled: Boolean(st.disabled),
  };
}

function helloFrame() {
  return {
    type: "hello",
    name: "browser-session-mcp-extension",
    version: chrome.runtime.getManifest().version,
  };
}

function activeTransport() {
  if (nativeReady && nmPort) return "native";
  if (ws && ws.readyState === 1) return "websocket";
  return null;
}

function transportPhase() {
  const transport = activeTransport();
  if (disabled) return "disabled";
  if (transport) return "online";
  if (nmPort || (ws && ws.readyState === 0)) return "connecting";
  return "idle";
}

function updateBadge() {
  const transport = activeTransport();
  chrome.action.setBadgeText({ text: transport === "native" ? "N" : transport ? "WS" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
}

function clearNativeConnectTimer() {
  if (nativeConnectTimer) clearTimeout(nativeConnectTimer);
  nativeConnectTimer = null;
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearProbe() {
  if (probeState?.timer) clearTimeout(probeState.timer);
  probeState = null;
}

function closeNativePort() {
  clearNativeConnectTimer();
  const port = nmPort;
  nmPort = null;
  nativeReady = false;
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  updateBadge();
}

function closeWebSocket() {
  const socket = ws;
  ws = null;
  if (socket) {
    try {
      socket.close(1000);
    } catch {
      /* already closed */
    }
  }
  updateBadge();
}

function stopTransports() {
  transportGeneration += 1;
  startingGeneration = null;
  clearNativeConnectTimer();
  clearReconnectTimer();
  clearProbe();
  closeNativePort();
  closeWebSocket();
}

function postNative(port, obj) {
  try {
    port.postMessage(obj);
    return true;
  } catch {
    return false;
  }
}

function sendWebSocket(socket, obj) {
  try {
    if (socket.readyState !== 1) return false;
    socket.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function markActivity(kind, source) {
  if (probeState?.kind === kind && probeState.source === source) clearProbe();
}

function probeTransport(kind, source, sendPing, onTimeout) {
  clearProbe();
  const generation = transportGeneration;
  const state = { kind, source, generation, timer: null };
  probeState = state;
  if (!sendPing()) {
    clearProbe();
    onTimeout();
    return;
  }
  state.timer = setTimeout(() => {
    if (probeState !== state || generation !== transportGeneration) return;
    probeState = null;
    onTimeout();
  }, PROBE_TIMEOUT_MS);
}

function route(msg, reply) {
  if (msg?.type === "ping" || msg?.type === "pong") {
    if (msg.type === "ping") reply({ type: "pong" });
    return;
  }
  if (msg?.id === undefined || typeof msg?.tool !== "string") return;
  execute(msg.tool, msg.params ?? {})
    .then((result) => reply({ id: msg.id, ok: true, result }))
    .catch((err) => reply({ id: msg.id, ok: false, error: String(err?.message ?? err) }));
}

function scheduleReconnect(generation) {
  if (disabled || generation !== transportGeneration || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!disabled && generation === transportGeneration) void startTransport();
  }, RECONNECT_DELAY_MS);
}

function openWebSocket(port, generation) {
  // A native port that has not produced its first frame yet does not block the
  // fallback: it stays open (the bridge is alive, its server is just not up) and
  // gets promoted later if it ever answers.
  if (disabled || generation !== transportGeneration || (nmPort && nativeReady)) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    scheduleReconnect(generation);
    return;
  }
  ws = socket;
  updateBadge();

  socket.onopen = () => {
    if (generation !== transportGeneration || ws !== socket || disabled) return;
    updateBadge();
    sendWebSocket(socket, helloFrame());
  };
  socket.onmessage = (ev) => {
    if (generation !== transportGeneration || ws !== socket || disabled) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    markActivity("websocket", socket);
    route(msg, (obj) => replyToCaller(generation, "websocket", socket, obj));
  };
  socket.onclose = () => {
    if (generation !== transportGeneration || ws !== socket) return;
    ws = null;
    updateBadge();
    scheduleReconnect(generation);
  };
  socket.onerror = () => {
    if (generation !== transportGeneration || ws !== socket) return;
    try {
      socket.close();
    } catch {
      ws = null;
      updateBadge();
      scheduleReconnect(generation);
    }
  };
}

// Replies must survive a transport switch that happens while a tool call is in
// flight: the work already ran, so deliver over whichever channel is live now
// (a disconnect or port change bumps the generation and still drops the reply).
function replyToCaller(generation, kind, source, obj) {
  if (generation !== transportGeneration) return;
  if (kind === "native" && nmPort === source) {
    postNative(source, obj);
    return;
  }
  if (kind === "websocket" && ws === source) {
    sendWebSocket(source, obj);
    return;
  }
  if (nmPort) postNative(nmPort, obj);
  else if (ws && ws.readyState === 1) sendWebSocket(ws, obj);
}

function fallbackToWebSocket(port, generation, localPort, reason) {
  if (generation !== transportGeneration || nmPort !== localPort || disabled) return;
  if (reason) console.log(`[browser-session-mcp] native transport unavailable: ${reason}`);
  closeNativePort();
  openWebSocket(port, generation);
}

function openNative(port, generation) {
  if (disabled || generation !== transportGeneration || nmPort || ws) return false;
  let localPort;
  try {
    localPort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    return false;
  }

  nmPort = localPort;
  localPort.onMessage.addListener((msg) => {
    if (generation !== transportGeneration || nmPort !== localPort || disabled) return;
    clearNativeConnectTimer();
    const promoted = !nativeReady && Boolean(ws);
    nativeReady = true;
    markActivity("native", localPort);
    if (promoted) {
      // The host was silent during the handshake, so we were on the WebSocket;
      // it answered now, so prefer the native channel and drop the socket.
      // closeWebSocket() clears `ws` first, so the socket's own onclose cannot
      // schedule a reconnect, and in-flight replies route to the live channel.
      console.log("[browser-session-mcp] native channel answered — promoting it");
      closeWebSocket();
    }
    updateBadge();
    route(msg, (obj) => replyToCaller(generation, "native", localPort, obj));
  });
  localPort.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? "native host disconnected";
    fallbackToWebSocket(port, generation, localPort, reason);
  });

  nativeConnectTimer = setTimeout(() => {
    if (!nativeReady) {
      // The host process exists (no onDisconnect fired) but nothing came back:
      // its MCP server is not reachable yet. Keep the port open and use the
      // WebSocket meanwhile — a later frame promotes the native channel.
      console.log(
        "[browser-session-mcp] native host silent during handshake — using the WebSocket until it answers",
      );
      openWebSocket(port, generation);
    }
  }, NATIVE_CONNECT_TIMEOUT_MS);

  // The bridge consumes configure locally, then forwards hello/ping to the selected port.
  postNative(localPort, { type: "configure", port });
  postNative(localPort, helloFrame());
  if (!postNative(localPort, { type: "ping" })) {
    fallbackToWebSocket(port, generation, localPort, "failed to write to native host");
  }
  return true;
}

async function startTransport() {
  const generation = transportGeneration;
  if (startingGeneration === generation) return;
  startingGeneration = generation;
  try {
    const settings = await loadSettings();
    if (generation !== transportGeneration) return;
    disabled = settings.disabled;
    if (disabled) {
      if (nmPort || ws) stopTransports();
      return;
    }
    if (nmPort || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
    if (!openNative(settings.port, generation)) openWebSocket(settings.port, generation);
  } finally {
    if (startingGeneration === generation) startingGeneration = null;
  }
}

async function handleHealthAlarm(alarm) {
  if (alarm.name !== HEALTH_ALARM) return;
  const settings = await loadSettings();
  disabled = settings.disabled;
  if (disabled) {
    if (nmPort || ws) stopTransports();
    return;
  }
  const generation = transportGeneration;
  if (nativeReady && nmPort) {
    const localPort = nmPort;
    probeTransport(
      "native",
      localPort,
      () => postNative(localPort, { type: "ping" }),
      () => fallbackToWebSocket(settings.port, generation, localPort, "heartbeat timed out"),
    );
    return;
  }
  if (nmPort || (ws && ws.readyState === 0)) return;
  if (ws && ws.readyState === 1) {
    const socket = ws;
    probeTransport(
      "websocket",
      socket,
      () => sendWebSocket(socket, { type: "ping" }),
      () => {
        if (generation !== transportGeneration || ws !== socket) return;
        console.log("[browser-session-mcp] WebSocket heartbeat lost; reconnecting");
        closeWebSocket();
        void startTransport();
      },
    );
    return;
  }
  await startTransport();
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.clear("connect"); // remove the pre-rename alarm
  await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
  await startTransport();
});
chrome.runtime.onStartup.addListener(() => void startTransport());
chrome.alarms.onAlarm.addListener((alarm) => void handleHealthAlarm(alarm));

// MV3 kills the setTimeout reconnect chain when the worker suspends, and alarms
// cannot run more often than every 30s; real user activity aligns reconnection
// with the moment a browser is actually in use. Both handlers are idempotent:
// startTransport() returns early while a channel is open or already starting,
// and stays idle while the user has pressed Disconnect.
chrome.tabs.onActivated.addListener(() => void startTransport());
chrome.windows.onFocusChanged.addListener(() => void startTransport());
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "status") {
      const settings = await loadSettings();
      disabled = settings.disabled;
      const transport = activeTransport();
      sendResponse({
        connected: Boolean(transport),
        connecting: !settings.disabled && transportPhase() === "connecting",
        transport,
        port: settings.port,
        disabled: settings.disabled,
      });
    } else if (msg?.type === "connect") {
      disabled = false;
      await chrome.storage.local.set({ disabled: false });
      stopTransports();
      disabled = false;
      await startTransport();
      sendResponse({ ok: true });
    } else if (msg?.type === "disconnect") {
      disabled = true;
      stopTransports();
      await chrome.storage.local.set({ disabled: true });
      sendResponse({ ok: true });
    } else if (msg?.type === "setPort") {
      const port = Number(msg.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        sendResponse({ ok: false, error: "Port must be an integer from 1 to 65535" });
        return;
      }
      await chrome.storage.local.set({ port });
      const settings = await loadSettings();
      disabled = settings.disabled;
      if (!disabled) {
        stopTransports();
        disabled = false;
        await startTransport();
      }
      sendResponse({ ok: true, port });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true;
});

void chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
void startTransport(); // runs on every worker wake-up

// ---------------------------------------------------------------------------
// tab helpers
// ---------------------------------------------------------------------------

async function resolveTab(params) {
  if (params.tabId !== undefined) {
    if (!Number.isInteger(params.tabId)) throw new Error("tabId must be an integer");
    const tab = await chrome.tabs.get(params.tabId);
    if (!tab) throw new Error(`Tab not found: ${params.tabId}`);
    return tab;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab in the focused window");
  return tab;
}

async function runInPage(tabId, func, args = [], options = {}) {
  // chrome.scripting rejects an `undefined` anywhere in args ("Value is
  // unserializable") while Firefox's structured clone tolerated it, so normalize
  // once here instead of trusting every caller.
  const safeArgs = args.map((value) => (value === undefined ? null : value));
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: safeArgs,
    ...options,
  });
  if (!res) {
    throw new Error(
      "Cannot inject into this page (privileged page like about:*, or discarded tab). Navigate to a normal web page first.",
    );
  }
  if (res.error) throw new Error(String(res.error?.message ?? res.error));
  return res.result;
}

function waitForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve({ tabId, status: tab.status, url: tab.url });
        }
      } catch {
        clearInterval(timer);
        resolve({ tabId, status: "gone" });
      }
    }, 150);
  });
}

// ---------------------------------------------------------------------------
// in-page functions (serialized by executeScript — must be self-contained)
// ---------------------------------------------------------------------------

function pageSnapshot(max = 80) {
  const refFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const path = [];
    let node = el;
    for (let depth = 0; node && node !== document.body && depth < 4; depth++) {
      if (node.id) {
        path.unshift("#" + CSS.escape(node.id));
        break;
      }
      let tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) tag += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      path.unshift(tag);
      node = parent;
    }
    return path.join(" > ");
  };
  const nodes = Array.from(
    document.querySelectorAll(
      'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [onclick]',
    ),
  );
  const seen = new Set();
  const elements = [];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const ref = refFor(el);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const label =
      el.innerText ||
      el.value ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      "";
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      text: String(label).trim().replace(/\s+/g, " ").slice(0, 80),
    });
    if (elements.length >= max) break;
  }
  return {
    title: document.title,
    url: location.href,
    elements,
    text: String(document.body ? document.body.innerText : "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000),
  };
}

function pageClick(ref) {
  function find(r) {
    let el = document.querySelector(r);
    if (el) return el;
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const doc = f.contentDocument;
        if (!doc) continue;
        el = doc.querySelector(r);
        if (el) return el;
      } catch (e) {
        /* cross-origin */
      }
    }
    return null;
  }
  const el = find(ref);
  if (!el) throw new Error("Element not found: " + ref);
  el.scrollIntoView({ block: "center" });
  el.click();
  return { clicked: ref };
}

function pageType(ref, text, clear) {
  function find(r) {
    let el = document.querySelector(r);
    if (el) return el;
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const doc = f.contentDocument;
        if (!doc) continue;
        el = doc.querySelector(r);
        if (el) return el;
      } catch (e) {
        /* cross-origin */
      }
    }
    return null;
  }
  const el = find(ref);
  if (!el) throw new Error("Element not found: " + ref);
  el.scrollIntoView({ block: "center" });
  el.focus();
  const replace = clear !== false;
  const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
  const proto =
    el.tagName === "INPUT"
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
  const setValue = (v) => {
    if (isField) Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    else el.textContent = v;
  };
  const inputEvent = (type, data) => {
    try {
      return new InputEvent(type, {
        bubbles: true,
        cancelable: type === "beforeinput",
        inputType: "insertText",
        data,
      });
    } catch (e) {
      return new Event(type, { bubbles: true, cancelable: type === "beforeinput" });
    }
  };
  const readValue = () => (isField ? String(el.value || "") : String(el.textContent || ""));
  const before = replace ? "" : readValue();
  const want = before + String(text);

  // Preferred path: browser editing pipeline -> trusted InputEvent.
  let via = "synthetic";
  if (String(text).length > 0) {
    try {
      if (isField) {
        if (replace) el.select();
        else el.setSelectionRange(before.length, before.length);
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        if (!replace) range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (document.execCommand("insertText", false, String(text)) && readValue() === want) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { typed: ref, length: String(text).length, via: "execCommand(trusted)" };
      }
    } catch (e) {
      /* fall through to the synthetic path */
    }
    setValue(before); // undo a partial edit before the fallback
  }

  // Fallback: per-character synthetic events.
  let acc = before;
  for (const ch of Array.from(String(text))) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    el.dispatchEvent(inputEvent("beforeinput", ch));
    acc += ch;
    setValue(acc);
    el.dispatchEvent(inputEvent("input", ch));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, cancelable: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { typed: ref, length: String(text).length, via };
}

// MAIN world: insert text via document.execCommand("insertText") -> trusted InputEvent.
// Returns { ok: false, reason } when the page refuses.
function pageTypeTrusted(ref, text, clear) {
  function find(r) {
    let el = document.querySelector(r);
    if (el) return el;
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const doc = f.contentDocument;
        if (!doc) continue;
        el = doc.querySelector(r);
        if (el) return el;
      } catch (e) {
        /* cross-origin */
      }
    }
    return null;
  }
  const el = find(ref);
  if (!el) return { ok: false, reason: "Element not found: " + ref };
  el.scrollIntoView({ block: "center" });
  el.focus();
  const replace = clear !== false;
  const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
  const read = () => (isField ? String(el.value || "") : String(el.textContent || ""));
  const before = isField ? String(el.value || "") : String(el.textContent || "");
  const want = (replace ? "" : before) + String(text);
  try {
    if (isField) {
      if (replace) el.select();
      else el.setSelectionRange(before.length, before.length);
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!replace) range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const ok = document.execCommand("insertText", false, String(text));
    const now = read();
    if (ok && now === want) {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, via: "execCommand(trusted)", value: now };
    }
    return { ok: false, reason: "execCommand=" + ok + " value=" + JSON.stringify(now) };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// MAIN world: clear disabled/aria-disabled and click in the same task.
function pageForceClick(ref) {
  function find(r) {
    let el = document.querySelector(r);
    if (el) return el;
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const doc = f.contentDocument;
        if (!doc) continue;
        el = doc.querySelector(r);
        if (el) return el;
      } catch (e) {
        /* cross-origin */
      }
    }
    return null;
  }
  const el = find(ref);
  if (!el) return { ok: false, reason: "Element not found: " + ref };
  el.scrollIntoView({ block: "center" });
  const wasDisabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
  el.removeAttribute("disabled");
  el.removeAttribute("aria-disabled");
  try {
    if ("disabled" in el) el.disabled = false;
  } catch (e) {
    /* read-only */
  }
  el.click();
  return { ok: true, clicked: ref, forced: wasDisabled };
}

function pagePressKey(key) {
  const el = document.activeElement || document.body;
  const opts = { key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
  return { dispatched: key, on: el.tagName.toLowerCase() };
}

function pageEvaluate(expression) {
  // Runs in the page MAIN world: full access to the page's own globals.
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + expression + ")")();
}

function pageScroll(x, y) {
  if (typeof x !== "number" && typeof y !== "number") {
    window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "instant" });
  } else {
    window.scrollBy({ left: Number(x) || 0, top: Number(y) || 0, behavior: "instant" });
  }
  return { x: window.scrollX, y: window.scrollY };
}

// --- visible bezier-trajectory cursor ---

// Installs a cursor arrow and animates it along a bezier path to the element;
// flips window.__bsmAnim.done when the movement completes.
function pageCursorStart(ref, duration) {
  function find(r) {
    let el = document.querySelector(r);
    if (el) return el;
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const doc = f.contentDocument;
        if (!doc) continue;
        el = doc.querySelector(r);
        if (el) return el;
      } catch (e) {
        /* cross-origin */
      }
    }
    return null;
  }
  const el = find(ref);
  if (!el) return { error: "Element not found: " + ref };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const tx = rect.left + rect.width / 2 + (Math.random() * 8 - 4);
  const ty = rect.top + rect.height / 2 + (Math.random() * 8 - 4);
  const CID = "__bsm_cursor";
  let cur = document.getElementById(CID);
  if (!cur) {
    cur = document.createElement("div");
    cur.id = CID;
    cur.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;left:24px;top:24px;";
    cur.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 1.5 L19.5 12 L12.2 13.4 L15.6 20.8 L12.6 22.1 L9.4 14.7 L4 19 Z" fill="#0f172a" stroke="#ffffff" stroke-width="1.3"/></svg>';
    (document.body || document.documentElement).appendChild(cur);
  }
  const sx = parseFloat(cur.style.left) || 24;
  const sy = parseFloat(cur.style.top) || 24;
  const c1x = sx + (tx - sx) * 0.3 + (Math.random() * 90 - 45);
  const c1y = sy + (ty - sy) * 0.2 + (Math.random() * 70 - 35);
  const c2x = sx + (tx - sx) * 0.7 + (Math.random() * 90 - 45);
  const c2y = sy + (ty - sy) * 0.8 + (Math.random() * 70 - 35);
  window.__bsmAnim = {
    t0: performance.now(),
    duration: duration + Math.random() * 150,
    sx,
    sy,
    c1x,
    c1y,
    c2x,
    c2y,
    tx,
    ty,
    done: false,
  };
  if (!window.__bsmLoopRunning) {
    window.__bsmLoopRunning = true;
    function loop() {
      const a = window.__bsmAnim;
      if (!a) {
        window.__bsmLoopRunning = false;
        return;
      }
      let t = Math.min(1, (performance.now() - a.t0) / a.duration);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const m = 1 - e;
      const x = m * m * m * a.sx + 3 * m * m * e * a.c1x + 3 * m * e * e * a.c2x + e * e * e * a.tx;
      const y = m * m * m * a.sy + 3 * m * m * e * a.c1y + 3 * m * e * e * a.c2y + e * e * e * a.ty;
      const c = document.getElementById("__bsm_cursor");
      if (c) {
        c.style.left = x + "px";
        c.style.top = y + "px";
      }
      if (t >= 1) a.done = true;
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }
  return { started: true, target: [Math.round(tx), Math.round(ty)] };
}

function pageCursorDone() {
  const a = window.__bsmAnim;
  return { done: !a || a.done === true };
}

// ---------------------------------------------------------------------------
// tool dispatch
// ---------------------------------------------------------------------------

let screenshotTail = Promise.resolve();

function activeTabInWindow(windowId) {
  return chrome.tabs.query({ active: true, windowId }).then(([tab]) => tab);
}

async function restoreTabIfUnchanged(windowId, capturedTabId, previousTabId) {
  if (!Number.isInteger(previousTabId) || previousTabId === capturedTabId) return;
  try {
    const active = await activeTabInWindow(windowId);
    if (active?.id === capturedTabId) await chrome.tabs.update(previousTabId, { active: true });
  } catch {
    /* the previous tab may have closed */
  }
}

async function captureTabPngUnlocked(tab) {
  const canCaptureVisible = typeof chrome.tabs.captureVisibleTab === "function";

  // Firefox exposes captureTab, which can capture a specific background tab.
  if (typeof chrome.tabs.captureTab === "function") {
    try {
      return await chrome.tabs.captureTab(tab.id, { format: "png" });
    } catch (error) {
      // Only fall through when the active-tab path can actually do something;
      // otherwise report why this tab is uncapturable without stealing focus.
      if (!canCaptureVisible) {
        throw new Error(`This tab cannot be captured (${error?.message ?? error})`);
      }
    }
  }
  if (!canCaptureVisible) throw new Error("This browser exposes no tab capture API");

  // Chromium can only capture the active tab of a window. Remember which tab the
  // user had, activate ours once, and always hand the window back again — even
  // when the capture or its verification fails.
  const originalActiveId = (await activeTabInWindow(tab.windowId))?.id;
  let activated = false;
  try {
    if (originalActiveId !== tab.id) {
      await chrome.tabs.update(tab.id, { active: true });
      activated = true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Never fight the user (or a concurrent call) for the window: if the
      // target is not in front any more, stop instead of re-activating it.
      if ((await activeTabInWindow(tab.windowId))?.id !== tab.id) break;

      let dataUrl;
      let verified = false;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      } finally {
        verified = (await activeTabInWindow(tab.windowId))?.id === tab.id;
      }
      if (verified) return dataUrl;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error("Active tab changed during screenshot; no image was returned");
  } finally {
    if (activated) await restoreTabIfUnchanged(tab.windowId, tab.id, originalActiveId);
  }
}

function captureTabPng(tab) {
  const run = screenshotTail.then(
    () => captureTabPngUnlocked(tab),
    () => captureTabPngUnlocked(tab),
  );
  screenshotTail = run.catch(() => {});
  return run;
}

async function execute(tool, params) {
  switch (tool) {
    case "navigate": {
      if (!params.url) throw new Error("navigate requires url");
      const tab = await resolveTab(params);
      await chrome.tabs.update(tab.id, { url: params.url });
      // Respond fast: Firefox's suspendable socket can drop a slow response.
      // Callers poll `snapshot` / `evaluate` to confirm the load.
      if (params.waitForLoad) return await waitForLoad(tab.id);
      return { tabId: tab.id, dispatched: true, url: params.url };
    }
    case "snapshot": {
      const tab = await resolveTab(params);
      const requested = Number(params.max ?? 80);
      const max = Number.isFinite(requested)
        ? Math.min(500, Math.max(1, Math.trunc(requested)))
        : 80;
      return await runInPage(tab.id, pageSnapshot, [max]);
    }
    case "click": {
      if (!params.ref) throw new Error("click requires ref");
      const tab = await resolveTab(params);
      if (params.force) {
        const forced = await runInPage(tab.id, pageForceClick, [params.ref], { world: "MAIN" });
        if (!forced?.ok) throw new Error(forced?.reason ?? "force click failed");
        return forced;
      }
      if (params.humanMode !== false) {
        const startRes = await runInPage(tab.id, pageCursorStart, [
          params.ref,
          450 + Math.floor(Math.random() * 350),
        ]);
        if (startRes?.error) throw new Error(startRes.error);
        const deadline = Date.now() + 3000;
        for (;;) {
          const st = await runInPage(tab.id, pageCursorDone, []);
          if (st?.done || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 70));
        }
      }
      return await runInPage(tab.id, pageClick, [params.ref]);
    }
    case "type": {
      if (!params.ref || typeof params.text !== "string") {
        throw new Error("type requires ref and text");
      }
      const tab = await resolveTab(params);
      if (params.humanMode !== false) {
        const startRes = await runInPage(tab.id, pageCursorStart, [
          params.ref,
          450 + Math.floor(Math.random() * 350),
        ]);
        if (startRes?.error) throw new Error(startRes.error);
        const deadline = Date.now() + 3000;
        for (;;) {
          const st = await runInPage(tab.id, pageCursorDone, []);
          if (st?.done || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 70));
        }
      }
      // Trusted path first, synthetic fallback second.
      const trusted = await runInPage(
        tab.id,
        pageTypeTrusted,
        [params.ref, params.text, params.clear !== false],
        { world: "MAIN" },
      );
      if (trusted?.ok) {
        return { typed: params.ref, length: params.text.length, via: trusted.via };
      }
      const fallback = await runInPage(tab.id, pageType, [
        params.ref,
        params.text,
        params.clear !== false,
      ]);
      return { ...fallback, trustedPath: trusted?.reason ?? "unavailable" };
    }
    case "press_key": {
      if (!params.key) throw new Error("press_key requires key");
      const tab = await resolveTab(params);
      return await runInPage(tab.id, pagePressKey, [params.key]);
    }
    case "evaluate": {
      if (typeof params.expression !== "string") throw new Error("evaluate requires expression");
      const tab = await resolveTab(params);
      return await runInPage(
        tab.id,
        pageEvaluate,
        [params.expression],
        { world: "MAIN" },
      );
    }
    case "screenshot": {
      const tab = await resolveTab(params);
      const dataUrl = await captureTabPng(tab);
      return { dataUrl, tabId: tab.id };
    }
    case "scroll": {
      const tab = await resolveTab(params);
      return await runInPage(tab.id, pageScroll, [params.x, params.y]);
    }
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        active: t.active,
        title: (t.title || "").slice(0, 80),
        url: (t.url || "").slice(0, 120),
      }));
    }
    case "tab_select": {
      if (!Number.isInteger(params.tabId)) throw new Error("tab_select requires an integer tabId");
      const tab = await chrome.tabs.update(params.tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { selected: params.tabId };
    }
    case "wait": {
      const seconds = Math.min(Math.max(Number(params.seconds) || 0, 0), 60);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return { waited: seconds };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

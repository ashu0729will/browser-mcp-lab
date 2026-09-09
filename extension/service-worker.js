// MV3 service worker: executes tool calls against the browser via chrome.tabs /
// chrome.scripting. Transport: native messaging host first, WebSocket fallback.
// Protocol: { id, tool, params } -> { id, ok, result | error }; status: hello/ping/pong.
// Keepalive: every inbound frame resets the worker idle timer; chrome.alarms reconnects.

const DEFAULT_PORT = 9777;
const LOAD_TIMEOUT_MS = 15000;

let ws = null;
let disabled = false; // user pressed Disconnect in the popup

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function loadSettings() {
  const st = await chrome.storage.local.get(["port", "disabled"]);
  return {
    port: Number(st.port) || DEFAULT_PORT,
    disabled: Boolean(st.disabled),
  };
}

function setUiState(up) {
  chrome.action.setBadgeText({ text: up ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  loadSettings().then(({ port, disabled: off }) => {
    disabled = off;
    if (disabled) return;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      return;
    }
    ws.onopen = () => {
      setUiState(true);
      ws.send(
        JSON.stringify({
          type: "hello",
          name: "browser-mcp-lab-extension",
          version: chrome.runtime.getManifest().version,
        }),
      );
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Ping/pong and tool requests are both handled by route(), which replies
      // over whichever transport delivered the frame.
      route(msg, send);
    };
    ws.onclose = () => {
      setUiState(false);
      ws = null;
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  });
}

function disconnect() {
  if (ws) {
    try {
      ws.close(1000);
    } catch {
      /* already gone */
    }
    ws = null;
  }
  setUiState(false);
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// --- Native messaging (primary transport) ---
let nmPort = null;

function connectNative() {
  try {
    const p = chrome.runtime.connectNative("browser_mcp_lab");
    p.onMessage.addListener((msg) =>
      route(msg, (o) => {
        try {
          p.postMessage(o);
        } catch {
          /* 端口已断开 */
        }
      }),
    );
    p.onDisconnect.addListener(() => {
      if (nmPort === p) nmPort = null;
    });
    nmPort = p;
    setUiState(true);
    return true;
  } catch {
    nmPort = null;
    return false;
  }
}

function route(msg, reply) {
  if (msg?.type === "ping" || msg?.type === "pong") {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
    // Reply over the transport that delivered the frame.
    if (msg.type === "ping") reply({ type: "pong" });
    return;
  }
  if (msg?.id === undefined || typeof msg?.tool !== "string") return;
  execute(msg.tool, msg.params ?? {})
    .then((result) => reply({ id: msg.id, ok: true, result }))
    .catch((err) => reply({ id: msg.id, ok: false, error: String(err?.message ?? err) }));
}

let probeTimer = null;

function startTransport() {
  if (connectNative()) return; // 原生消息通道（浏览器托管桥接进程）
  connect(); // WS 备用通道
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.clear("connect");
  await chrome.alarms.create("connect", { periodInMinutes: 0.5 });
  startTransport();
});
chrome.runtime.onStartup.addListener(startTransport);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "connect") return;
  // A suspended socket keeps readyState===1 after the server dies, so probe
  // with ping/pong before trusting it.
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
      setUiState(false);
      connect();
      return;
    }
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      console.log("[bml] heartbeat lost, reconnecting");
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      connect();
    }, 3000);
    return;
  }
  connect();
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "status") {
      const { port, disabled: off } = await loadSettings();
      sendResponse({ connected: Boolean(ws && ws.readyState === 1), port, disabled: off });
    } else if (msg?.type === "connect") {
      await chrome.storage.local.set({ disabled: false });
      disabled = false;
      disconnect();
      connect();
      sendResponse({ ok: true });
    } else if (msg?.type === "disconnect") {
      await chrome.storage.local.set({ disabled: true });
      disabled = true;
      disconnect();
      sendResponse({ ok: true });
    } else if (msg?.type === "setPort") {
      const port = Number(msg.port) || DEFAULT_PORT;
      await chrome.storage.local.set({ port });
      disconnect();
      connect();
      sendResponse({ ok: true, port });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true; // async sendResponse
});

startTransport(); // runs on every worker wake-up

// ---------------------------------------------------------------------------
// tab helpers
// ---------------------------------------------------------------------------

async function resolveTab(params) {
  if (typeof params.tabId === "number") {
    const tab = await chrome.tabs.get(params.tabId);
    if (!tab) throw new Error(`Tab not found: ${params.tabId}`);
    return tab;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab in the focused window");
  return tab;
}

async function runInPage(tabId, func, args = [], options = {}) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
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
// flips window.__bmlAnim.done when the movement completes.
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
  const CID = "__bml_cursor";
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
  window.__bmlAnim = {
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
  if (!window.__bmlLoopRunning) {
    window.__bmlLoopRunning = true;
    function loop() {
      const a = window.__bmlAnim;
      if (!a) {
        window.__bmlLoopRunning = false;
        return;
      }
      let t = Math.min(1, (performance.now() - a.t0) / a.duration);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const m = 1 - e;
      const x = m * m * m * a.sx + 3 * m * m * e * a.c1x + 3 * m * e * e * a.c2x + e * e * e * a.tx;
      const y = m * m * m * a.sy + 3 * m * m * e * a.c1y + 3 * m * e * e * a.c2y + e * e * e * a.ty;
      const c = document.getElementById("__bml_cursor");
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
  const a = window.__bmlAnim;
  return { done: !a || a.done === true };
}

// ---------------------------------------------------------------------------
// tool dispatch
// ---------------------------------------------------------------------------

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
      return await runInPage(tab.id, pageSnapshot, [params.max ?? 80]);
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
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl };
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
      if (typeof params.tabId !== "number") throw new Error("tab_select requires tabId");
      const tab = await chrome.tabs.update(params.tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { selected: params.tabId };
    }
    case "wait": {
      const seconds = Math.min(Number(params.seconds) || 0, 60);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return { waited: seconds };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

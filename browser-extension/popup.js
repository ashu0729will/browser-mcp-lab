const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const portEl = document.getElementById("port");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const versionEl = document.getElementById("version");

function render(st) {
  if (!st) return;
  dot.className = "dot";

  let text;
  if (st.disabled) {
    dot.classList.add("off");
    text = "已断开";
  } else if (st.connected) {
    dot.classList.add("on");
    const transport = st.transport === "native" ? "原生消息" : "WebSocket";
    text = `已连接（${transport}）`;
  } else if (st.connecting) {
    text = "连接中…";
  } else {
    dot.classList.add("off");
    text = "未连接（将自动重试）";
  }

  statusText.textContent = text;
  if (document.activeElement !== portEl) portEl.value = st.port;
  connectBtn.disabled = !st.disabled && (st.connected || st.connecting);
  disconnectBtn.disabled = st.disabled;
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, render);
}

connectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "connect" }, refresh);
});
disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" }, refresh);
});
document.getElementById("save").addEventListener("click", () => {
  const port = Number(portEl.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    statusText.textContent = "端口必须是 1–65535 的整数";
    return;
  }
  chrome.runtime.sendMessage({ type: "setPort", port }, (result) => {
    if (result?.ok === false) statusText.textContent = result.error;
    else refresh();
  });
});

// Browser popups may cancel a normal target=_blank navigation when they close.
document.getElementById("ghLink").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: event.currentTarget.href });
});

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version_name || manifest.version}`;
refresh();
setInterval(refresh, 1500);

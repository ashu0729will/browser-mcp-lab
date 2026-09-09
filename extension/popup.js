const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const portEl = document.getElementById("port");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");

function render(st) {
  if (!st) return; // background 未响应时保持当前显示
  dot.className = "dot";
  let text = "";
  if (st.disabled) {
    dot.classList.add("off");
    text = "已断开";
  } else if (st.connected) {
    dot.classList.add("on");
    text = "已连接";
  } else {
    dot.classList.add("off");
    text = "未连接";
  }
  if (document.activeElement !== portEl) portEl.value = st.port;
  connectBtn.disabled = st.connected && !st.disabled;
  disconnectBtn.disabled = !st.connected;
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
  const port = Number(portEl.value) || 9777;
  chrome.runtime.sendMessage({ type: "setPort", port }, refresh);
});

// 弹窗内的 <a target="_blank"> 会被浏览器随弹窗关闭一起取消，
// 必须用 tabs.create 打开新标签页。
document.getElementById("ghLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: e.currentTarget.href });
});

refresh();
setInterval(refresh, 1500);

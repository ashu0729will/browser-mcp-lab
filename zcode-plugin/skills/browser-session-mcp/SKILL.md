---
name: browser-session-mcp
description: Drive the user's real browser session through the browser-session-mcp MCP server (navigate, snapshot, click, type, evaluate, screenshot, tabs). Use when asked to automate, test, scrape, or verify web pages; includes confirmed limitations and workarounds.
---

# Browser Session MCP — 浏览器自动化指南

MCP 服务器（`mcp-server/index.js`，零依赖）暴露 11 个工具，直接操控当前浏览器会话并复用登录态。

## 核心循环

1. `navigate` 打开目标页
2. `snapshot` 获取标题 / URL / 可交互元素（含 `ref`）
3. 用 `ref` 或任意 CSS 选择器执行 `click` / `type`
4. `evaluate` 校验状态，或 `screenshot` 留证

`ref` 是稳定 CSS 选择器（优先 `#id`，否则 `tag:nth-of-type` 路径，最深 4 层），
DOM 变化或页面重载后失效，重新 `snapshot` 即可。

## 工具

除 `tabs_list` / `tab_select` / `wait` 外，所有工具都可用 `tabId` 指定标签页（默认当前活动页）。

| 任务 | 工具 |
|------|------|
| 打开/跳转 | `navigate`（`tabId`、`waitForLoad`） |
| 读取结构 | `snapshot`（`max` 上限 500，默认 80） |
| 点击 | `click`（`humanMode: false` 关闭虚拟光标；`force: true` 越过客户端 `disabled`） |
| 输入 | `type`（`clear` 默认 true；`humanMode` 同 `click`；优先走浏览器原生编辑管线） |
| 按键 | `press_key`（合成事件，见限制 1） |
| 页面内 JS | `evaluate`（MAIN world） |
| 截图 | `screenshot`（PNG 落盘 `./screenshots/`，可用 `tabId` 指定标签页） |
| 滚动 | `scroll`（`x` / `y`） |
| 多标签页 | `tabs_list` / `tab_select` |
| 等待 | `wait`（秒，上限 60） |

## 连接前提

- 浏览器已加载 `browser-extension/`，扩展弹窗显示「已连接（原生消息 / WebSocket）」（首次点 Connect）。
- 原生消息通道优先（`node native-messaging-host/install.js` 注册）；未注册时自动回退
  `ws://127.0.0.1:9777`，无需等待定时器。
- 端口被占用时服务器明确报错退出；可用 `BSM_PORT` 改端口（扩展弹窗里改端口对两条通道都生效）。

## 限制与替代路径

1. **`press_key` 只发合成 `KeyboardEvent`**：`isTrusted` 是 DOM 规范的
   `[LegacyUnforgeable]`，无法伪造，只认真实按键的页面不响应。
   文字输入不受此限——`type` 走浏览器原生编辑管线，产出受信任 `InputEvent`。
2. **截图仅覆盖可视区**，长页面先 `scroll` 分段截。
   Firefox 可截任意标签页；Chromium 只能截窗口当前活动标签页，因此指定后台标签页时
   会短暂激活它——不要依赖「后台截图不打扰用户」，也不要并发截图。
3. **特权页不可注入**（`about:*` 等）：需先 `navigate` 到普通网页。
4. **`file://` 页面**需在扩展详情页开启「允许访问文件网址」；或本地起 HTTP 服务
   （测试页在 `test-pages/`）。
5. **浏览器自身 UI 够不到**（保存密码、扩展批准框等）。
6. **`click` / `type` 默认带虚拟光标动画**（约 0.45–0.8s），批量操作传 `humanMode: false`。
7. **纯客户端 `disabled` 门槛**用 `click(ref, {force: true})` 越过，服务端校验照旧生效。

## 故障排查

- `No connection to the browser extension`：扩展图标 → Disconnect → Connect；
  Firefox 事件页挂起后在 `about:debugging` 点「重载」。
- 端口被占：清理残留服务器进程，或改 `BSM_PORT`。
- 服务器日志：移除 `BSM_QUIET=1`。
- 自检：`npm test`（四项离线测试，无需浏览器）、
  `node mcp-server/tests/e2e-firefox.js`（需扩展已加载）。

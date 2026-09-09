---
name: browser-mcp-lab
description: Drive the user's real browser tab through the browser-mcp-lab MCP server (navigate, snapshot, click, type, evaluate, screenshot, tabs). Use when asked to automate, test, scrape, or verify web pages; includes confirmed limitations and workarounds.
---

# Browser MCP Lab — 浏览器自动化指南

MCP 服务器（`server/index.js`，零依赖）暴露 11 个工具，直接操控当前浏览器标签页并复用登录态。

## 核心循环

1. `navigate` 打开目标页
2. `snapshot` 获取标题 / URL / 可交互元素（含 `ref`）
3. 用 `ref` 或任意 CSS 选择器执行 `click` / `type`
4. `evaluate` 校验状态，或 `screenshot` 留证

`ref` 是稳定 CSS 选择器（优先 `#id`，否则 `tag:nth-of-type` 路径，最深 4 层），
DOM 变化或页面重载后失效，重新 `snapshot` 即可。

## 工具

| 任务 | 工具 |
|------|------|
| 打开/跳转 | `navigate`（可选 `tabId`、`waitForLoad`） |
| 读取结构 | `snapshot`（`max` 控制元素上限，默认 80） |
| 点击 | `click`（`humanMode: false` 关闭虚拟光标；`force: true` 越过客户端 `disabled`） |
| 输入 | `type`（`clear` 默认 true；优先走浏览器原生编辑管线） |
| 按键 | `press_key`（合成事件，见限制 1） |
| 页面内 JS | `evaluate`（MAIN world） |
| 截图 | `screenshot`（可视区 PNG，落盘 `./screenshots/`） |
| 滚动 | `scroll` |
| 多标签页 | `tabs_list` / `tab_select` |
| 等待 | `wait` |

## 连接前提

- 浏览器已加载 `extension/`，扩展弹窗显示已连接（首次点 Connect）。
- 原生消息通道优先（`node native-host/install.js` 注册）；未注册时回退
  `ws://127.0.0.1:9777`。
- 端口被占用时服务器明确报错退出；可用 `BML_PORT` 改端口（扩展弹窗同步修改）。

## 限制与替代路径

1. **`press_key` 只发合成 `KeyboardEvent`**：`isTrusted` 是 DOM 规范的
   `[LegacyUnforgeable]`，无法伪造，只认真实按键的页面不响应。
   文字输入不受此限——`type` 走浏览器原生编辑管线，产出受信任 `InputEvent`。
2. **截图仅覆盖可视区**，长页面先 `scroll` 分段截。
3. **特权页不可注入**（`about:*` 等）：需先 `navigate` 到普通网页。
4. **`file://` 页面**需在扩展详情页开启「允许访问文件网址」；或本地起 HTTP 服务
   （测试页在 `examples/`）。
5. **浏览器自身 UI 够不到**（保存密码、扩展批准框等）。
6. **`click` / `type` 默认带虚拟光标动画**（约 0.45–0.8s），批量操作传 `humanMode: false`。
7. **纯客户端 `disabled` 门槛**用 `click(ref, {force: true})` 越过，服务端校验照旧生效。

## 故障排查

- `No connection to the browser extension`：扩展图标 → Disconnect → Connect；
  Firefox 事件页挂起后在 `about:debugging` 点「重载」。
- 端口被占：清理残留服务器进程，或改 `BML_PORT`。
- 服务器日志：移除 `BML_QUIET=1`。
- 自检：`node server/test/server.test.js`（无需浏览器）、
  `node server/test/e2e-firefox.js`（需扩展已加载）。

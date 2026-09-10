# Browser Session MCP

自研浏览器自动化闭环：自有 MV3 扩展 + 自有零依赖 MCP 服务器 + 自有原生消息宿主。
AI agent 可直接操控当前浏览器会话并复用登录态，链路不含第三方浏览器自动化组件。

名称取「浏览器会话」之意：核心能力是接管**用户当前已登录的会话**，
而早期名字里的 Lab（实验）已不再描述项目性质。

## 架构

```
AI agent
   │  MCP over stdio（JSON-RPC 2.0）
   ▼
mcp-server/index.js                  MCP 服务器（零依赖，11 个工具）
   │  ① native-messaging-host/bridge.js   原生消息通道（首选）
   │  ② ws://127.0.0.1:9777               WebSocket 回退（mcp-server/websocket.js）
   ▼
browser-extension/                   MV3 扩展（Chrome / Edge / Firefox）
   ▼
当前浏览器会话
```

## 目录结构

| 路径 | 说明 |
|------|------|
| `browser-extension/` | MV3 扩展（`service-worker.js`、popup、图标） |
| `mcp-server/` | MCP 服务器、WebSocket 实现、`tests/` 自动化测试 |
| `native-messaging-host/` | 原生消息宿主：桥进程 + 免管理员注册脚本 |
| `test-pages/` | 本地测试页面（含事件保真度页 `event-trust.html`） |
| `zcode-plugin/` | ZCode 插件：浏览器自动化技能 |
| `docs/ARCHITECTURE.md` | 架构、协议、里程碑 |

## 安装

**1. 加载扩展**

- Firefox：`about:debugging` → 临时加载附加组件 → `browser-extension/manifest.json`
- Chrome / Edge：`chrome://extensions` → 加载已解压的扩展程序 → `browser-extension/`

**2. 注册原生消息宿主（可选，推荐）**

```bash
node native-messaging-host/install.js
```

Chromium 系需把扩展 ID 写入 `native-messaging-host/chrome-extension-id.txt` 后重新执行一次；
脚本会校验 ID 格式、把旧版宿主名（`browser_mcp_lab`）的注册表键清理掉，并在缺少有效 ID 时
跳过 Chrome / Edge 注册、以退出码 2 结束（Firefox 仍然注册成功），不会写出浏览器必然拒绝的宿主清单。
未注册时扩展自动使用 WebSocket 通道。

**3. 注册 MCP 服务器**

```json
{
  "mcp": {
    "servers": {
      "browser-session-mcp": {
        "command": "node",
        "args": ["<仓库绝对路径>/mcp-server/index.js"]
      }
    }
  }
}
```

**4. 连接**：点击扩展图标 → Connect。弹窗会显示实际使用的通道（原生消息 / WebSocket）。

## 工具

| 工具 | 说明 |
|------|------|
| `navigate` | 跳转到 URL（`tabId`、`waitForLoad` 可选，默认立即返回） |
| `snapshot` | 页面标题 / URL / 可交互元素（含 `ref` 选择器）/ 正文摘录；`max` 上限 500，默认 80 |
| `click` | 点击元素；`humanMode: false` 关闭虚拟光标动画；`force: true` 越过客户端 `disabled` |
| `type` | 输入文本；`clear: false` 追加；`humanMode: false` 关动画；优先走浏览器原生编辑管线 |
| `press_key` | 按键（合成事件，见兼容性说明） |
| `evaluate` | 页面 MAIN world 执行 JS |
| `screenshot` | 截图 PNG，落盘 `./screenshots/`；`tabId` 可指定标签页 |
| `scroll` | 按像素滚动 |
| `tabs_list` / `tab_select` | 标签页枚举与切换 |
| `wait` | 等待指定秒数（上限 60） |

除 `tabs_list` / `tab_select` / `wait` 外，其余工具都接受 `tabId`；不传则作用于当前活动标签页。

## 传输与稳定性

- 原生消息通道优先；WebSocket 回退，仅监听 `127.0.0.1`
- 弹窗里改端口对**两条通道**都生效：扩展通过 `configure` 控制帧让桥进程切换下游端口
- 原生宿主不可用（未注册 / 启动失败 / 握手超时 2s）时立即回退 WebSocket，不等 30s 定时器
- 同一时刻只维持一条通道；旧连接的回调按世代号丢弃，不会污染新连接
- 应用层心跳 5s + 双向 ping/pong 往返 + 半开连接清扫（2.5 个周期）
- 浏览器断开后 15s 释放端口（`BSM_EXIT_ON_DISCONNECT=0` 可关闭）
- 端口被占用时明确报错，不终止其他进程
- 弹窗「断开」会同时关闭两条通道并禁止自动重连

环境变量（旧 `BML_*` 名称仍被接受）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BSM_PORT` | 9777 | WebSocket 监听端口 |
| `BSM_CONNECT_WAIT_MS` | 3000 | 等待扩展连接的时间 |
| `BSM_KEEPALIVE_MS` | 5000 | 心跳周期，`0` 关闭心跳与半开清扫 |
| `BSM_REQUEST_TIMEOUT_MS` | 30000 | 单次工具调用超时 |
| `BSM_DISCONNECT_GRACE_MS` | 15000 | 断开后的宽限期 |
| `BSM_EXIT_ON_DISCONNECT` | 开启 | `0` 时断连不退出 |
| `BSM_QUIET` | 关闭 | `1` 静音日志 |
| `BSM_WS_URL` | — | 仅原生桥：初始下游地址（弹窗端口仍可覆盖） |

## 测试

```bash
npm test                                        # 全部离线测试（无需浏览器）
node mcp-server/tests/server.test.js            # 28 项：握手、工具 schema、调用、截图落盘
node mcp-server/tests/bridge.test.js            # 8 项：桥转发、心跳、configure 端口切换
node mcp-server/tests/disconnect.test.js        # 4 项：断开后释放端口
node mcp-server/tests/extension-transport.test.js  # 59 项：扩展传输状态机（mock chrome/WebSocket）
```

真机测试（需已加载扩展）：

```bash
node mcp-server/tests/live-smoke.js             # 真机冒烟：本地测试页 + 断言页面真实变化（建议先跑）
node mcp-server/tests/e2e-firefox.js
node mcp-server/tests/real-click-test.js
node mcp-server/tests/real-trust-test.js        # 以 isTrusted 判定点击事件来源
node mcp-server/tests/demo-cursor.js
```

`live-smoke.js` 只访问本地测试页（自起 8123 端口），不需要外网，也不需要已登录的站点；
`SMOKE_KEEP_SCREENSHOT=1` 会保留它截到的 PNG 供人工查看。
想在全新配置里验证 Chromium（不改动你日常用的浏览器配置）：

```bash
msedge.exe --user-data-dir=<临时目录> --load-extension=<仓库>/browser-extension \
           --disable-extensions-except=<仓库>/browser-extension --no-first-run
```

需要 Node.js 22+（`bridge.js`、测试与 `mcp-server/tests/extension-transport.test.js` 使用内置 `WebSocket`）。

## 兼容性说明

- `type` 在页面 MAIN world 使用 `document.execCommand("insertText")`，由浏览器完成编辑，
  产出 `isTrusted === true` 的 `InputEvent`；页面拒绝时回退逐字符合成事件，返回值的 `via` 标明路径。
- `press_key` 只发合成 `KeyboardEvent`。`isTrusted` 是 DOM 规范的 `[LegacyUnforgeable]`，
  无法伪造，只认真实按键的页面不响应。
- `click` 的 `force: true` 移除 `disabled` / `aria-disabled` 后点击，仅绕过客户端校验。
- 截图仅覆盖可视区。Firefox 用 `tabs.captureTab` 直接截目标标签页；Chromium 只能截窗口当前
  活动标签页，因此会临时激活目标页、截图前后各核验一次活动标签，并在确认未被用户切走后恢复原标签。
- `about:*` 等特权页不可注入，需先导航到普通网页。
- `file://` 页面需在扩展详情页开启「允许访问文件网址」。
- `nth-of-type` 选择器在 DOM 变化后可能失效，重新 `snapshot` 即可。
- Chromium 系原生通道需手填扩展 ID 才能启用，缺省走 WebSocket。
- 原生消息宿主名、Firefox gecko ID 均已随改名更新；旧宿主注册表键由安装脚本自动清理。

## 里程碑

- [x] v0.2.0 MCP 服务器 + 扩展 MVP、自有协议、自动化测试
- [x] v0.2.1 跨浏览器同一份 manifest；Firefox 端到端验证
- [x] v0.3.0 拟人化虚拟光标；双向心跳；断开释放端口
- [x] v0.3.1 原生消息通道作为首选传输，WebSocket 回退
- [x] v0.3.2 受信任输入；`click.force`
- [x] v0.3.3 改名 Browser Session MCP；目录规范化；双通道状态统一；工具 schema 补全
- [ ] v0.4.0 Chrome / Edge 真机验证；Firefox 挂起感知重连；`snapshot` 结构化
- [ ] v0.5.0 真实按键路径（Chrome `chrome.debugger` 或原生宿主 OS 级输入）
- [ ] 商店发布

## 许可

[MIT](LICENSE)

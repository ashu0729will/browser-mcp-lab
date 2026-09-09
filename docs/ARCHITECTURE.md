# 架构说明

## 1. 总体架构

```
AI agent
   │  MCP over stdio（JSON-RPC 2.0）
   ▼
server/index.js                      MCP 服务器（零依赖，11 个工具）
   │  ① native-host/bridge.js        原生消息通道（首选）
   │  stdio 4 字节 LE 长度帧 ↔ WebSocket
   │  ② ws://127.0.0.1:9777          WebSocket 回退（server/websocket.js，手写 RFC 6455）
   ▼
extension/                           MV3 扩展（service worker 执行工具）
   │  chrome.tabs / chrome.scripting.executeScript / captureVisibleTab
   ▼
当前浏览器标签页
```

设计取舍：

- 不使用 `chrome.debugger`：避免调试横幅与整页 CDP 接管，权限模型更简单。
  代价是按键只能合成 `KeyboardEvent`，截图只能取可视区。
- 无持久 content script：每次动作经 `chrome.scripting.executeScript` 注入自包含函数，
  无状态、不污染页面。
- `evaluate` 运行在页面 MAIN world，可访问页面自身全局变量；DOM 动作运行在隔离世界。
- 截图由扩展回传 dataURL，服务器解码写入 `./screenshots/`，避免 base64 进入模型上下文。

## 2. 扩展

- `manifest.json`：MV3，权限 `tabs / scripting / storage / alarms / nativeMessaging`，
  `host_permissions: <all_urls>`，显式声明 CSP。
- `service-worker.js`：
  - 原生消息通道优先（`chrome.runtime.connectNative`），失败回退 WebSocket；
  - 每条入站消息重置 worker 空闲计时器，服务器每 5s 心跳；
  - `chrome.alarms`（30s）兜底重连；ping/pong 往返探测识别挂起后的假连接；
  - `snapshot` 枚举可交互元素（`a[href] / button / input / textarea / select / summary /
    [role=…] / [onclick]`），生成稳定 CSS 选择器 `ref`（优先 `#id`，否则
    `tag:nth-of-type` 路径，最深 4 层）；
  - popup：连接状态、Connect / Disconnect、端口设置。

## 3. 线上协议

```
server → extension : { id, tool, params }        执行请求
extension → server : { id, ok: true, result }    成功
                   | { id, ok: false, error }    失败
状态帧             : { type: "hello" | "ping" | "pong" }
```

原生消息通道使用同一套 JSON 负载，外层为浏览器规定的 `4 字节小端长度 + UTF-8 JSON` 帧。

## 4. 工具（11 个）

`navigate` `snapshot` `click` `type` `press_key` `evaluate` `screenshot` `scroll`
`tabs_list` `tab_select` `wait`

`navigate` 默认立即返回，`waitForLoad: true` 时等待 load。文件上传未提供专用工具，
可用 `evaluate` + `DataTransfer` 实现。

### 4.1 事件保真度

- `type` 在页面 MAIN world 执行 `document.execCommand("insertText")`，由浏览器编辑管线完成输入，
  产出 `isTrusted === true` 的 `InputEvent`（`inputType: "insertText"`、带 `event.data`）。
  页面拒绝时回退逐字符合成事件（`keydown → beforeinput → input → keyup`），
  返回值 `via` 标明实际路径。
- `click` 的 `force: true` 在同一帧内移除 `disabled` / `aria-disabled` 再点击，
  用于越过纯客户端的确认门槛；服务端校验照旧生效。
- `isTrusted` 是 DOM 规范的 `[LegacyUnforgeable]`，无法从 JS 伪造；
  只认真实按键事件的页面需要 OS 级输入。
- 回归实验页：`examples/trust-lab.html`。

### 4.2 开发循环

Firefox 临时附加组件修改后无需点击「重载」：断开原生消息桥，等待事件页挂起
（约 3 分钟；`chrome.alarms` 每 30s 会唤醒它），再次连接时 Firefox 会从磁盘重新读取扩展源码。
可通过 hello 帧中的版本号验证是否生效。

## 5. 传输与稳定性

- 原生消息通道由浏览器托管桥进程，浏览器退出即随之结束，事件页挂起时仍可唤醒。
- WebSocket 通道仅监听 `127.0.0.1`；端口被占用时明确报错退出，不终止其他进程。
- 防假死：应用层心跳 + 双向 ping/pong 往返 + 2.5 个周期无活动即清扫半开连接。
- 浏览器断开后 15s（`BML_DISCONNECT_GRACE_MS`）自动退出并释放端口。
- 环境变量：`BML_PORT` `BML_CONNECT_WAIT_MS` `BML_KEEPALIVE_MS`
  `BML_REQUEST_TIMEOUT_MS` `BML_DISCONNECT_GRACE_MS` `BML_QUIET`。

## 6. 测试

| 脚本 | 覆盖 |
|------|------|
| `server/test/server.test.js` | 17 项：握手、工具枚举、工具调用、截图落盘、未知工具报错 |
| `server/test/bridge.test.js` | 原生桥：请求转发、响应回传、心跳往返 |
| `server/test/disconnect.test.js` | 断开后宽限期释放端口 |

真机测试：`e2e-firefox.js`、`real-click-test.js`、`real-trust-test.js`、`demo-cursor.js`。

## 7. 已知约束

- 合成事件对少数框架页面无效；升级路线为可选的真实输入模式。
- `nth-of-type` 选择器在 DOM 动态变化后可能失效。
- 商店审核对 `<all_urls>` 权限审查趋严，必要时拆分窄域权限。
- Chromium 系原生通道需手填扩展 ID，缺省走 WebSocket。

## 8. 里程碑

- [x] v0.2.0 MCP 服务器 + 扩展 MVP、自有协议、自动化测试
- [x] v0.2.1 跨浏览器兼容 + Firefox 端到端验证
- [x] v0.3.0 虚拟光标；双向心跳；断开释放端口
- [x] v0.3.1 原生消息通道作为首选传输
- [x] v0.3.2 受信任输入；`click.force`；事件保真度实验页
- [ ] v0.4.0 Chrome / Edge 真机验证；挂起感知重连；`snapshot` 结构化
- [ ] v0.5.0 真实按键路径
- [ ] 商店发布

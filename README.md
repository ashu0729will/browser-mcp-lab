# Browser MCP Lab

自研浏览器自动化闭环：自有 MV3 扩展 + 自有零依赖 MCP 服务器 + 自有原生消息宿主。
AI agent 可直接操控当前浏览器标签页并复用登录态，链路不含第三方浏览器自动化组件。

## 架构

```
AI agent
   │  MCP over stdio（JSON-RPC 2.0）
   ▼
server/index.js                      MCP 服务器（零依赖，11 个工具）
   │  ① native-host/bridge.js        原生消息通道（首选）
   │  ② ws://127.0.0.1:9777          WebSocket 回退（server/websocket.js）
   ▼
extension/                           MV3 扩展（Chrome / Edge / Firefox）
   ▼
当前浏览器标签页
```

## 目录结构

| 路径 | 说明 |
|------|------|
| `extension/` | MV3 扩展（`service-worker.js`、popup、图标） |
| `server/` | MCP 服务器、WebSocket 服务器、测试 |
| `native-host/` | 原生消息宿主：桥进程 + 免管理员注册脚本 |
| `examples/` | 本地测试页面（含事件保真度实验页） |
| `plugin/` | ZCode 插件：浏览器自动化技能 |
| `docs/ARCHITECTURE.md` | 架构、协议、里程碑 |

## 安装

**1. 加载扩展**

- Firefox：`about:debugging` → 临时加载附加组件 → `extension/manifest.json`
- Chrome / Edge：`chrome://extensions` → 加载已解压的扩展程序 → `extension/`

**2. 注册原生消息宿主（可选，推荐）**

```bash
node native-host/install.js
```

Chromium 系需把扩展 ID 写入 `native-host/chrome-extension-id.txt` 后重新执行一次。
未注册时自动使用 WebSocket 通道。

**3. 注册 MCP 服务器**

```json
{
  "mcp": {
    "servers": {
      "browser-mcp-lab": {
        "command": "node",
        "args": ["<仓库绝对路径>/server/index.js"]
      }
    }
  }
}
```

**4. 连接**：点击扩展图标 → Connect。

## 工具

| 工具 | 说明 |
|------|------|
| `navigate` | 跳转到 URL（可选 `tabId`、`waitForLoad`） |
| `snapshot` | 页面标题 / URL / 可交互元素（含 `ref` 选择器）/ 正文摘录；`max` 控制元素上限（默认 80） |
| `click` | 点击元素；`humanMode: false` 关闭虚拟光标动画；`force: true` 越过客户端 `disabled` |
| `type` | 输入文本；优先走浏览器原生编辑管线（受信任 `InputEvent`） |
| `press_key` | 按键（合成事件，见兼容性说明） |
| `evaluate` | 页面 MAIN world 执行 JS |
| `screenshot` | 可视区截图，落盘 `./screenshots/` |
| `scroll` | 按像素滚动 |
| `tabs_list` / `tab_select` | 标签页枚举与切换 |
| `wait` | 等待指定秒数 |

## 传输与稳定性

- 原生消息通道优先；WebSocket 回退，仅监听 `127.0.0.1`
- 应用层心跳 5s + 双向 ping/pong 往返 + 半开连接清扫（2.5 个周期）
- 浏览器断开后 15s 释放端口（`BML_EXIT_ON_DISCONNECT=0` 可关闭）
- 端口被占用时明确报错，不终止其他进程
- 环境变量：`BML_PORT` `BML_CONNECT_WAIT_MS` `BML_KEEPALIVE_MS`
  `BML_REQUEST_TIMEOUT_MS` `BML_DISCONNECT_GRACE_MS` `BML_QUIET`

## 测试

```bash
npm test                                        # 全部自动化测试
node server/test/server.test.js                 # 17 项：握手、工具枚举、调用、截图落盘
node server/test/bridge.test.js                 # 原生桥：请求转发 + 心跳往返
node server/test/disconnect.test.js             # 断开后释放端口
```

真机测试（需已加载扩展）：

```bash
node server/test/e2e-firefox.js
node server/test/real-click-test.js
node server/test/real-trust-test.js             # 以 isTrusted 判定点击事件来源
node server/test/demo-cursor.js
```

## 兼容性说明

- `type` 在页面 MAIN world 使用 `document.execCommand("insertText")`，由浏览器完成编辑，
  产出 `isTrusted === true` 的 `InputEvent`；页面拒绝时回退逐字符合成事件，返回值的 `via` 标明路径。
- `press_key` 只发合成 `KeyboardEvent`。`isTrusted` 是 DOM 规范的 `[LegacyUnforgeable]`，
  无法伪造，只认真实按键的页面不响应。
- `click` 的 `force: true` 移除 `disabled` / `aria-disabled` 后点击，仅绕过客户端校验。
- 截图仅覆盖可视区。
- `about:*` 等特权页不可注入，需先导航到普通网页。
- `file://` 页面需在扩展详情页开启「允许访问文件网址」。
- Firefox 扩展页默认 CSP 会把 `ws://` 升级为 `wss://`，已在 manifest 显式声明 CSP 规避。
- `nth-of-type` 选择器在 DOM 变化后可能失效，重新 `snapshot` 即可。
- Chromium 系原生通道需手填扩展 ID 才能启用，缺省走 WebSocket。

## 里程碑

- [x] v0.2.0 MCP 服务器 + 扩展 MVP、自有协议、自动化测试
- [x] v0.2.1 跨浏览器同一份 manifest；Firefox 端到端验证
- [x] v0.3.0 拟人化虚拟光标；双向心跳；断开释放端口
- [x] v0.3.1 原生消息通道作为首选传输，WebSocket 回退
- [x] v0.3.2 受信任输入；`click.force`
- [ ] v0.4.0 Chrome / Edge 真机验证；Firefox 挂起感知重连；`snapshot` 结构化
- [ ] v0.5.0 真实按键路径（Chrome `chrome.debugger` 或原生宿主 OS 级输入）
- [ ] 商店发布

## 许可

[MIT](LICENSE)

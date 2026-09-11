# Browser Session MCP

将当前浏览器会话连接到本地 MCP 客户端的浏览器自动化扩展与服务器。Node.js 22+，无运行时 npm 依赖。0.4.0 的重点是连接可诊断、浏览器目标明确、断开后可恢复。

## 五步开始

1. 在 Firefox / Chrome / Edge 加载 `browser-extension/`（Firefox 选择目录中的 manifest.json）。
2. 在 PI-Desktop 的 MCP 配置中添加本地 stdio 命令 `node`，参数为仓库中 `mcp-server/index.js` 的**绝对路径**。
3. 保存配置并重新连接 MCP 服务器，打开扩展弹窗，确认双方端口一致（默认 9777），点击连接。
4. 调用 **`connection_status`**。无浏览器时按 `nextAction` 操作；多个浏览器时用 **`browser_select`** 明确目标。
5. 用 `tabs_list` 找到用户指定的标签页，后续操作显式携带 `tabId`。

**不要在客户端已经管理服务器时再手动运行 `npm start`**，否则两个进程会争用同一个端口。原生消息宿主是可选增强，不是首次使用的前置条件。

完整配置和按症状排查见 [INSTALL.md](INSTALL.md)。

## 工具

- 连接：`connection_status`、`browser_select`
- 页面：`navigate`、`snapshot`、`read`、`click`、`type`、`press_key`、`evaluate`、`screenshot`、`scroll`
- 标签页与等待：`tabs_list`、`tab_select`、`wait`

推荐流程：状态检查 → 选择浏览器 → 确认标签页 → snapshot → 用 ref 操作 → read/snapshot 验证。

`read` 用固定函数读取元素文本、值、选中/禁用状态和属性，不需要动态求值。`evaluate` 用于表达式求值，受浏览器和 CSP 限制；不能代替所有读取操作。运行时错误不得自动重执行表达式。点击提交等动作若超时，先检查页面状态，避免重复提交。

## 连接与故障恢复

服务器通过 stdio 与 MCP 客户端通信，通过本机回环 WebSocket 接收扩展或原生桥连接。默认浏览器断开时服务器继续运行。

每个扩展配置有客户端标识。选择浏览器后，新接入的其他浏览器不能静默接管它；已选择浏览器断开时，不会把请求改投另一个浏览器。使用 `connection_status` 检查并明确重新选择。

扩展优先尝试原生消息，失败或握手超时后关闭该通道，再使用 WebSocket；同一扩展不会保留两个活跃通道互相争抢。主动断开会阻止自动重连。标签页激活、窗口聚焦和定时健康检查可触发幂等重连检查。

### 终端诊断

```powershell
node mcp-server/index.js --doctor
```

doctor 检查端口、原生宿主配置及等待窗口内连接情况。若客户端服务器已在运行，它会看到端口占用；此时应使用该服务器的 `connection_status`，而不是再起一个服务器。

### 环境变量

推荐使用 `BSM_*`；旧 `BML_*` 名称仍兼容，新名称优先。

- `BSM_PORT`：端口，默认 9777。
- `BSM_CONNECT_WAIT_MS`：网页操作等待连接的上限。
- `BSM_REQUEST_TIMEOUT_MS`：请求响应超时。
- `BSM_KEEPALIVE_MS`：健康检查周期。
- `BSM_EXIT_ON_DISCONNECT`：显式开启时才在宽限期后退出；默认保持服务器运行。
- `BSM_DISCONNECT_GRACE_MS`：开启断连退出时的宽限期。
- `BSM_QUIET`：日志静音。
- `BSM_DOCTOR_WAIT_MS`：doctor 等待客户端的上限。
- `BSM_WS_URL`：原生桥初始下游地址，扩展配置帧可提供目标端口。

## 已知限制

- 工具出现不代表浏览器已连接；浏览器连接也不代表目标网站允许注入。
- 浏览器商店等受保护页面不能注入；不要通过放宽浏览器安全设置规避。
- MAIN world 的动态求值受页面 CSP 限制；隔离世界也受扩展 CSP 限制。请使用 `read` / `snapshot` 等固定操作。
- 按键是合成事件，不保证触发浏览器默认行为或 `isTrusted` 检查。
- 输入会优先尝试浏览器编辑管线，失败时可能回退合成事件；以实际返回路径和页面结果为准。
- 截图是可视区域，不是完整长页面。Chromium 对后台标签截图可能需要激活目标标签。
- 跨域 iframe、特权页面、文件网址可能受额外限制；DOM 变化后重新获取 ref。
- 旧扩展不支持 0.4.0 客户端身份时应升级、重载，不要将旧版与新版混用作多浏览器自动化。

## 隐私与审核

页面内容、网址、表单状态、截图或表达式结果会交给本地 MCP 服务器；下游客户端可能进一步发送给云端模型。只连接可信客户端。参见 [PRIVACY.md](PRIVACY.md)。

商店包不是审核通过证明。`<all_urls>`、动态 `evaluate` 和数据处理声明可能需要进一步审核；本机回环通信不等于没有数据传输，也不自动豁免远程代码政策。

## 开发与发布

```powershell
npm test
npm run package:store
npm run package:source
```

构建输出在 `dist/`，不会入库。源码包提供重建说明；商店包的 manifest 位于 ZIP 根目录。详见 [BUILD.md](BUILD.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。

目录：`browser-extension/` 扩展；`mcp-server/` 服务器和测试；`native-messaging-host/` Windows 原生桥；`tools/` 构建；`test-pages/` 本地测试页；`zcode-plugin/` 可选集成。

仓库地址暂保留为 https://github.com/ashu0729will/browser-mcp-lab ，项目显示名为 Browser Session MCP。

[MIT](LICENSE)

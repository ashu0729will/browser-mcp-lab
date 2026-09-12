# 安装与连接（0.4.1）

## 先分清两个组件

- MCP 服务器：由 PI-Desktop 等客户端启动的 Node.js 子进程，使用标准输入输出通信。
- 浏览器扩展：安装在你希望控制的浏览器中，通过本机端口连接服务器。

看到 MCP 工具列表只证明服务器已启动，不代表浏览器已经连接。

## 1. 准备环境

安装 Node.js 22 或更新版本。执行 `node --version` 验证。项目没有运行时 npm 依赖，不需要 `npm install`。

下载或克隆仓库到固定目录，更新后不要随意移动，否则客户端配置中的路径会失效。

## 2. 在 PI-Desktop 添加 MCP 服务器

在客户端的 MCP 服务器配置入口添加一个 stdio 服务器。不同版本界面位置可能不同；不要把 ZCode 的配置目录当成 PI-Desktop 配置目录。

- 名称：`browser-session-mcp`
- 类型：stdio / 本地命令
- 命令：`node`（若客户端找不到 Node，填写 `node.exe` 的绝对路径）
- 参数：`<仓库绝对路径>/mcp-server/index.js`
- 工作目录（若可设置）：仓库绝对路径
- 环境变量（可选）：`BSM_PORT=9777`

如果客户端支持标准 `mcpServers` JSON 导入，可合并以下条目。不要覆盖已有服务器；不同客户端的外层 JSON 格式可能不同。

```json
{
  "mcpServers": {
    "browser-session-mcp": {
      "command": "node",
      "args": ["C:/path/to/browser-session-mcp/mcp-server/index.js"],
      "env": { "BSM_PORT": "9777" }
    }
  }
}
```

把示例路径替换成实际路径，保存后在客户端重新连接该 MCP 服务器。若没有重新连接按钮，重开会话。

**不要同时手动运行 `npm start`。** stdio 服务器由客户端管理；再起第二个实例会争用端口。

## 3. 安装或更新浏览器扩展

- Firefox：在 `about:debugging` 中临时加载 `browser-extension/manifest.json`；商店签名版可正常安装。临时加载通常需在浏览器重启后重新操作。
- Chrome / Edge：扩展管理页开启开发者模式，加载已解压目录 `browser-extension/`；或安装商店版本。
- 更新源码后必须重载扩展。磁盘文件变了不代表正在运行的扩展已更新。
- 打开扩展弹窗，端口设为与 MCP 服务器相同的值，点击连接。

原生消息宿主是可选组件。先用 WebSocket 回退完成连接，不要把安装宿主作为必经步骤。

要启用原生通道，在 Windows 上执行：

```powershell
node native-messaging-host/install.js
```

Chromium 原生通道还需要将实际安装的扩展 ID 写入 `native-messaging-host/chrome-extension-id.txt` 后重跑安装器。商店版 ID 与未打包版可能不同。未配置时仍可使用 WebSocket；安装器退出码 2 表示 Chromium 配置未完成，不表示 Firefox 配置一定失败。

## 4. 给模型的最短流程

1. 调用 `connection_status`，不要先运行网页工具。
2. 如果没有客户端连接，提示用户加载扩展、确认端口、点击连接；不要反复执行 navigate。
3. 如果有多个浏览器，通过弹窗中的浏览器名称和客户端 ID 确认目标，再调用 `browser_select`。
4. 连接明确后调用 `tabs_list`，只选择用户要求操作的标签页，后续页面工具显式传入 `tabId`。
5. DOM 变化后重新 snapshot，再使用新 ref；不要盲目复用过期选择器。
6. 提交、发送或付款等有副作用动作超时后，不要自动重复；先核对实际状态。

## 5. 按症状排查

- **工具根本没出现**：检查客户端是否加载了配置、Node 命令是否存在、服务器入口是否是绝对路径；查看客户端的 MCP 启动日志。
- **工具出现但没有浏览器连接**：调用 `connection_status`，确认扩展已启用且端口一致。默认断开后服务器继续等待，不需要反复重开进程。
- **连接到多个浏览器**：显式选择目标；不要根据“最后连上的浏览器”推断目标。
- **端口已占用**：先确认是否已有本客户端实例在运行；不要杀死不明进程。需要不同实例时配置不同端口，并同步修改扩展端口。
- **Missing host permission**：属于目标网页访问限制，不是连接问题。浏览器商店等受保护页面不允许扩展注入。
- **CSP / eval 错误**：用固定操作工具 `read`、`snapshot`、`click`、`type` 替代动态 evaluate，不要通过重连或放宽浏览器保护解决。
- **mcp server sent an oversized message / 工具突然全部变成 unknown mcp tool**：单条消息超过客户端上限，客户端丢弃了服务器，于是所有工具都消失。0.4.1 起服务器对每条输出帧设上限（`BSM_MAX_MESSAGE_BYTES`，默认 1 MiB，最小 64 KiB）：超限的**工具结果**返回有界的 `RESULT_TOO_LARGE` 工具错误，服务器与工具注册保持存活，不需要重启。处理方式：不要重复同样的调用，改为取更小的结果（`read` 具体元素、较小的 `snapshot.max`、只取需要的字段）。确需更大结果时可提高 `BSM_MAX_MESSAGE_BYTES`，但**必须低于客户端自身的消息上限**，否则会重新触发本故障。若客户端仍在旧服务器上运行，重启该 MCP 服务器以载入新版本。

终端诊断（通常模型不需要执行）：

```powershell
node mcp-server/index.js --doctor
```

若客户端已占用端口，doctor 报 port-busy 不一定是故障；此时优先调用已运行服务器的 `connection_status`。doctor 是单独进程，不代表已运行服务器的历史状态。

## 隐私与发布

只连接可信客户端。页面内容和截图会传给本地服务器，下游客户端可能进一步发送到模型服务。详见 [隐私政策](PRIVACY.md)。

仓库： https://github.com/ashu0729will/browser-mcp-lab

开发、打包与测试参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

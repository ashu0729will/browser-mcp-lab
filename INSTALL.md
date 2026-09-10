# 安装说明

按顺序执行以下步骤即可在本机启用 browser-session-mcp。

**1. 克隆仓库**（已存在则跳过）

```bash
git clone https://github.com/ashu0729will/browser-mcp-lab.git
```

**2. 加载扩展**（需手动完成）

- Firefox：`about:debugging` → 临时加载附加组件 → `<仓库>/browser-extension/manifest.json`
- Chrome / Edge：`chrome://extensions` → 加载已解压的扩展程序 → `<仓库>/browser-extension/`

**3.（可选）注册原生消息宿主**

```bash
node <仓库>/native-messaging-host/install.js
```

Chromium 系需把扩展 ID 写入 `<仓库>/native-messaging-host/chrome-extension-id.txt` 后重新执行。
脚本会校验 ID 格式、清理旧的 `browser_mcp_lab` 注册表键；缺少有效 ID 时跳过 Chrome / Edge 注册
并以退出码 2 结束（Firefox 已注册）。未注册时自动使用 WebSocket 通道。

**4. 注册 MCP 服务器**

在 `~/.zcode/cli/config.json` 的 `mcp.servers` 下新增一项（只新增条目，不覆盖已有配置）：

```json
"browser-session-mcp": {
  "command": "node",
  "args": ["<仓库绝对路径>/mcp-server/index.js"]
}
```

服务器零依赖，无需 `npm install`；需要 Node.js 22+。

**5. 安装技能**

把 `<仓库>/zcode-plugin/skills/browser-session-mcp` 复制到 `~/.zcode/skills/`。

**6. 连接并验证**

重开会话（MCP 服务器在会话启动时连接），点击浏览器扩展图标 → Connect。
弹窗会显示实际使用的通道（原生消息 / WebSocket）。

验证方式二选一：

- 让 MCP 客户端执行 `navigate` 打开 `https://example.com`，再 `snapshot` 读取页面结构；
- 跑真机冒烟 `node <仓库>/mcp-server/tests/live-smoke.js`（只访问本地测试页，会自起 8123 端口）。

**注意事项**

- 不要提交任何密钥或本机配置。
- 工具未出现时依次检查：扩展弹窗连接状态、config JSON 语法与路径转义、端口 9777 是否被残留进程占用。
  也可以先跑 `node <仓库>/mcp-server/index.js --doctor`，它会逐项报告端口、原生宿主注册与客户端连接情况。

## 图形界面安装

ZCode：Settings → Plugin Management → Discover → `+` → 添加仓库地址
`https://github.com/ashu0729will/browser-mcp-lab` → 在卡片上点 Get。

MCP 服务器需按上面第 4 步手动注册（项目未发布 npm 包，插件清单不预置服务器地址）。

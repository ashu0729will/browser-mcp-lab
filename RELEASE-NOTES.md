# Browser Session MCP 0.4.1 发布说明 / Release Notes

发布日期 / Released: 2026-09-12

本版修复 0.4.0 的一个连接中断缺陷，并保持 0.4.0 的安装、启动、连接诊断与断连恢复改进。
没有新增扩展权限。

## 0.4.1 修复 / Fix in 0.4.1

- **超限消息不再中断连接**：客户端对单条消息有上限，超过时会报
  “mcp server sent an oversized message”，随后**丢弃服务器并使全部工具变成
  “unknown mcp tool”**。旧版会把页面返回的整份 JSON/接口数据原样发出去，一次超大读取即可
  触发该故障。现在服务器对**每一条输出帧**设上限（`BSM_MAX_MESSAGE_BYTES`，默认 1 MiB，最小 64 KiB）：
  超限的**工具结果**改为返回有界、可操作的 `RESULT_TOO_LARGE` 工具错误，说明连接仍然正常、其他工具
  仍可用；服务器与工具注册保持存活，不再需要重启。该上限是服务器侧保证，仍需低于客户端自身的消息上限。
  上限刻意高于服务器自己的 `tools/list` 帧（约 5.8 KB），以免上限反噬工具发现。
- 该行为由 `mcp-server/tests/limits.test.js` 覆盖（3 项）：超限结果被转为工具错误且保留请求 id、
  按 UTF-8 字节而非字符计量、**没有任何一帧超过上限**、随后普通调用仍然成功；并断言最小上限下
  `tools/list` 仍然完整、默认上限不影响正常大小的结果。

## 主要变化 / Highlights

- **客户端内连接诊断**：新增 MCP 工具 `connection_status`，返回结构化的连接状态
  （`connected` / `selected_disconnected` / `selection_required` / `disconnected`）、
  当前已连接的浏览器列表、被选中的 clientId，以及可直接执行的 `nextAction`。
  未连接时页面工具会在**有界等待**后返回可操作错误，而不是无限挂起。
- **多浏览器选择**：新增 `browser_select`。多个浏览器同时接入时，不再把已选目标的
  操作静默转发给其它浏览器；选中的浏览器断开时 `nextAction` 会给出可执行的恢复路径
  （`browser_select` 或重新连接），不再让客户端反复重试同一动作。
- **连接恢复**：扩展身份持久化；短暂断开后可自动恢复；用户主动点击“断开”后不会被
  自动重连覆盖；旧连接的迟到回调按来源隔离，不会误判为当前连接的结果。
- **终端诊断 `--doctor`**：`node mcp-server/index.js --doctor` 一次性只读检查端口占用、
  扩展 ID 文件、原生宿主注册，并实测监听端口。只有在收到扩展的 `hello` 帧后才判定
  “扩展已连接”，避免把任意本机连接误报为扩展；探测结束会关闭全部套接字并设有上限，
  不会挂起。
- **安装与配置文档**：更新 `README.md` / `INSTALL.md`，给出 PI-Desktop 等 MCP 客户端的
  最小配置示例，并明确区分四种失败：配置未加载、服务器未启动、扩展未连接、
  目标网页禁止操作（权限 / CSP）。网页权限或 CSP 错误**不会**被归类为连接失败。
- **打包一致性**：`tools/package-extension.js` 与 `tools/package-source.js` 在写出任何
  ZIP 前完成校验；商店包与源码包可复现（详见 `BUILD.md`）。

## 测试 / Tests

- `npm test` 离线全绿：server 33 / bridge 8 / disconnect 4 / connections 1 /
  extension-transport 95 / doctor 3 / limits 3 / packaging 7，共 **154** 项通过。
- 覆盖：服务器先启动、浏览器先启动、短暂断开与恢复、用户主动断开不被自动重连覆盖、
  旧连接回调隔离、多浏览器同时接入不误转发。
- 全部测试设有超时上限，失败不依赖无限等待或人工重试。

## 浏览器校验 / Validation

- Firefox 包经 `web-ext lint`：**0 error、0 notice、3 warning**：
  1. `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`：`strict_min_version` 为 128，而
     `browser_specific_settings.gecko.data_collection_permissions` 需要 Firefox 140；
     在 128–139 上该声明会被忽略。
  2. `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`：同因，Android 需 142。
  3. `DANGEROUS_EVAL`：`evaluate` 功能会使用 `Function` 构造器执行表达式。
- 以上为**已知警告**，非错误。本版未提高 `strict_min_version`，以避免无谓缩小兼容范围；
  如需在 140 以下正确声明数据收集权限，请在后续版本中提高最低版本。
- 本仓库**不保证**任何商店审核通过；商店包不等于审核通过证明。

## 已知限制 / Known limitations

- 受保护页面（如浏览器商店页面）不允许扩展注入，属于浏览器强制限制。
- `about:` 等内部页面无法导航或操作。
- 使用 `evaluate` 的页面若禁止 `eval`（CSP），将退回隔离世界或返回可操作错误；此时可用
  `snapshot` / `read` 检查页面，或用 `click` / `type` / `press_key` 操作。
- 本机回环通信仍然是数据传输，不自动豁免远程代码相关商店政策。

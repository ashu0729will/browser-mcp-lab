# 开发与贡献指南

## 环境

- Node.js 22+（原生桥、测试与真机冒烟依赖内置的 `WebSocket`）。
- 无第三方依赖，不需要 `npm install`。

## 提交前必须通过

```bash
npm test
```

离线跑全部测试（server 28 / bridge 8 / disconnect 4 / extension-transport 70，共 110 项），必须全绿。
只跑单套：`node mcp-server/tests/<name>.test.js`。

改动 `.js` 后至少跑一次 `node --check <file>`；改了 `browser-extension/service-worker.js`
还必须跑 `mcp-server/tests/extension-transport.test.js`——它在 `node:vm` 里执行真实源码。

## 真机验证

离线测试全绿不代表真机能跑。`mcp-server/tests/live-smoke.js` 会自起本地测试页（8123 端口，
不访问外网），经真实扩展执行导航、点击、输入、滚动、跨 iframe 与截图，并断言页面确实发生变化：

```bash
node mcp-server/tests/live-smoke.js
```

跑之前先让扩展连上（点扩展图标的 Connect）。`SMOKE_KEEP_SCREENSHOT=1` 保留截图供人工查看。

Chromium / Edge 可以用干净的临时配置加载未打包扩展，不影响日常使用的浏览器配置：

```powershell
msedge.exe --user-data-dir=<临时目录> --load-extension=<仓库>\browser-extension --disable-extensions-except=<仓库>\browser-extension --no-first-run
```

**启动浏览器和运行驱动要放在同一条命令里**：否则命令结束时浏览器会随进程树被回收，
驱动只能等到超时。改端口用 `BSM_PORT`。

连接异常先跑：

```bash
node mcp-server/index.js --doctor
```

它逐项检查端口占用、原生宿主注册与 manifest、Chromium 扩展 ID 文件，并在等待窗口内确认是否有客户端连上；
末行 `VERDICT:`（`extension-connected` / `port-busy` / `no-client-yet`）给出结论。

## 打包上架

```bash
npm run package:store        # 或 node tools/package-extension.js
```

输出到 `dist/`（已被 `.gitignore` 忽略）：

- `browser-session-mcp-firefox-<version>.zip`：保留 `background.scripts`，并补上 AMO 要求的
  `browser_specific_settings.gecko.data_collection_permissions`，同时去掉 Firefox 会忽略的 `service_worker`；
- `browser-session-mcp-chrome-<version>.zip`：保留 `service_worker`，去掉 Firefox 专属的
  `browser_specific_settings` 与 `background.scripts`。

打包器是确定性的（条目排序、固定时间戳），同样源码重复构建得到完全相同的字节；它还会校验必需文件、
图标尺寸、以及清单版本与 `package.json` 是否一致，不一致直接以非零码退出。

上架前建议再跑一次 Firefox 官方校验器（`npm run lint:firefox`），并在干净配置里用
`--load-extension` 装上包内文件跑一遍真机冒烟，确认打包产物本身可用。

改动版本号时，`package.json` 与 `browser-extension/manifest.json` 必须同步；商店要求版本严格递增。
Chrome 上架后扩展 ID 会变化，记得把它写进 `native-messaging-host/chrome-extension-id.txt` 并重跑安装脚本，
否则原生通道无法启用（会走 WebSocket 回退）。

## 不入库的文件

以下都是机器本地生成物，`.gitignore` 已覆盖，不要 `git add -f`：

- `screenshots/`
- `.zcode/`
- `native-messaging-host/browser_session_mcp.*.json`
- `native-messaging-host/chrome-extension-id.txt`

## 约定

- 环境变量一律 `BSM_*`；旧 `BML_*` 名称必须继续生效（服务器里有兼容读取层）。
- 原生消息宿主名固定 `browser_session_mcp`，扩展与安装脚本必须一致。
- Firefox gecko id 固定 `browser-session-mcp@ashu0729will.local`，安装脚本按它注册。
- `mcp-server/tests/extension-transport.test.js` 里有一条路径守卫：扫描全仓库的旧目录名与旧品牌，
  有残留就让测试失败；调整目录结构后先跑这套测试。

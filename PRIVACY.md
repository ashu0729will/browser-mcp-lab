# Browser Session MCP Privacy Policy / 隐私政策

Last updated / 更新日期：2026-09-10

## Purpose / 用途

Browser Session MCP connects a browser extension to a separately installed local MCP server so a user-selected MCP client can perform browser automation. This policy covers the extension and companion server distributed by this project, not third-party MCP clients or model providers.

本项目将浏览器扩展连接到单独安装的本地 MCP 服务器，由用户选择的 MCP 客户端执行网页自动化。本政策适用于本项目提供的扩展与配套服务器，不替代第三方客户端或模型服务的政策。

## Information processed / 处理的信息

Depending on the requested operation, the software can access and return open-tab identifiers, titles and URLs; page text, links and element attributes; form values and element state; visible-page screenshots; and results of requested JavaScript expressions. It also processes text, selectors, URLs and other parameters supplied by the client to perform actions.

根据操作请求，软件可能读取并返回标签页标识、标题、网址、页面文本、链接、元素属性、表单值及状态、可视区域截图和表达式执行结果；同时处理客户端提供的文本、选择器、网址等操作参数。页面信息可能包含个人、敏感或已登录会话可见的信息，请勿向不可信客户端开放连接。

The extension does not require an account with the project, include advertising or analytics SDKs, or directly read the browser's saved-password database. Reusing a signed-in browser session does not mean that credentials are exported; however, page contents and requested expression results may themselves contain sensitive information.

扩展不要求注册项目账号，不包含广告或分析 SDK，不直接读取浏览器保存的密码数据库。复用登录态不等于导出凭据，但页面内容及表达式结果本身可能包含敏感信息。

## Transmission and third parties / 传输与第三方

The extension sends requested results to the local companion software using native messaging or a loopback WebSocket connection. The project does not operate a hosted collection or analytics endpoint for these results. Local communication is still data processing and transmission.

The MCP client receives results and may send them to remote model services, store conversation history or write logs. This depends on the client and its configuration and is outside the extension's control. Review those providers' privacy policies before use. Navigation and other page actions also communicate with the websites involved under those websites' own policies.

扩展通过原生消息或回环 WebSocket 将操作结果传给本地配套软件。本项目不为这些结果运营托管收集或分析服务，但本机通信仍属于数据处理和传输。MCP 客户端可能进一步将结果发送至云端模型、保存对话或日志；这些行为取决于客户端配置，不受扩展控制。网页导航及操作也可能与目标网站通信，适用该网站的隐私政策。

## Storage and retention / 保存与保留

Connection settings, including the port and connection switch, are stored in the browser's extension storage. The companion server saves requested screenshots to a local screenshots directory. Screenshot files remain until the user deletes them. Operation results are forwarded to the MCP client, which may retain them under its own settings. Diagnostic output may contain connection information and error details; retention depends on the program capturing those logs.

连接端口和开关保存在浏览器扩展存储中。配套服务器将请求的截图保存到本地 screenshots 目录，直到用户删除。操作结果交给 MCP 客户端，客户端可能按其配置保留结果。诊断输出可能包含连接信息和错误详情，保留时间取决于收集日志的程序。

## Control and deletion / 控制与删除

Use the extension's Disconnect control to stop its automation connection. Remove the extension to remove its browser-managed settings. Delete locally saved screenshots and any client logs or conversation records separately. Uninstalling the extension does not delete files saved by the companion server or third-party clients. Previously transmitted copies cannot be deleted by the extension.

可使用扩展的“断开”停止自动化连接，卸载扩展清除浏览器管理的扩展设置。截图、客户端日志和对话记录需分别删除。卸载扩展不会自动删除配套服务器或第三方客户端保存的文件，扩展也无法删除已传出的副本。

## Use and disclosure / 使用与披露

The project does not sell browser data or use it for advertising, creditworthiness or lending decisions. Access and transmission described above are for the requested browser-automation purpose. These statements do not make guarantees about independently selected third-party clients or providers.

本项目不出售浏览器数据，不将其用于广告、信用评估或贷款决策。上述访问和传输用于用户请求的网页自动化，不代表对用户另行选择的第三方服务作出保证。

## Contact / 联系方式

Maintainer / 维护者：ashu0729will

Privacy questions / 隐私问题：a15240055265@gmail.com

Project / 项目：https://github.com/ashu0729will/browser-mcp-lab

When contacting us, avoid including passwords, tokens, private page contents or screenshots containing personal information. Information voluntarily sent to this contact is used to respond to the request.

联系我们时请勿附带密码、令牌、私人页面内容或包含个人信息的截图。主动发送的联系信息用于回应你的请求。

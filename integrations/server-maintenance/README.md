# 通用 AI 助手、服务器助手与受限维护

OA 工作台提供「通用 AI 助手」入口 `/ai-assistant`，通过 `/api/ai-assistant` 支持自由提问、连续追问，以及在对话中整理文字、方案、计划和代码。一般问题直接由模型回答；涉及已接入的两台服务器时，复用下述固定工具和真实回执。通用入口沿用相同的管理员身份验证及执行范围，不能通过自由对话扩大权限。

通用入口使用服务端固定的通用提示词和 `purpose: general`，不局限于运维话题。实际工具包括服务器诊断、固定清理，以及管理员启用的页面布局、联网检索、工作区文件、隔离命令和固定服务管理。能力由根账号保护的授权文件决定；「开放全部」仅指启用已实现的能力，不赋予模型任意 root、生产文件改写、部署或密钥读取权限。模型不能把文本中的计划、代码或建议声称为已经执行的外部任务。

专用通道为 OA 同域 `/server-assistant`，复用现有管理员登录，通过 `/api/server-maintenance` 与两台服务器通信。该入口使用真实模型工具调用：模型理解当前问题，选择固定诊断工具，OA 执行签名请求，再把真实回执交给模型分析。页面可以展开查看每一步工具回执，模型文本本身不代表操作成功。

可以直接输入：

- `检查两台服务器的健康状态，说明需要关注的问题`
- `帮我排查腾讯云服务器为什么慢`
- `分析阿里云服务器磁盘占用，找出主要占用来源`
- 接着追问 `继续看看 nginx 的日志` 或 `腾讯那台呢`
- `预览两个服务器临时文件清理`，查看结果后输入 `确认清理`

主聊天 `/api/lab-ai/ask` 和角色卡片的私有 AI 助研会话保留原有固定意图查询与清理能力。它们不会调用本次新增的模型工具循环；需要连续自然语言诊断时使用专用通道。

## 对话与执行边界

仅已登录、已激活且当前成员身份绑定有效的 OA 管理员能够使用专用通道。API 检查成员绑定及版本，主机适配器再次通过固定本机 `/api/session` 核对身份。浏览器只提交当前问题和可选的随机会话标识，不提交历史、工具、系统提示词或清理权限。公共 Chat、普通成员和课程 AI 不接入服务器工具。

会话由 OA 主机保存并绑定账号及入口类型，通用助手与服务器助手不能互用会话标识。闲置 30 分钟失效，最多保留最近 4 个已完成轮次，并受消息数和字节上限约束。刷新页面或点击「清空本页」会开始新会话；OA 重启会使内存中的会话失效。另一账号不能使用已有会话标识，也不能借助历史清理指令获得当前执行权限。

每条用户问题最多 7 次模型请求、12 次工具调用，总时限 135 秒。Chat 使用现有已配置的百炼模型、加密密钥和每次调用预算，服务间沿用 OA HMAC 与 nonce 防重放认证，不新增浏览器密钥或公共工具接口。固定系统提示词和工具定义来自 `tool-policy.mjs`；模型桥和 OA 主机分别校验工具参数，服务器端再次执行独立白名单检查。

| 工具 | 实际能力 |
| --- | --- |
| `server_status` | 当前系统分区、可用内存、CPU 负载、运行时间及主要服务状态 |
| `server_diagnostic` / `processes` | 有界进程资源采样，不返回命令参数或进程环境 |
| `server_diagnostic` / `service` | 固定服务的 systemd 状态属性 |
| `server_diagnostic` / `logs` | 固定服务最近一小时、最多 50 条 journal 日志，进行凭据等敏感文本脱敏 |
| `server_diagnostic` / `disk` | 固定目录的有界元数据扫描，不读取文件正文，不跨文件系统或跟随符号链接 |
| `cleanup_preview` | 生成短时、账号绑定的固定范围清理计划，不删除文件 |
| `cleanup_execute` | 仅在当前用户明确授权目标服务器清理时提供，执行经复核的固定范围计划 |

阿里云允许查询 `nginx`、`originmind-oa`、`originmind-chat`；腾讯云允许查询 `nginx`、`docker`、`originmind-arena`、`originmind-cloud-mcp`。磁盘扫描仅允许代码中列出的主要目录；结果 `limited` 表示扫描不完整，不能当作完整目录总量或与 `df` 数字直接对等。诊断工具保持只读，新增操作工具另行按实际能力授权。

查询和清理均根据当次回执报告，不用历史数字补齐失败服务器。页面「工具回执已核对」仅表示本次调用均取得可核对的回执；纯对话回答不显示该状态。模型失败后仍保留已取得的实际操作回执，避免把已发生的清理说成未发生。诊断数据作为不可信材料进入模型，不能授予新权限。

清理仅接受当前明确指令，疑问、引用、否定及混合危险操作不会提供写工具。「确认清理」只能引用当前账号会话内未过期的预览目标。预览不等于释放空间；清理结果以实际删除计数、字节数及磁盘前后值为准。同一轮重复清理调用复用首次回执，不重复删除。

## 已实现的管理员操作能力

`/etc/originmind-maintenance/assistant-permissions.json` 必须由 root 管理，OA 服务只能读取，不能由浏览器、模型或工作区命令修改。授权只对已经通过现有身份校验的活跃 OA 管理员生效。能力列表只接受 `ui`、`files`、`commands`、`services`、`web`，不代表全系统权限。配置示例：

```json
{"enabled":true,"scope":"active_oa_admin","capabilities":["ui","files","commands","services","web"]}
```

| 能力 | 实际执行范围与回执 |
| --- | --- |
| `ui` | `ui_layout` 可将当前助手铺满页面或恢复窄版；浏览器级全屏由页面顶部按钮或直接用户手势触发，受浏览器 Fullscreen API 支持及策略限制 |
| `files` | `workspace_file` 可列出、读取、写入、建目录、移动和移入回收站，仅限指定服务器上当前账号工作区的相对路径 |
| `commands` | `command_start` 在工作区以独立非 root 数字 UID/GID 启动 Bash 任务，可运行现有 Python/Node、构建代码或安装项目依赖；`command_status` 与 `command_cancel` 查询或取消真实任务 |
| `services` | `service_control` 对上述固定服务执行 `start`、`restart` 或 `reload`，且本轮必须有明确、可解析的用户服务操作指令 |
| `web` | `web_search` 使用当前百炼 Token Plan/工作区配置的 Responses 搜索工具，要求上游返回已完成搜索事件及真实公开来源 URL |

页面铺满与浏览器全屏是两个独立状态。模型回复「已全屏」不能代替界面变更；浏览器拒绝全屏时要展示实际结果，引导用户使用顶部按钮，不能假装已隐藏地址栏。

文件位于 `/var/lib/originmind-assistant/workspaces/<actor-hash>`，路径由已验证账号派生，不能指定其他账号或跳出工作区。拒绝路径穿越、符号链接、硬链接和受保护名称。已有文件写入必须带最近读取的 SHA256，新文件使用 `expectedSha256: new`，版本变化则拒绝覆盖；移动不覆盖已有目标。`trash` 保留回收站内容，不永久删除；当前没有对话式恢复工具。变更请求的 ID、审计和结果持久保存，遇到不确定状态不会盲目重放。

命令由 root 代理调用 `systemd-run` 建立沙箱，实际进程使用独立账户的数字 UID/GID，清空继承环境，不拥有 capabilities 或 sudo/root 权限。工作区为可写范围，生产配置及部署目录被遮蔽，`/proc`、`/sys` 不可访问，输出有界并脱敏。网络禁止回环、链路本地、内网、元数据地址等，DNS 仅例外允许本机解析器 `127.0.0.53`；公开网络用于项目依赖等任务。单任务 10–90 秒、512 MiB 内存、128 个任务线程、100% 单核 CPU 配额、单文件 256 MiB；并发和主机剩余空间也有上限。命令启动回执只代表开始，必须依据任务状态和退出码判断完成。

服务管理不接受任意 unit、`stop`、权限变更、认证、防火墙或 systemd 定义修改；历史指令和模型生成的文本不能授予本轮重启权限。重启 OA 或 Chat 可能中断当前对话，最终状态仍需核对真实服务回执。工作区代码不会自动写入生产源码或部署。

联网检索只使用现有模型、端点与密钥组合，不自动切换模型、计费路由或供应商。模型或提供方不支持 Responses 搜索、请求失败、没有搜索事件或有效来源时明确失败，不把普通模型回答当搜索成功。来源 URL 必须来自提供方搜索结果，不能由模型凭空补出；页面展示实际来源链接，网页内容和工具输出均视为不可信资料。其他应用集成、生产部署、任意生产文件改写和密钥读取仍未开放。

## 固定清理范围

只扫描以下目录中 root 所有、单硬链接、超过 7 天且未发生变化的普通文件：

| 类别 | 固定目录 | 范围 |
| --- | --- | --- |
| 安装包缓存 | `/var/cache/apt/archives` | 仅顶层 `.deb` |
| 维护临时文件 | `/tmp/omindos-ai-maintenance` | 受保护目录内的普通文件 |
| 维护缓存 | `/var/cache/omindos-maintenance` | 受保护目录内的普通文件 |

拒绝符号链接、硬链接、跨文件系统、其他用户可写目录以及凭据、数据库、上传、备份、部署和日志名称。每次最多 500 个文件、500 MiB。业务上传目录、数据库、部署版本和任意 `/tmp` 文件不属于可清理范围。空目录或无过期缓存时实际删除 0 项，不会扩大范围。删除前复核设备、inode、时间和大小，审计失败时不开始清理；清理后审计失败时保留可幂等重试的结果。

## 生产接入

主分支与现网 OA、Chat 发布包各有独立差异。必须从当前线上版本创建隔离候选包，核对哈希后增量修改，不能用主分支全量覆盖。此次版本涉及两台主机代理、操作执行器、OA 主机模块、Chat 模型桥和 OA 构建，必须作为兼容的组合发布。

1. 两台机器安装 `agent.py` 与 `server_operations.py` 至 `/opt/originmind-maintenance/`。配置 `/etc/originmind-maintenance/agent.json` 为 `0600 root:root`，只含 `server` 和单台独立随机 `secret`。预先创建固定清理目录（`0700 root:root`）和审计文件（`0600 root:root`）；服务只监听 `127.0.0.1:18893`。
2. 两台机器预先创建无交互登录的独立系统账户 `originmind-assistant`。由 root 创建 `/var/lib/originmind-assistant` 及其 `workspaces` 子目录（`0711 root:root`），`receipts` 为 `0700 root:root`；各账号工作区由执行器创建为专用账户所有、`0700`。维护 systemd unit 启用 `--operations`，将 `/var/lib/originmind-assistant` 加入 `ReadWritePaths`，代理仅保留 `CAP_CHOWN CAP_DAC_OVERRIDE`，其他写路径和网络限制继续保留。这些 capabilities 属于 root 代理，不传给命令进程。验证 transient systemd 沙箱和网络保护确实生效后再授予命令能力。
3. 腾讯 HTTPS 虚拟主机加载 Nginx 精确路径配置；来源仅允许实际 OA 服务器出口 IP，仍需单台 HMAC 密钥、60 秒有效时间和一次性 nonce。操作请求包含工作区内容，精确路径需设置 `client_max_body_size 64k`、`proxy_read_timeout 45s`，不能继续使用旧的 `8k`/`15s` 限制。不能把根权限通用 MCP 直接开放给模型。
4. 阿里云主机同时安装 `conversation.mjs`、`agent-conversation.mjs`、`tool-policy.mjs`、`operation-policy.mjs` 和 `operation-runner.mjs`。保留 `/etc/originmind-maintenance/oa-client.json`（`0640 root:originmind-oa`）的两个固定目标地址与独立密钥。root 创建同目录 `assistant-permissions.json`，按已授权范围列出实际能力，设为 `0640 root:originmind-oa`；目录和文件不得由 OA 写入。不要输出密钥或提交配置到 Git。`conversation.mjs` 仍负责登录验证、签名调用、限流和旧入口；仅专用入口收到服务器端模型回调时进入新循环。
5. 从当前 Chat 发布包创建候选版本，增加 `chat-cloudflare/src/server-agent-bridge.mjs`、`server-agent-web-search.mjs` 及相对路径依赖 `integrations/server-maintenance/tool-policy.mjs`、`operation-policy.mjs`，对现网 `oa-chat-bridge.mjs` 增量接入 `server_agent_turn` 和 `server_agent_web_search` 的校验与分流。保留既有任务诊断、流式回答、模型配置、预算和 HMAC 防重放代码；模型密钥仍留在 Chat 服务。先验证新私有 operation，再启用 OA 新客户端。
6. 从当前 OA 发布包创建候选版本，增量更新 `lib/oa-chat-client.ts` 的模型及联网检索回调、`lib/server-maintenance-ask.*`、两个专用 API、`app/server-assistant/` 及 `app/ai-assistant/` 页面，并通过 `components/server-assistant-entry.tsx` 接入工作台。保留现网人员查询和 SSE 改动；两个 API 都只接受当前问题和会话标识，入口类型与授权由服务器确定。核对 Next 构建、类型检查、页面与静态资源，确认匿名访问 API 被拒绝后再切换 OA 版本并重启，使动态主机模块重新加载。
7. 首次接入旧角色私有会话时，先核对 `aliyun/ai-members/oa-research.mjs` 哈希，再用 `patch-oa.py --root <candidate-release> --expected-sha256 <reviewed-sha256>` 添加旧意图分流。主聊天原固定意图接入由 `wire-main-chat.py` 按三份生产文件哈希增量修改。已接入的文件不能重复套补丁；这两个脚本不安装新模型循环。

客户端配置结构（仅占位，不可直接投产）：

```json
{"servers":{"aliyun":{"url":"http://127.0.0.1:18893/v1/maintenance","secret":"<独立随机密钥>"},"tencent":{"url":"https://omindos.cn/_maintenance/v1","secret":"<另一独立随机密钥>"}}}
```

## 验证与回退

CI 运行新模型策略、联网检索、操作权限与多轮执行测试、旧意图兼容测试、专用 API 身份边界测试，以及共享 Chat 桥、任务工具、流式桥和状态指标回归：

```bash
node --test tests/server-agent*.test.mjs tests/server-assistant-operations.test.mjs tests/server-maintenance-conversation.test.mjs tests/server-maintenance-ask.test.mjs tests/server-maintenance-api.test.mjs tests/ai-assistant-api.test.mjs tests/oa-chat-indicators.test.mjs tests/oa-chat-parity.test.mjs tests/wecom-bot-model-stream.test.mjs tests/ai-workbench-bridge.test.mjs tests/ai-workbench-tools.test.mjs tests/ai-workbench-failure-diagnostics.test.mjs
sudo python3 tests/server-maintenance-agent.test.py
sudo python3 tests/server-operations.test.py
```

上线检查两台机器的签名状态与诊断请求、错误签名、nonce 重放、固定服务及路径拒绝、日志脱敏、只读预览和白名单内专门创建的过期测试文件。新增操作使用自建工作区测试文件验证版本冲突、移动、回收站、幂等回执、数字 UID 命令执行、生产目录与进程信息隔离、网络保护、任务退出码及取消；服务控制先验证参数和当次授权边界，实际操作按用户明确指令执行。还需验证真实模型与多轮追问、页面铺满和按钮全屏，以及提供方实际搜索事件与来源链接。真实管理员浏览器验收使用正常登录，不生成或导出现有成员会话；服务级替身登录测试不能宣称完成了真实用户登录验收。

记录切换前的 OA/Chat 发布目标、主机模块与代理哈希、构建结果及验证回执。升级失败时先停用授权文件中的新增能力并恢复兼容的 OA 发布包、重启 OA，停止新模型请求；再恢复 Chat 发布包。主机适配器、执行循环、策略和运行器要成组恢复，重启 OA 清除旧模块和会话。工作区文件、回收站、审计及持久回执应保留；核对或取消仍在运行的命令任务，再撤销代理的 `--operations`、新增 capabilities 及写路径。诊断代理可保留给旧 `status`/`plan`/`clean` 客户端使用；如恢复旧代理，先确认 OA 不再发送 `diagnostic` 或 `operations`。

完全移除此能力时，再恢复旧角色适配器备份及主聊天增量接入，移除腾讯精确 Nginx 路径并检查、重载 Nginx，停用两台新增的 `originmind-maintenance.service`。不替换原 OA、Chat、Cloud 和通用 MCP 的其他配置。

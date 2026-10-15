# 通用 AI 助手、服务器助手与受限维护

OA 工作台提供「通用 AI 助手」入口 `/ai-assistant`，通过 `/api/ai-assistant` 支持自由提问、连续追问，以及在对话中整理文字、方案、计划和代码。一般问题直接由模型回答；涉及已接入的两台服务器时，复用下述固定工具和真实回执。通用入口沿用相同的管理员身份验证及执行范围，不能通过自由对话扩大权限。

通用入口使用服务端固定的通用提示词和 `purpose: general`，不局限于运维话题。当前实际外部操作能力仅为已授权的两台服务器查询与固定范围清理；没有接入联网检索、其他应用操作、任意 Shell 或通用任务执行器。模型可以在对话里提供文字成果，但不能把文本中的计划、代码或建议声称为已经执行的外部任务。

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

阿里云允许查询 `nginx`、`originmind-oa`、`originmind-chat`；腾讯云允许查询 `nginx`、`docker`、`originmind-arena`、`originmind-cloud-mcp`。磁盘扫描仅允许代码中列出的主要目录；结果 `limited` 表示扫描不完整，不能当作完整目录总量或与 `df` 数字直接对等。工具不支持任意 Shell、读取密钥、修改业务文件、重启、安装或部署。

查询和清理均根据当次回执报告，不用历史数字补齐失败服务器。页面「工具回执已核对」仅表示本次调用均取得可核对的回执；纯对话回答不显示该状态。模型失败后仍保留已取得的实际操作回执，避免把已发生的清理说成未发生。诊断数据作为不可信材料进入模型，不能授予新权限。

清理仅接受当前明确指令，疑问、引用、否定及混合危险操作不会提供写工具。「确认清理」只能引用当前账号会话内未过期的预览目标。预览不等于释放空间；清理结果以实际删除计数、字节数及磁盘前后值为准。同一轮重复清理调用复用首次回执，不重复删除。

## 固定清理范围

只扫描以下目录中 root 所有、单硬链接、超过 7 天且未发生变化的普通文件：

| 类别 | 固定目录 | 范围 |
| --- | --- | --- |
| 安装包缓存 | `/var/cache/apt/archives` | 仅顶层 `.deb` |
| 维护临时文件 | `/tmp/omindos-ai-maintenance` | 受保护目录内的普通文件 |
| 维护缓存 | `/var/cache/omindos-maintenance` | 受保护目录内的普通文件 |

拒绝符号链接、硬链接、跨文件系统、其他用户可写目录以及凭据、数据库、上传、备份、部署和日志名称。每次最多 500 个文件、500 MiB。业务上传目录、数据库、部署版本和任意 `/tmp` 文件不属于可清理范围。空目录或无过期缓存时实际删除 0 项，不会扩大范围。删除前复核设备、inode、时间和大小，审计失败时不开始清理；清理后审计失败时保留可幂等重试的结果。

## 生产接入

主分支与现网 OA、Chat 发布包各有独立差异。必须从当前线上版本创建隔离候选包，核对哈希后增量修改，不能用主分支全量覆盖。此次版本涉及两台主机代理、OA 主机模块、Chat 模型桥和 OA 构建，必须作为兼容的组合发布。

1. 两台机器安装 `agent.py` 至 `/opt/originmind-maintenance/`，配置 `/etc/originmind-maintenance/agent.json` 为 `0600 root:root`，只含 `server` 和单台独立随机 `secret`。安装 systemd unit，预先创建清理目录（`0700 root:root`）和审计文件（`0600 root:root`）。服务只监听 `127.0.0.1:18893`，保留严格写路径、capabilities 和网络限制。诊断增量仅增加只读能力。
2. 腾讯 HTTPS 虚拟主机加载 Nginx 精确路径配置；来源仅允许实际 OA 服务器出口 IP，仍需单台 HMAC 密钥、60 秒有效时间和一次性 nonce。不能把根权限通用 MCP 直接开放给模型。
3. 阿里云主机同时安装 `conversation.mjs`、`agent-conversation.mjs` 和 `tool-policy.mjs`。保留 `/etc/originmind-maintenance/oa-client.json`（`0640 root:originmind-oa`）的两个固定目标地址与独立密钥，不输出配置或提交 Git。`conversation.mjs` 仍负责登录验证、签名调用、限流和旧入口；仅 `dedicated: true` 且收到服务器端模型回调时进入新循环。
4. 从当前 Chat 发布包创建候选版本，增加 `chat-cloudflare/src/server-agent-bridge.mjs` 及相对路径依赖 `integrations/server-maintenance/tool-policy.mjs`，对现网 `oa-chat-bridge.mjs` 增量接入 `server_agent_turn` 的校验和分流。保留既有任务诊断、流式回答、模型配置、预算和 HMAC 防重放代码；模型密钥仍留在 Chat 服务。先验证新私有 operation，再启用 OA 新客户端。
5. 从当前 OA 发布包创建候选版本，增量更新 `lib/oa-chat-client.ts` 的 `serverAgentModelTurn`、`lib/server-maintenance-ask.*`、两个专用 API、`app/server-assistant/` 及 `app/ai-assistant/` 页面，并通过 `components/server-assistant-entry.tsx` 接入工作台。保留现网人员查询和 SSE 改动；两个 API 都只接受当前问题和会话标识，入口类型由服务器确定。核对 Next 构建、类型检查、页面与静态资源，确认匿名访问 API 被拒绝后再切换 OA 版本并重启，使动态主机模块重新加载。
6. 首次接入旧角色私有会话时，先核对 `aliyun/ai-members/oa-research.mjs` 哈希，再用 `patch-oa.py --root <candidate-release> --expected-sha256 <reviewed-sha256>` 添加旧意图分流。主聊天原固定意图接入由 `wire-main-chat.py` 按三份生产文件哈希增量修改。已接入的文件不能重复套补丁；这两个脚本不安装新模型循环。

客户端配置结构（仅占位，不可直接投产）：

```json
{"servers":{"aliyun":{"url":"http://127.0.0.1:18893/v1/maintenance","secret":"<独立随机密钥>"},"tencent":{"url":"https://omindos.cn/_maintenance/v1","secret":"<另一独立随机密钥>"}}}
```

## 验证与回退

CI 运行新模型策略与多轮执行测试、旧意图兼容测试、专用 API 身份边界测试，以及共享 Chat 桥、任务工具、流式桥和状态指标回归：

```bash
node --test tests/server-agent*.test.mjs tests/server-maintenance-conversation.test.mjs tests/server-maintenance-ask.test.mjs tests/server-maintenance-api.test.mjs tests/ai-assistant-api.test.mjs tests/oa-chat-indicators.test.mjs tests/oa-chat-parity.test.mjs tests/wecom-bot-model-stream.test.mjs tests/ai-workbench-bridge.test.mjs tests/ai-workbench-tools.test.mjs tests/ai-workbench-failure-diagnostics.test.mjs
sudo python3 tests/server-maintenance-agent.test.py
```

上线检查两台机器的签名状态与诊断请求、错误签名、nonce 重放、固定服务及路径拒绝、日志脱敏、只读预览和白名单内专门创建的过期测试文件。还需验证通用入口的一般问题与文字任务、真实模型选择服务器工具、根据真实服务器回执回答，并携带同一会话标识完成追问。真实管理员浏览器验收使用正常登录，不生成或导出现有成员会话；服务级替身登录测试不能宣称完成了真实用户登录验收。

记录切换前的 OA/Chat 发布目标、主机三个模块与代理哈希、构建结果及验证回执。升级失败时先恢复兼容的 OA 发布包并重启，停止新模型请求；再恢复 Chat 发布包。主机 `conversation.mjs`、`agent-conversation.mjs`、`tool-policy.mjs` 要成组恢复，重启 OA 清除旧模块和会话。诊断代理可保留给旧 `status`/`plan`/`clean` 客户端使用；如恢复旧代理，先确认 OA 不再发送 `diagnostic`。

完全移除此能力时，再恢复旧角色适配器备份及主聊天增量接入，移除腾讯精确 Nginx 路径并检查、重载 Nginx，停用两台新增的 `originmind-maintenance.service`。不替换原 OA、Chat、Cloud 和通用 MCP 的其他配置。

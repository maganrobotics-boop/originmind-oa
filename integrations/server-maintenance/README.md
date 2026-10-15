# AI 助研服务器查询与受限清理

OA 管理员在 AI 助研对话中可以发送：

- `查询两个服务器状态`
- `查一下阿里云服务器磁盘空间`
- `预览两个服务器临时文件清理`
- `清理两个服务器的临时文件`

查询每次读取两台机器的实时状态，返回采集时间、系统分区容量、可用内存、CPU负载、运行时间和固定服务状态。单台失败时分别报告，不使用上一次数字补齐。

只对已登录、已激活的 OA 管理员开放，沿用现有 OA 的管理员准入规则。管理员身份来自固定本机 `/api/session` 的服务端验证，浏览器传入的身份、模型输出、对话历史和知识库材料不能授予权限。公共 Chat 和课程 AI 不接入服务器工具。

清理仅接受明确的当次清理指令。疑问句、引用和复合命令只预览，否定句不操作。执行前生成短时计划，删除时再次检查文件身份和更新时间，操作结果写入服务器审计记录。

## 固定清理范围

只扫描以下目录中 root 所有、单硬链接、超过 7 天且未发生变化的普通文件：

| 类别 | 固定目录 | 范围 |
| --- | --- | --- |
| 安装包缓存 | `/var/cache/apt/archives` | 仅顶层 `.deb` |
| 维护临时文件 | `/tmp/omindos-ai-maintenance` | 受保护目录内的普通文件 |
| 维护缓存 | `/var/cache/omindos-maintenance` | 受保护目录内的普通文件 |

拒绝符号链接、硬链接、跨文件系统、其他用户可写目录以及凭据、数据库、上传、备份、部署和日志名称。每次最多 500 个文件、500 MiB。业务上传目录、数据库、部署版本和任意 `/tmp` 文件不属于可清理范围。空目录或无过期缓存时返回实际删除 0 项，不会扩大范围。

## 生产接入

主分支和现网 OA 发布包存在独立差异。本目录作为独立服务和适配器补丁部署，不能用主分支全量覆盖现网 OA。

1. 两台机器安装 `agent.py` 至 `/opt/originmind-maintenance/`，配置 `/etc/originmind-maintenance/agent.json` 为 `0600 root:root`，只含 `server` 和单台独立随机 `secret`。不要把配置提交到 Git。
2. 安装提供的 systemd unit。预先创建白名单目录（`0700 root:root`）和审计文件（`0600 root:root`）。服务仅监听 `127.0.0.1:18893`，通过 systemd 限制可写路径并清除 Linux capabilities。
3. 腾讯 HTTPS 虚拟主机加载 Nginx 精确路径配置；访问来源仅允许实际 OA 服务器出口 IP。外网调用还必须持有单台 HMAC 密钥，消息包含 60 秒有效时间和一次性 nonce。
4. 阿里安装 `conversation.mjs`，创建 `/etc/originmind-maintenance/oa-client.json`（`0640 root:originmind-oa`）。只允许两个固定目标地址。该配置仅由 OA 服务读取，不下发前端。
5. 核对当前 `aliyun/ai-members/oa-research.mjs` 的 SHA256，再运行 `patch-oa.py --root <active-release> --expected-sha256 <reviewed-sha256>`。脚本保留原文件备份，只新增维护对话分流，原知识问答和流式回复继续使用原实现。
6. 原角色卡片的私有 `ai-research` 会话由适配器接入；页面常用 AI 助研的 `/api/lab-ai/ask` 也必须接入。使用 `wire-main-chat.py` 核对真实生产的路由、聊天面板和指标文件哈希后，对独立候选版本应用增量补丁，并复制两个 `lib/server-maintenance-ask.*` 文件。保留现网人员查询和 SSE 功能，完成 Next 构建、类型检查及 HTTP 验证后切换版本。

客户端配置结构（占位值，不可直接投产）：

```json
{"servers":{"aliyun":{"url":"http://127.0.0.1:18893/v1/maintenance","secret":"<独立随机密钥>"},"tencent":{"url":"https://omindos.cn/_maintenance/v1","secret":"<另一独立随机密钥>"}}}
```

## 验证与回退

```bash
node --test tests/server-maintenance-conversation.test.mjs tests/server-maintenance-ask.test.mjs tests/oa-chat-indicators.test.mjs
python3 tests/server-maintenance-agent.test.py
```

上线检查签名请求、错误签名、nonce 重放、只读预览和白名单内专门创建的过期测试文件。匿名 OA 会话及普通成员不能调用。真实管理员登录态的浏览器验收需使用正常登录，不生成或导出现有成员会话。

回退时先恢复 `patch-oa.py` 保存的 OA 适配器备份并重启 OA，再移除腾讯精确 Nginx 路径并检查/重载 Nginx，停用两台新增的 `originmind-maintenance.service`。原 OA、Chat、Cloud 和通用 MCP 服务配置不受替换。

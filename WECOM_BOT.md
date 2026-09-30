# 企微 OA 助研试用

新增企业微信智能机器人长连接入口，复用已有 OA 成员、工作项、知识库和助研模型。它不创建网页登录会话，也不替代 PR #115 的统一二维码 OAuth 登录。

## 本次范围

- 仅支持与机器人私聊的文字消息；群聊只回复公开使用提示。
- 用户在已登录 OA 的 `/integrations/wecom-bot` 生成五分钟绑定码，私聊发给机器人，再回 OA 确认。绑定码仅保存哈希，不放在 URL、日志或浏览器持久存储中。
- 身份按机器人 ID + 发送者 ID 关联现有成员。不会按姓名或邮箱匹配，不复用企微 OAuth 身份。
- `我的待办` 或 `/待办` 只读取本人负责或创建的未完成工作项；普通提问调用现有 OA 已审核知识检索和助研。当前没有提交、审批或业务修改命令。
- 每次调用及生成答案后重新检查成员、账号、角色、NDA 与绑定状态。管理员沿用 OA 的 NDA 豁免，仍须有已启用的成员记录。解绑、成员停用或重新绑定账号后，旧机器人身份不能读取 OA 数据。
- 知识候选按提问关键词读取最多 256 个有效分块，再调用现有 OA 排序与问答逻辑。只读取当前有效且审核通过的内部/公开资料，既不依赖 NDA 缓存字段，也不修改已有资料库授权逻辑。
- 模型调用前后精确核对所选证据的资料、版本、分块、权限与内容；生成过程中资料撤回或改写时，该回答不会返回。新增资料改变关键词候选排序不会使仍有效的证据被误判。

## 创建机器人（唯一需要企微侧手工操作的部分）

企微客户端：工作台 → 智能机器人 → 创建 → 手动创建 → API 模式创建 → 使用长连接。名称可填“OriginMind OA 助研”，先将可使用范围设为本人进行试用。企业管理后台也可从安全与管理 → 管理工具 → 智能机器人进入。

保存 Bot ID 与长连接专用 Secret。它们不同于 CorpID、AgentID、自建应用 Secret。不要在聊天、截图、仓库或命令行参数中发送真实 Secret。

官方资料：

- https://cloud.tencent.com/document/product/1759/121473
- https://github.com/WecomTeam/aibot-node-sdk

## 阿里云部署准备

本次开发基于 main `e70c9118fe778291e95e1f3c109a8e0eff81c252`。main 与当前生产源码已有差异，不能用 main 全量覆盖线上。新增文件可单独集成；`app/api/_lib/auth.ts` 只添加 `getAuthorizedIntegrationMember`，保留线上现有授权函数及阿里云数据库/模型适配。`deploy/wecom-bot/aliyun-auth.patch` 针对实际生产 `oa-8a0bffc8b1e1`，配套 manifest 记录原文件校验值；先核验校验值并在源码副本执行 `git apply --check`，再应用补丁。候选保留生产 package、Next 配置与适配器，不包含环境配置、业务数据库或上传文件。源码变更后须重新完成类型检查、构建和回归。

新增 `drizzle/0036_wecom_bot.sql`，只创建机器人绑定、临时绑定请求与消息去重三张表及六个索引，不改审批、成员、资料或待办数据。`0035` 保留给尚未上线的二维码登录 PR；不能因此自动应用该 PR 的迁移。先备份数据库、核验新表尚不存在、在事务内应用并记录迁移，再检查精确表结构和索引。首次试用准备不执行生产迁移。

SDK 锁定为 `@wecom/aibot-node-sdk@1.0.7`，依赖放在 `deploy/wecom-bot`，不加入 OA 网页构建依赖：

```sh
npm ci --ignore-scripts --prefix deploy/wecom-bot
node --test tests/wecom-bot-*.test.mjs
npm run typecheck
```

独立机器人服务目录应包含 `scripts/wecom-bot.mjs`、`lib/wecom-bot-transport.mjs` 及 `deploy/wecom-bot/package*.json` 和安装后的依赖；安装到 `/opt/originmind-wecom-bot/current`。创建无登录权限的 `originmind-wecom-bot` 系统用户，将服务文件安装为 `originmind-wecom-bot.service`，单个 Bot 只运行一个实例。服务指定当前阿里云的 `/usr/local/bin/node`（Node 22.23.3）；换服务器时须核验该路径与版本。

`scripts/configure-wecom-bot.py` 是本机交互配置程序：以 sudo 运行，输入 Bot ID 与不回显的 Bot Secret；它生成独立桥接密钥，仅写入新的机器人专用配置文件和 OA systemd EnvironmentFile 引用，不读取、改写 `/etc/originmind-oa/env`，不打印密钥，不启动服务。已有机器人配置时会拒绝覆盖。

OA 端需要 `WECOM_BOT_ENABLED=true`、`WECOM_BOT_ID`、`WECOM_BOT_BRIDGE_SECRET` 与 `OA_PUBLIC_ORIGIN=https://oa.omindos.cn`，配置程序将它们写入新的 `bridge.env`。机器人端需要 `WECOM_BOT_ID`、`WECOM_BOT_SECRET`、同一桥接密钥及 `WECOM_BOT_BRIDGE_URL`。当前 OA 主站上游为 `127.0.0.1:3000`；额外预览路径使用其他端口，不应作为机器人服务地址。桥接密钥是 43 字符 base64url 值；Bot Secret 仅用于官方 SDK，不发给 OA 请求接口。

完成源码、迁移、配置及备份核对后，再执行 systemd daemon-reload、OA 切换/重启和机器人启动。未配置时 API 返回未启用，机器人不会连接。

## 验证与运行边界

桥接请求使用独立 HMAC 签名，严格限制时间窗口、JSON 字段、请求体和返回值大小，拒绝重定向。持久化消息 ID 去重；迁移冻结时不写入。SDK 日志不输出回调、消息正文或密钥；只记录固定状态码。流式回复先给静态处理提示，再给最终回答，单次文字回复保守限制为 2000 UTF-8 字节。

试用验收：创建机器人 → 安全配置 → 服务认证成功 → 从真实 OA 登录绑定 → 私聊查询本人待办及问答 → 验证群聊不返回私有资料 → 解绑及停用后拒绝读取。未完成真实 Bot 配置与手机私聊之前，不宣称联调或上线完成。

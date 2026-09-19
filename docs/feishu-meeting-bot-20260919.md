# OA 助手独立参会：实现、验收与上线门槛（2026-09-19）

## 与用户身份旁听的区别

本次在 PR #97 的原有用户旁听基础上，增加独立的应用机器人路径。入口仍在 OA 同一聊天窗口的“会议模式”；原用户旁听保留为备选，不冒充独立机器人。

- OA 管理员明确输入会议号或链接并确认告知后，服务端以应用身份调用 `POST /open-apis/vc/v1/bots/join`，请求体为 `join_type: 1`、`join_identify.meeting_no` 及可选密码。不调用发起会议或结束会议接口。
- 入会请求已接受不等于已验证出现在会议内。保存匹配的会议长 ID 后，另由“核验入会并开始／继续采集”实际读取事件，同时由主持人核对飞书参会人列表及等候室。
- 退出按钮仅调用 `POST /open-apis/vc/v1/bots/leave`，不结束整场会议。不会因生成纪要、关闭面板或关闭浏览器自动退出。
- 不自动接听飞书客户端“呼叫”或邀请事件，没有发声能力；本次未实现 `vc.bot.meeting_invited_v1` 回调。

## 官方依据与权限

已核对官方 `larksuite/cli` 固定提交 `32d198896816e9416711468c20b14df3dbbc63f3`：

- `shortcuts/vc/vc_meeting_join.go`：应用身份、请求体、9 位会议号。
- `shortcuts/vc/vc_meeting_leave.go`：应用身份、长 meeting_id、离会接口。
- `shortcuts/vc/vc_meeting_events.go` 与 `shortcuts/vc/helpers.go`：应用身份事件读取推荐权限为 `vc:meeting.bot.join:write`，不是用户旁听使用的 `vc:meeting.meetingevent:read`。
- `skills/lark-meeting/scenes/live-meeting-attend.md`：应用发布、安装、权限数据范围、可见副作用与状态判定。

来源仓库：https://github.com/larksuite/cli/tree/32d198896816e9416711468c20b14df3dbbc63f3/shortcuts/vc

飞书管理员需确认：应用已经启用机器人能力，申请并发布 **应用身份权限 `vc:meeting.bot.join:write`**，安装到对应租户；“权限可访问的数据范围”按官方要求设置“按条件筛选 → 会议的归属者 包含 与应用的可用范围一致”。账号/应用需取得飞书要求的开放资格；会议须进行中，允许智能体加入，密码正确，必要时主持人放行等候室。

不能从 OA 的配置检查推断灰度资格或应用权限已通过。`GET /api/lab-ai/meeting-bot` 不调用飞书并始终返回 `permissionsVerified: false`。

## 运行配置：不改变登录方式

独立入会默认关闭。新的机器人路径不依赖 `FEISHU_LOGIN_ENABLED`，不会开启飞书登录，也不需要用户 OAuth、用户旁听回调或 `OA_MEETING_TOKEN_KEY`。

目标 Worker 需要：

```
OA_MEETING_BOT_ENABLED=true
OA_PUBLIC_ORIGIN=<目标 OA 的 HTTPS origin，无路径>
```

凭据择一使用完整配置：

1. 完整复用已经安全配置的 `FEISHU_LOGIN_APP_ID`、`FEISHU_LOGIN_APP_SECRET`、`FEISHU_LOGIN_TENANT_KEY`；不会改变登录开关。
2. 专用应用：完整配置 `OA_MEETING_BOT_APP_ID`、`OA_MEETING_BOT_APP_SECRET`、`OA_MEETING_BOT_TENANT_KEY`。

出现任一专用配置项时必须三项齐全，不混用两组凭据。密钥只能进入目标 Worker 的安全配置；不得贴到聊天、仓库、日志或前端。

## 控制记录表与安全

授权部署时，先核对目标 Worker、D1 UUID、hostname，备份后在正确数据库执行 `scripts/sql/oa-meeting-bot-sessions.sql`。SQL 是可重复的增量建表/建索引，不删旧表、不迁移历史数据、不自动在请求中执行。没有修改发布工作流，也没有执行生产 SQL。

入会控制表只记录操作者绑定、会议号/长 ID、时间与操作状态；不保存 token、应用密钥、密码或字幕原文。状态机和部分唯一索引阻止同一应用对同一会议并发重复入会。请求丢响应时保留 `joining`/`join_unknown`，不能靠重新点按钮或换请求号绕过；需要主持人在飞书核对、移出助手，并由授权运维核对后处置记录。没有后台自动清锁，也没有客户端直改记录的接口。

只有完成 OA 准入和保密协议的管理员可使用；每次路由检查当前身份/成员修订，写入预约和退出 claim 使用现有 `taskActorGuard`，外部调用前再次检查准入。记录读取绑定应用、origin、租户和当前账号。迁移冻结期间禁止 POST；紧急退出需由主持人在飞书移出助手。网络错误、非 JSON、超大响应、字段不合约均不会伪装成功；只返回脱敏错误码和安全格式日志编号。

## 纪要边界

机器人独立留在会议与持续采集是两回事：当前事件采集仍在 OA 前台轮询。页面进入后台时暂停；切换面板不丢当前组件状态，但关闭/刷新会丢失未保存原文。控制记录可跨页面恢复，不代表字幕原文已存档，也不保证补齐断线期间内容。本版不是无人值守全会记录服务。

正常采集后可导出原文，或明确点击生成纪要；使用现有字幕修订去重、分页限额、分段任务、编辑、下载及 OA 审核链路。没有正文时不调用模型，分段明确标注仅覆盖已采集片段，不自动入库或公开。材料内指令不作为系统指令执行。

## 验证记录与真实验收

本地 `node --test tests/feishu-meeting-bot.test.mjs`：**40/40 通过**。使用真实内存 SQLite 验证建表、并发防重、控制记录恢复、权限、结果未知锁定、离会幂等和字段隔离；飞书请求采用确定性测试替身，未真实调用飞书或付费模型。

新路由和两个 TSX 已通过 TypeScript 语法转译检查；这不是全项目 typecheck。完整 typecheck/lint/build/全量测试以最新 PR SHA 的 GitHub Actions 结果为准。

上线前仍须完成：

1. 最新 SHA 完整 CI 通过；授权后才合并和发布到核准的目标。
2. 飞书权限/发布/安装/灰度/数据范围验证；目标 D1 控制表与 Worker 配置。
3. 管理员实际登录 OA，使用仍在进行的测试会议，明确告知后入会；主持人确认独立机器人出现，而非“未接听”。
4. 实际说出一段可辨识测试内容，核对 OA 字幕、时间、说话人以及修订去重；多页和断网后不冒充全会。
5. 生成真实纪要、编辑、下载、提交 OA 并由管理员审核；确认未经审批不会入库。
6. 明确点击退出，核对参会人列表已移除；验证手机后台/刷新、等候室、权限拒绝、会后恢复等边界。

本次没有生产配置修改、数据库迁移、密钥读取、真实入会、真实模型调用或真实审批验收。不应把代码提交或离线测试视为已上线、已入会。

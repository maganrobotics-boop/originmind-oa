# 飞书应用机器人独立入会：首个控制入口

## 本次交付与边界

入口 `/admin/meeting-bot`，在成员会议纪要页顶部也有链接。仅完成 OA 准入、有效 NDA 的现任管理员可用，每次请求及令牌请求后复查准入。非管理员和匿名请求不会触发飞书 API。

- 检查服务器缺失配置；检查应用凭据（明确不是权限验证）。
- 明确确认后，用应用身份主动加入指定正在进行的会议；不会自行发起会议。
- 保存飞书返回的长数字会议 ID，管理员可让同一应用机器人退出。关闭入会功能开关不关闭退出接口。
- 真实接口成功与参会列表人工验收分开，不显示假“已入会”。网络结果不明时不自动重试，提示主持人核对或移出机器人。

这不是 PR #97 的个人授权旁听。本 PR 不依赖、未合并 PR #97，也不改变原个人旁听分支。

本次不含：飞书呼叫自动接听、`vc.bot.meeting_invited_v1` 事件回调、字幕采集、无人值守转写、自动会议纪要、语音发言。页面直说这些边界。后续不能把本入口上线等同于完整会议助手完成。

## 应用接口核对

以 2026-09-19 读取到的飞书官方 CLI 实现为依据：

- `https://github.com/larksuite/cli/blob/32d198896816e9416711468c20b14df3dbbc63f3/shortcuts/vc/vc_meeting_join.go`
- `https://github.com/larksuite/cli/blob/32d198896816e9416711468c20b14df3dbbc63f3/shortcuts/vc/vc_meeting_leave.go`
- `https://github.com/larksuite/cli/blob/32d198896816e9416711468c20b14df3dbbc63f3/skills/lark-meeting/references/lark-vc-agent-meeting-join.md`

入会：`POST /open-apis/vc/v1/bots/join`，`{"join_type":1,"join_identify":{"meeting_no":"九位会议号"}}`，可选密码。普通入会不传 `action`，主动入会不捏造 `call_id`。
退出：`POST /open-apis/vc/v1/bots/leave`，`{"meeting_id":"入会返回的长数字ID"}`。ID 全程使用字符串。
仅服务端向固定 `open.feishu.cn` 请求 tenant_access_token。没有用户 OAuth、任意 API 代理或应用后台管理能力。

## 必须完成的外部条件（尚未验收）

1. 飞书自建应用开启机器人能力；应用身份权限 `vc:meeting.bot.join:write` 已申请、审批、发布并安装。核实该权限的数据可访问范围覆盖目标会议归属者，不无理由扩大到其他组织。
2. 目标会议已经开始，允许智能体加入，密码正确，必要时主持人放行等候室。错误 `121003` 不简单等同于缺少 scope。灰度限制以实际错误和飞书确认结果为准。
3. 正确 OA Worker 中设置 `OA_PUBLIC_ORIGIN`（HTTPS）、`FEISHU_LOGIN_APP_ID`、`FEISHU_LOGIN_APP_SECRET`、`FEISHU_LOGIN_TENANT_KEY`。复用已有自建应用，不要求开启个人飞书登录。
4. 审核并发布代码后，再显式配置 `OA_MEETING_BOT_ENABLED=true`。默认不启用，不改当前生产 secrets、不改计费、不做数据库迁移、不部署公共 Chat。部署后用页面 GET 复核开关与配置是否保留。

本轮没有已登录飞书开放平台的后台管理工具，不能替用户批准权限、确认灰度或发布飞书应用。不要在聊天或仓库提交 App Secret。

## 安全与恢复

- Same-origin POST、严格字段/大小校验、有效管理员/NDA、独立控制与退出限流。
- 不回显上游原文、密码、应用密钥、tenant token；仅返回有限错误码和安全日志号。
- GET 只读配置，不执行真实入会；检查连接仅验证凭据，不声称 scope 已开通。
- 不把字幕、录音或纪要发给模型，本次控制入口不调用百炼，不写知识库或公开 Chat。
- 记录只存在本浏览器标签页 sessionStorage，不是服务器参会会话账本。先保存请求意图，避免刷新后误重试；实际成功后保存长数字 ID。关闭 OA 页面不等于退出，用户需点击退出或由主持人移出机器人。
- 记录丢失或返回 ID 不完整时，使用飞书参会人列表移出应用机器人。回滚时先确保机器人离会，再关闭入会开关/回滚代码。

## 验证

本地 `node --test tests/feishu-meeting-bot.test.mjs`：51/51 通过。覆盖应用请求契约、ID 精度、密码脱敏、未知操作结果、scope/灰度诊断、CSRF、默认关闭、限流、准入中途撤销及路由匿名/非管理员/NDA 拒绝。

本地只有相关文件和全局 TypeScript，不冒充完整仓库类型/构建验证。完整 typecheck/lint/build/全量测试以 PR CI 为准。飞书真实凭据、权限、入会、退出以及手机页面尚未人工验收。

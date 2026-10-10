# OriginMind 微信客服接入

把 `chat.omindos.cn` 的公开 AI 助教接入普通微信的“微信客服”会话。用户通过微信客服链接或二维码打开会话后，可以发消息并收到助教回复。它使用现有公开课程模型；内部 OA、审批和资料权限不在这个服务中。

**当前状态：代码与本地测试准备完成；尚未完成微信后台配置、真实微信收发验收。** 部署成功或健康接口正常，不代表微信消息已打通。

## 独立运行方式

- Node.js 22.13 或更高版本，使用内置 SQLite，零 npm 依赖。
- 独立版本目录：`/opt/originmind-wechat-kf/releases/<version>`；`current` 链接指向当前版本。
- 独立 systemd 服务：`originmind-wechat-kf`，仅监听 `127.0.0.1:3014`。
- 回调 URL：`https://chat.omindos.cn/integrations/wechat-kf/callback`。
- 私密配置：`/etc/originmind-wechat-kf/env`，权限 `0600`，目录 `0700`。systemd 读取后交给服务，不需要把私密文件改成公开可读。
- SQLite 状态：`/var/lib/originmind-wechat-kf/state.sqlite`。保存回调拉取令牌、游标、有限会话历史、消息去重及处理状态；需按内部数据管理要求备份和清理。
- 固定模型接口：`POST http://127.0.0.1:3001/api/chat`，`Origin: https://chat.omindos.cn`、`topic: student`；不携带 Cookie、OA 密钥或其他内部认证。

不修改现有 Chat/OA 的部署版本或数据。Nginx 只需为这个精确回调路径配置到 `127.0.0.1:3014` 的代理。该路径应关闭访问日志，避免记录回调 URL 中的加密参数。

## 必须先完成的微信配置

1. 在对应企业的企业微信管理后台启用“微信客服”，创建一个用于 AI 助教的客服账号。
2. 获取该企业的 **CorpID**、该客服账号的 **OpenKfID**。
3. 配置允许调用微信客服 API 的自建应用，并按后台要求授权及配置可信 IP；取得该应用的 **Secret**。不要把企业微信智能机器人 Secret、其他自建应用 Secret 或 OA 内部桥接密钥直接当成微信客服 API 凭据。
4. 在微信客服的 API 接收事件配置中填写回调 URL、Token、EncodingAESKey。Token/AESKey 由下面的本机配置工具生成，需与服务器一致。
5. 将指定客服账号配置为本服务接待的账号，确认其接待状态允许机器人回复，再在真实普通微信中进行收发验收。

详细权限入口以当前企业微信后台为准。Secret 必须具备微信客服所需 API 权限；只填一串 Secret 不会自动建立权限。域名、企业身份、可信 IP 等校验也需由该企业管理员完成。

## 本机配置命令

先准备配置；此命令只写私密文件，不显示 Token、AESKey 或 Secret：

```sh
sudo python3 /opt/originmind-wechat-kf/current/scripts/configure-wechat-kf.py --prepare
```

企业管理员在自己连接的服务器终端中输入企业 ID、获授权的应用 Secret、客服账号 ID。Secret 不回显；直接回车保留已有值：

```sh
sudo python3 /opt/originmind-wechat-kf/current/scripts/configure-wechat-kf.py --configure
```

只有人工交互终端允许显示回调设置；请直接填入企业微信后台，不要将输出截图或粘贴到聊天、日志、工单：

```sh
sudo python3 /opt/originmind-wechat-kf/current/scripts/configure-wechat-kf.py --show-callback
```

保存配置后重启独立服务：

```sh
sudo systemctl restart originmind-wechat-kf
sudo systemctl is-active originmind-wechat-kf
curl --fail http://127.0.0.1:3014/health
```

`/health` 仅返回布尔状态，不显示密钥或用户标识。仅有 Token/AESKey 时 `configured=false`，服务可以保持运行；缺 CorpID 时回调返回 `503`。有 CorpID/Token/AESKey 即可验证 GET 回调；缺 API Secret/OpenKfID 时 POST 暂不可用。

systemd 单元见 `deploy/originmind-wechat-kf.service`。当前单元使用服务器已确认的 `/usr/local/bin/node`；部署到其他主机前核对实际 Node.js 路径。`DynamicUser` 与 `StateDirectory` 由 systemd 管理服务身份和状态目录。

## 消息处理边界

回调先验签、解密、校验接收企业与客服账号，再把拉取令牌持久保存，随即返回 `success`。回调请求不等待模型回答。后台单独拉取消息并处理，游标及消息状态保存在 SQLite 中，进程重启后可继续；重复消息不会被当成新问题处理。

只处理指定客服账号中允许机器人接待状态的文本问题。模型调用有 90 秒超时、请求及响应字节限制，历史最多保留传给模型的最近 6 条。模型 JSON 必须来自 `provider: bailian` 的已确认回答；SSE 必须收到完整 `type: final` 的 `data`，出现错误、只有草稿或流中断时只发简短失败提示，不把未确认草稿发给微信用户。

微信客服的发送窗口、接待状态和消息配额以腾讯当前规则为准，后台 API 拒绝时不得绕过限制。服务不声称具备内部审批或执行工具的能力。

## 验证

```sh
node --test tests/*.test.mjs
```

测试覆盖签名及 AES 回调解密、持久入队后应答、无配置与超限请求、去重及处理状态、模型接口无 OA 凭据、SSE 出错不发草稿。真实微信验收还需检查：后台回调校验成功、普通微信发送文本收到最终回答、重复回调不重复回复、人工接待状态不抢答、独立服务重启后恢复，以及 API 权限与可信 IP 生效。

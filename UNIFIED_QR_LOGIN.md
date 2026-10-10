# OA 统一扫码登录

电脑显示一个 OA 地址二维码。飞书或企业微信扫码后，在各自平台验证身份，再核对电脑验证码并在手机确认。只有发起请求的电脑浏览器能领取 OA 会话；二维码本身不包含会话凭证。二维码有效期为 5 分钟。

企业微信首次使用需要先通过已有方式登录 OA，在「我的 → 绑定企业微信」关联本人身份。手机确认页同时显示企微身份、目标 OA 成员姓名及脱敏账号提示，确认两者均属于本人后再绑定。之后飞书和企微都进入同一成员账号，沿用原来的资料、申请、权限和 NDA 状态。不会按姓名或邮箱自动合并账号，不会为未绑定企微身份创建成员。

## 管理员配置

### 飞书

在当前 OA 飞书应用的 OAuth 重定向 URL 中新增：

```
https://oa.omindos.cn/api/auth/qr/callback/feishu
```

保留现有 `/api/auth/feishu/callback`，供「在本机打开飞书登录」备用入口使用。沿用已有 `FEISHU_LOGIN_*` 配置。应用必须允许目标企业成员授权；新流程严格要求返回的 tenant_key 与已配置企业一致。

### 企业微信

使用本企业的自建 OA 应用，并配置该应用的网页授权可信域名 `oa.omindos.cn`、需要的域名校验文件、可信 API IP 和成员可见范围。以下 Secret 必须属于该 AgentID 对应的应用；不要使用通讯录同步 Secret。服务端验证需要使用同一个应用 token 调用成员身份及读取成员接口，接口拒绝或成员非激活状态都会拒绝登录。

在服务器受保护的环境文件配置，实际凭证不应写入仓库或聊天：

```dotenv
OA_PUBLIC_ORIGIN=https://oa.omindos.cn
WECOM_LOGIN_ENABLED=true
WECOM_LOGIN_CORP_ID=<本企业 CorpID>
WECOM_LOGIN_AGENT_ID=<OA 应用 AgentID>
WECOM_LOGIN_APP_SECRET=<同一 OA 应用 Secret>
OA_UNIFIED_QR_LOGIN_ENABLED=true
```

企微授权回调由服务端固定生成：

```
https://oa.omindos.cn/api/auth/qr/callback/wecom
```

企微配置缺失时，页面只提示当前可用的平台。该功能不接入审批消息或待办推送，不改变业务数据接口。

## 2026-10-10 接续与发布

- 用户已完成企微自建应用。生产 OA 已核对为 `oa-library-5ee312888763`，对应 `maganrobotics-boop/aliyun-oa`；运行进程内尚无 `WECOM_LOGIN_*` 配置。
- `omindos.cn` 与 `oa.omindos.cn` 的 `WW_verify_TrIXNK3EoirCVbIT.txt` 均返回 200、text/plain、16 字节，内容 SHA-256 相同。网页验证文件可用不等于后台可信域名已经保存。
- 原 PR #115 已与 main `b386451` 对齐；企微机器人占用 0035，统一扫码迁移改为 **0036_unified_qr_login.sql**，保留机器人三表、索引和迁移账本。
- 阿里云候选基于 main `11272f6` 局部集成登录代码，保留七天会话、资料库生成/上传、周报、审批和现有工作台。旧 `oa-8a0bffc` 页面补丁已移除，不能套用到当前生产。
- 当前云浏览器的站点安全策略禁止访问企微管理后台，不能代替用户核验应用可见范围、可信域名和可信 API IP。未请求或回显真实 Secret。

管理员在阿里云服务器终端运行：

```sh
sudo python3 scripts/configure-wecom-login.py
```

按提示输入 CorpID、AgentID 和**同一自建应用** Secret。Secret 隐藏输入；脚本只新建 root 可读的 `/etc/originmind-oa/wecom-login.env`（0600），保留 `OA_UNIFIED_QR_LOGIN_ENABLED=false`，不改已有飞书配置、不重启、不启用服务，已有文件时拒绝覆盖。

发布前继续完成：

1. 核对企微网页授权可信域名是 `oa.omindos.cn`，应用可见范围包含待登录成员，可信 API IP 对应 OA 服务器的实际出口 IP。飞书新回调保留 `https://oa.omindos.cn/api/auth/qr/callback/feishu`，旧回调也保留。
2. 在受保护服务器内验证应用凭据，不将 Secret、access_token、真实成员信息或上游原始错误写入日志/仓库。
3. 用飞书和企微手机客户端分别验证授权跳转后 `__Host-oa_qr_phone` 保留、验证码确认、首次绑定、退出后重新登录。自动化隔离测试不代替此步骤。
4. 再按阿里云流程备份 SQLite，应用 0036，验证两张临时认证表和四个索引以及既有迁移记录，挂载配置、切换已构建候选并验收。切换前重新比较生产版本，不能覆盖并行发布的新功能。
5. 回退时恢复上一代码包并关闭 `OA_UNIFIED_QR_LOGIN_ENABLED`；新增临时表可保留。原飞书本机登录入口保持可用。

**本轮未合并、未切换生产、未迁移生产数据库。当前缺失的是服务器凭据和真实手机 OAuth 验收。**

## 验证

```sh
npm run typecheck
node --test --test-concurrency=1 tests/unified-qr-login.test.mjs tests/wecom-oauth.test.mjs tests/qr-svg.test.mjs
npm test
```

上面的命令用于当前 GitHub PR 源码的完整检查。阿里云生产源码副本保留独立的 `build:aliyun` 命令，应用核对过的生产页面补丁后另行执行 `npm run build:aliyun`。旧 Cloudflare 发布工作流和 npm 发布入口已退役；本次只更新保留代码的迁移校验，不恢复该发布入口，不以其替代阿里云发布。

安全用例涵盖电脑和手机 nonce、OAuth state、平台与企业限制、重复消费、并发扫码、事务回滚、成员停用与绑定冲突。二维码由仓库内固定版本的 MIT 编码器生成，不发送到第三方二维码服务。

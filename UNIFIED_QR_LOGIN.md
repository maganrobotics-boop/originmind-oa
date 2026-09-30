# OA 统一扫码登录

电脑显示一个 OA 地址二维码。飞书或企业微信扫码后，在各自平台验证身份，再核对电脑验证码并在手机确认。只有发起请求的电脑浏览器能领取 OA 会话；二维码本身不包含会话凭证。二维码有效期为 5 分钟。

企业微信首次使用需要先通过已有方式登录 OA，在「我的 → 绑定企业微信」关联本人身份。之后飞书和企微都进入同一成员账号，沿用原来的资料、申请、权限和 NDA 状态。不会按姓名或邮箱自动合并账号，不会为未绑定企微身份创建成员。

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

## 发布与回退

1. 先完成两平台应用配置并取得域名校验文件。在测试环境用各自手机客户端验证授权、Cookie 保留、手机号端确认、绑定和退出后重新登录。
2. 使用现有发布流程备份 SQLite 数据库，应用新增迁移 `0035_unified_qr_login.sql`，再切换经过验证的代码包。迁移只新增两张临时认证表，不修改成员、业务记录或角色。不要跳过原有迁移账本校验。
3. 当前生产代码是 `8a0bffc8b1e1`，仓库 main 是 `e70c9118fe77`，二者主页面存在既有差异。PR 只在 main 主页面添加登录修改；生产发布应在生产源码副本导入其余认证文件，再用 `git apply --check deployment-patches/oa-8a0bffc-unified-qr-login.patch` 核对页面补丁，检查通过后应用并构建。不要直接覆盖整个 main 页面。补丁已验证能精确重现经过构建检查的生产页面版本。
4. 设置 `OA_UNIFIED_QR_LOGIN_ENABLED=false` 可关闭新的扫码请求；保留的飞书本机登录入口仍可使用。恢复上一个代码包时，可以保留新增的临时认证表。

尚未对生产服务应用迁移、切换代码或修改环境配置。外部真实 OAuth 应用与手机扫码需要在配置完成后验收；自动化测试使用模拟平台响应和隔离 SQLite，不会请求真实凭证。

## 验证

```sh
npm run typecheck
node --test --test-concurrency=1 tests/unified-qr-login.test.mjs tests/wecom-oauth.test.mjs tests/qr-svg.test.mjs
npm run build:aliyun
```

安全用例涵盖电脑和手机 nonce、OAuth state、平台与企业限制、重复消费、并发扫码、事务回滚、成员停用与绑定冲突。二维码由仓库内固定版本的 MIT 编码器生成，不发送到第三方二维码服务。

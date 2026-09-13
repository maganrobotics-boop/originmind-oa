# 飞书、GitHub 登录与 Cloudflare 迁移流程

本文描述独立 Cloudflare Worker 的受控登录与迁移。独立版以飞书扫码为主入口，GitHub 位于“其他账户登录”；ChatGPT 登录只在支持 Sites 边缘认证的站点显示。

## 身份边界

飞书登录只接受配置的应用与企业 tenant key，并以 `App ID + tenant key + open_id` 生成稳定外部身份。系统不请求飞书邮箱，也不按姓名或邮箱自动合并成员。

已有成员要保留原成员 ID、权限、保密协议和审批历史，可以先从原 ChatGPT 或 GitHub 身份进入 OA，再在“个人设置”中显式绑定飞书。未绑定的飞书身份首次进入时，系统只做规范化姓名的精确候选查询：无匹配时直接建立有效企业成员；有匹配时由本人确认绑定哪一条旧记录，也可以明确选择“都不是我的”并建立独立成员。系统不会仅凭姓名静默合并。

新成员直接使用“灵感智能”飞书扫码登录，不再填写注册表、学号或认证身份。进入后仍须按当前角色完成保密文件，才能访问其他业务流程。

## OAuth 配置

每个部署 origin 都要在应用后台登记精确回调：

- 飞书：`<origin>/api/auth/feishu/callback`
- GitHub：`<origin>/api/auth/github/callback`

飞书应用发布版本后，组织内成员才能使用已配置的网页扫码登录。自动 PDF 云空间归档还需要为应用加入租户权限 `drive:drive`、`drive:file:upload`、`docs:permission.member:create` 和 `docs:permission.member:readonly`，并再次发布应用版本。Worker 普通变量保存 App ID、tenant key 和 GitHub Client ID；两个密钥必须保存为 Cloudflare Worker Secret：

- `FEISHU_LOGIN_APP_SECRET`
- `GITHUB_OAUTH_CLIENT_SECRET`

Staging 还需要 `OA_STAGING_CLOUDFLARE_ACCOUNT_ID`、`OA_STAGING_WORKER_NAME`、`OA_STAGING_D1_DATABASE_NAME`、`OA_STAGING_D1_DATABASE_ID`、`OA_STAGING_PUBLIC_ORIGIN`、`OA_ADMIN_EMAILS` 与 `OA_ADMIN_NAMES`。Worker 与数据库名称必须是专用目标，且以 `-staging` 结尾。

## 数据库迁移链

目标 D1 从空库顺序应用 `0000` 至 `0030`。身份和知识库相关迁移包括：

- `0019` 为可唯一归属的历史邮箱生成 `email:` 账户主体。
- `0021` 引入外部身份、OAuth 会话与一次性事务表。
- `0022` 把 OAuth 事务固定到 provider。
- `0023` 加入迁移写入冻结。
- `0024` 退役旧飞书登录、目录映射与飞书云盘归档，并保留历史审计。
- `0025` 仅恢复飞书 OAuth 登录、显式成员绑定及登录限流；飞书目录映射和云盘归档仍保持退役围栏。
- `0026` 加入实验室知识条目、不可变版本、可引用检索分块和追加式生命周期事件。
- `0027` 加入活动分块索引，并在数据库层强制知识版本不可变、生命周期合法流转和事件只追加。
- `0028` 为知识审批增加仅 OA 内部或对外公开的明确范围，历史条目默认保持内部。
- `0029` 允许负责人或管理员在不改变正文、版本和分块的情况下调整已入库知识范围，并追加不可修改的范围变更事件。
- `0030` 为大型知识文档加入不可变的正文分片存储，同时保持一个逻辑条目、一个版本和一次 OA 审核。

新的 PDF 归档使用 `feishu_drive_pdf` 目标，不复用被 `0024` 封存的旧 Markdown 归档目标，因此无需更改历史迁移或历史文件 token。

迁移包只搬运持久业务表。成员会话、OAuth 会话、OAuth 临时事务、限流桶和源站冻结标记不导入目标库。源库执行退役迁移前必须确认不存在 `feishu_drive` 的 pending 归档，也不存在活动迁移冻结。

## 隔离 staging 发布

先生成并检查：

```bash
npm run build:standalone:staging
npm run check:standalone:staging
```

受控发布入口：

```bash
OA_STAGING_RELEASE_CONFIRM="$OA_STAGING_WORKER_NAME" \
OA_STAGING_SECRETS_FILE=/absolute/private/path/staging-secrets.json \
npm run release:standalone:staging
```

Secret 文件必须位于 Git 工作树外，在 POSIX 上权限为 `0600`，并且只含：

```json
{
  "FEISHU_LOGIN_APP_SECRET": "replace-with-private-value",
  "GITHUB_OAUTH_CLIENT_SECRET": "replace-with-private-value"
}
```

发布脚本执行类型检查、lint、测试、standalone 构建、目标账户/D1/origin 校验、Secret 名称校验、Wrangler dry run、D1 migrations 和显式配置部署。不要直接运行裸 `wrangler deploy`。

## 迁移与验收

1. 对源库执行受控只读冻结并生成加密备份。已有绑定随数据保留；用户已决定不要求未绑定成员在迁移前绑定，迁移后仍须通过原有本人确认流程认领账户。
2. 对空 staging D1 应用完整迁移链，导入加密业务数据，再核对表行数、哈希、审批 revision 链、NDA 证据和引用关系。
3. 用已绑定的管理员飞书身份登录，检查成员准入、审批、详情、聊天、PDF 下载和飞书自动归档。
4. 验证未绑定的飞书账号在无同名候选时直接进入；有同名候选时必须由本人选择绑定或拒绝，未确认前不能读取候选账户数据。
5. 验证登录页以飞书扫码为主，ChatGPT 与 GitHub 只出现在“其他账户登录”中；standalone 不显示不可用的 ChatGPT 按钮。
6. 验证飞书授权在顶层页面发起，OAuth state、nonce 和 PKCE 只能消费一次，并限制到“灵感智能”tenant。
7. 归档一份四种业务类型中的测试记录，确认 PDF 可下载，飞书目录为 `OriginMind OA 归档 / YYYY年 / MM月 / 业务类型`，配置的 OA 管理员拥有根目录管理权限，重复加载详情不会重复上传。

生产切换必须使用新鲜空库、重新计算 fingerprint、重新生成短时迁移窗口和加密包，并获得明确生产发布授权。至少一位已配置管理员必须能通过已迁移的飞书或 GitHub 身份重新进入；未绑定成员不得由维护人员代认领，也不能临时放宽自动合并规则。

生产导入入口为 `npm run migration:import:production`，并要求显式设置以 `-production` 结尾的 `OA_PRODUCTION_WORKER_NAME` 与 `OA_PRODUCTION_D1_DATABASE_NAME`。目标只允许 `.wrangler/generated/wrangler.production.json` 指定的独立空库。导入前核对账户、数据库 UUID、结构指纹和管理员身份，记录 Time Travel 恢复点；导入后逐表比较完整哈希并验证审批与知识历史链。不同审批单或知识条目的历史可以在同一语句插入；同一条历史链的相邻版本必须按依赖顺序写入。导入计划必须保持在 D1 单次 Worker 调用的查询预算内，并让每个 JSON 绑定留在代码设定的大小上限内。

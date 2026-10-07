# 未来之星：近期活跃与全课程进度增量

本改动最初以 PR #120 的 `2929fe6921e1dfc54de4bb6338a874db545b6afe` 为基线。真实管理员只读验收完成后，#120 已于 2026-10-07 合并到 main（`13892d2`），#121 已 retarget 到新的 main，保留原导航、荣誉及发布记录。仓库基线收敛不代表将仓库整包覆盖阿里云生产源码；现网仍采用已有增量 release。

## 已有工作与本次增量

核对了两份 10 月 6 日保存的源代码包：`OmindOS-future-stars-activity-20261006.zip`、`OmindOS-arena-activity-20261006.zip`。它们的 README 记录课程、Arena 统计已经生产增量部署，但实现尚未进入 PR #120。本次复用其中的全课程进度、窗口卡片和 Arena 数据链，修正默认排序、异常统计、窗口切换和仓库兼容性，并增加可执行测试。

这些包记录的历史发布状态不等于本次重新验证或部署。当前会话只做了匿名线上读取：`https://chat.omindos.cn/arena/api/health` 返回 200，版本 `0.7.2-quick-practice`；`https://oa.omindos.cn/api/admin/future-stars?view=arena&window=24h` 返回 401。没有读取真实管理员统计，也没有切换生产 release。

## 课程统计口径

- 三个滚动窗口：24 小时、72 小时、168 小时。统一使用服务器 `asOf`，包含下边界和当前时刻；排除未来时间及缺失时间。界面以北京时间显示。
- 活跃人数按已登录学生规范化邮箱去重；使用已有登录、课程访问和保存的学习活动。账户资料编辑、注册时间、管理员读取不会制造学习活动；游客不计。历史未记录的访问无法补计。
- 选中窗口内默认按**全课程累计已提交节数降序，然后最近活动时间降序**排序；最后按邮箱稳定排序，再分页。可切换本期新增进展或最近活动。
- 使用现有课程目录覆盖全部课程，子任务映射至主课程，重复提交只计一节。免修与已提交分别展示，访问授权不算完成，提交不等于教师验收。
- 人数卡片与全课程新增摘要不受姓名、课程、进度状态筛选影响；筛选只改变列表。个人入口始终打开全部学习记录。
- 兼容旧仓库不存在 `newbie_questions` 的情况：只在该表已存在时读取，不在管理请求中建表或补造记录。`learning_presence` 在课程服务初始化时建立，认证访问按分钟节流记录。

## Arena 的真实数据链

| 用途 | 已核对的来源与边界 |
| --- | --- |
| 身份集合 | Chat `visitor_accounts` 与 `arena_public_accounts`，按小写邮箱合并；不从客户端接受 owner/email 覆盖 |
| 竞技场活动 | Chat `arena_account_activity.last_seen`，以及 `arena_policy_versions` / `arena_policy_attempts` 的已有活动时间 |
| 身份映射 | 复用 Arena proxy 的 `HMAC-SHA256(authKey, 'campus:' + email)`，密钥不出服务端 |
| 个人历史 | proxy 的 `privateActivity(owner, {action:'list', offset})`，内部签名 POST `/arena/api/my-activity`；这里只读取 list，不调用 source、评测、取消或删除 |
| 原始结果 | 腾讯裁判 `personal_activity.py` 中 `runs WHERE player=? ORDER BY created DESC,id DESC`；每页 20 条，附属 jobs 只显示进行中提示 |
| 正式成绩 | `runs.score` 暴露为 `rankTime`，正式挑战按裁判保存的平均用时；快速练习使用单次 `time`，地图/模式隔离 |

不调用公开排行榜替代个人历史，不把获奖登记当测试结果，不用课程登录人数填竞技场人数。读取所有已知账户的个人历史，避免漏掉有历史结果但无本地 presence 的账户；每次最多四路并发，总历史读取预算 12 秒，每账户最多 2,000 条。超时、分页截断、损坏结果、正式成绩缺字段均进入不完整状态。

Arena 测试次数明确为所选窗口、地图和模式内**已保存的结果数**；未完成结果计一次，排队任务不计。结果 ID 去重。先比较找齐并返回，再比较采集比例、返回情况与用时，不跨地图或模式排成绩。缺失 `rankTime` 时不退回首轮用时充当正式成绩。

| `source.status` | 页面行为 |
| --- | --- |
| `connected` | 数据读取完整，真实空集显示 0 与无记录 |
| `not_connected` | 环境未绑定 `FUTURE_STARS_ARENA.overview`，显示“数据源未接入”，计数为 null / — |
| `unavailable` | 身份索引、数据库或适配器不可用，显示暂不可用，不暴露内部异常 |
| `partial` | 部分历史读取失败或不完整，汇总为 null / —；保留已知活跃名单，失败账户不显示伪造的零分、最好成绩或部分测试数 |

没有 Arena 服务的仓库环境可以直接运行 UI；不会宣称已接入生产。获奖登记和荣誉墙继续使用原数据与写权限。

## 权限

沿用 OA 管理员准入校验；GET 使用只读授权、不写用户活动；Cookie/private no-store。OA→Chat 仍使用签名、有效期、一次性 nonce、参数白名单，拒绝重复查询参数、身份/URL 覆盖和未知窗口。Arena 是只读 operation，不能通过该入口触发评测或删除。原有荣誉写入保留同源校验。

## 应用到现有生产源码的副本

使用 `scripts/integrate-future-stars-activity.py`，无需重跑 PR #120 全套集成或迁移荣誉。

```bash
python3 scripts/integrate-future-stars-activity.py --oa-root /path/to/oa-candidate --chat-root /path/to/chat-candidate
python3 scripts/integrate-future-stars-activity.py --oa-root /path/to/oa-candidate --chat-root /path/to/chat-candidate --apply
```

第一条只预检。所有源码锚点检查完成后才写入候选文件；拒绝 current 符号链接和被替换文件的符号链接，重复应用无变化。保留生产 `lib/future-stars-client.ts` 的阿里云传输适配。找到已核对的 Arena proxy 边界才挂接只读 overview，并把取消信号传到原 transport；缺少该边界则保持“未接入”。已有绑定却代码不匹配时停止。

脚本不切换服务、不运行数据库迁移、不替换裁判或评分算法。候选构建、服务账户权限、数据库副本预检、真实管理员验收及发布/回退仍按现有阿里云流程进行。原 PR #120 的首次集成脚本也会安装此次新增依赖，避免新 bridge 引用缺失文件。

## 验证

- 34 项数据/API/桥接测试通过：三窗口边界、去重、未来时间、全课程/子课程、累计进度优先及时间次序、分页、筛选、无记录、匿名与非管理员拒绝、只读授权、签名与防重放、Arena 独立数据源、正式平均成绩、超时/未接入/读取不完整，以及历史纯文本和非 JSON 点评的个人记录兼容。
- 3 项 Python 集成测试通过：预检不写、接入与未接入、重复应用、源码变化时无部分写入；另在上述两份实际归档源码上执行预检/应用/重复应用及 JS 语法检查通过。
- 47 项已有回归通过：OA bridge、Chat Worker contract、只读授权和新手村游客流程。
- TypeScript、定向 ESLint、仓库生产构建通过。
- Chromium 浏览器检查覆盖 1280/390/320 px：默认排序、全记录入口、快速窗口切换的迟到响应、空数据、Arena 独立窗口、正式成绩、未接入/不完整状态、获奖入口和横向溢出；无页面运行错误。使用真实 React 组件与合成接口，不是生产管理员验收。

复现：

```bash
node --test tests/future-stars.test.mjs tests/future-stars-activity.test.mjs tests/future-stars-api.test.mjs tests/arena-admin.test.mjs
python3 tests/future-stars-integration.test.py
npm run typecheck
npm run build
# 需安装 Playwright 与 Chromium；可用 FUTURE_STARS_BROWSER_EXECUTABLE 指定已有浏览器
node scripts/check-future-stars-browser.mjs
```

## 生产部署记录：2026-10-07 06:27（北京时间）

用户明确授权部署后，通过阿里云现有发布目录完成增量上线。运行代码提交 `3bfbbb83518a6672ef3ef46c2b9641dc6b880eb7`，对应 PR #121；没有合并或重做 #120。

| 服务 | 新版本 | 回退版本 |
| --- | --- | --- |
| OA | `oa-stars-activity-20261007-v1` | `oa-pwa-safe-20261006-v2` |
| Chat | `chat-stars-activity-20261007-v1` | `chat-arena-activity-20261006-v1` |

均位于 `/opt/omindos-deploy/releases/`，由 `oa-current`、`chat-current` 链接选用。候选由当时线上实际版本复制，受保护源码校验覆盖 OA 1,123 个、Chat 1,205 个文件；保留既有 PWA、私有荣誉绑定和其他业务。未运行课程、荣誉或裁判数据迁移。

服务器维护目录 `/opt/omindos-deploy/maintenance/future-stars-activity-20261007/` 保存源码哈希、集成清单、构建日志、数据库副本预检结果、发布记录和上线核验；`backup/` 保存发布前 OA、Chat、learning 三份 SQLite 备份，权限仅维护账户可读。回退时原子恢复上述两个 current 链接，依次重启 `originmind-chat` 和 `originmind-oa` 并核验健康；正常代码回退无需覆盖用户最新数据库。

上线前以服务账户在 3300/3301 端口启动候选，使用数据库副本，课程与 Arena 三窗口均通过。实际数据发现旧点评包含纯文本，因此补充兼容读取和回归测试后再次通过预检。阿里云实际 TypeScript 与 Next.js webpack 生产构建通过。

上线后使用既有服务签名进行只读核验，结果如下。数值为核验时快照，后续随活动和滚动窗口变化。

| 窗口 | 课程活跃人数 | Arena 活跃人数 | Arena 测试结果数 |
| --- | ---: | ---: | ---: |
| 24 小时 | 8 | 3 | 1 |
| 3 天 | 11 | 6 | 10 |
| 7 天 | 21 | 6 | 10 |

Arena 三次均为 `source.status=connected`；测试结果数对应默认地图 `originmind-quick-double-left-v1`、快速练习模式，不代表所有地图合计。课程目录包含 24 个记录入口、22 个去重父课程；检查了排序、去重、窗口边界、完整分页和个人全部记录入口。没有伪造用户活动或成绩。

OA/Chat 公网首页、OA manifest/service worker、Arena health 均为 200；两服务均 active。三个窗口的匿名 OA 管理请求为 401，未签名桥接为 401，跨站写请求为 403，私人荣誉匿名访问为 401；荣誉公开字段及既有绑定检查通过。此处是服务签名与匿名公网核验，未冒充真实管理员浏览器登录验收；组件浏览器回归仍为合成 API。

PR 的新增 Future Stars 专项检查在初始实现提交通过。Chat 通用 CI 曾在旧新手村浏览器检查的标题等待处失败，已对照 #120 相同失败位置，非此次引入；未移除或跳过该检查。


## 真实管理员只读验收：2026-10-07 17:08–17:13（北京时间）
2026-10-07 17:08–17:13（北京时间）补充真实管理员只读浏览器验收：用户通过飞书登录，页面显示管理员身份并能从主导航进入未来之星。课程 24h/3d/7d 活跃人数为 8/12/20，选中列表人数一致；默认累计已提交节数排序和本期新增进展排序正常，全部学习记录包含新手村、训练营提交与历史 AI 点评。Arena 活跃人数为 3/5/7；24h 暂无近期测试地图、结果为 0，3d/7d 默认环路快速练习均为 10 次结果、2 次完成；地图与模式隔离、最好成绩及返回状态正常。获奖登记入口及三条现有公开荣誉可见，未提交登记、绑定、隐藏或撤回等写操作。生产正常读取时无不完整状态提示；超时/部分历史/未接入未在生产人为触发，其准确状态与未知值处理由专项测试验证，不冒充现场异常验收。当前快照不替代早晨部署记录。

本次复跑 34 项 Future Stars 数据/API/桥接测试、3 项 Python 集成测试及 TypeScript 通过。组件浏览器复跑因本环境 Chromium 缺失、官方下载返回损坏文件未能完成；原合成浏览器结果保留且明确区分。无关 Chat 基线 CI 故障不纳入本次改动，不移除或跳过检查。当前生产包含 #121 和其他后续增量，本次 #120 合并仅收敛仓库基线，不以旧源码重新部署生产。

#120 已通过 merge commit `13892d2485b3cae06ccccf3c8fa2bbbbe5bbfb82` 收敛到 main，保留原提交祖先；#121 随后 retarget 到 main。此证据提交只追加文档，用于触发在新 base 上重新运行专项检查，不修改运行代码或生产 release。

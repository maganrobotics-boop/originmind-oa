# 新手村完整课程 V1 / V2 验收记录

日期：2026-09-25。所有新增示例和数据为教学构造；不代表学生已完成任务。

## 范围与课程入口

- 保留 Python 日志分析样板 `assets/newbie-python-v1`。
- 新增 `assets/newbie-course-v1/index.html` 汇总七关；六个子目录各含 README、独立网页、材料 ZIP、示例/模板、检查程序和提交单。
- 前端任务详情使用统一材料映射；所有课程免登录阅读下载。
- 本机进度、正式提交、教师验收保持分离；本次不改变身份、协议或后端权限。

| 关卡 | 独立任务 | 验收证据 |
| --- | --- | --- |
| 登记 | 8 小时计划缩减为 4 小时 | 两版计划、时间核对、取舍解释 |
| 装备 | 修改问候程序并修复一次错误 | 代码、预测/实际输出、环境报告 |
| Git | 三次内容提交、分支合并和自主改进 | README、图形历史、差异与复盘 |
| Python | 完成日志计算并分析变化数据 | 个人自检、指标、异常定位 |
| ROS2 | turtlesim 整圆、半速圆和反向实验 | 真实 pose、节点话题、截图和对照 |
| 小项目 | 四邻域 BFS、绕行与无解 | 代码、地图、六项自检、项目卡 |
| 出村 | 清单整理、检查、打包和演示 | 六关证据、缺失恢复实验、下一步计划 |

## 已完成的自动检查

```sh
python3 chat-cloudflare/scripts/build-newbie-lessons.py
PYTHONDONTWRITEBYTECODE=1 python3 chat-cloudflare/scripts/check-newbie-lessons.py
node --check chat-cloudflare/public/newbie-village.js
node --test chat-cloudflare/test/newbie-guest.test.mjs chat-cloudflare/test/static-router.test.mjs
git diff --check
```

七组课程检查通过：材料包与源文件一致、HTML 内部链接有效、计划时长错误被拒绝、修改后的 hello 输出正确、实际 Git 示例历史完整且脏工作区被拒绝、ROS 几何预检原圆/半速/反向通过、路线规划六项参考自检通过且未完成模板失败、证据包解压后可重新检查且缺失文件/越界路径被拒绝。

前端及静态路由 19 项通过，包括七关材料实际存在、免登录入口、已有进度保留以及服务失败不伪装提交成功。

## V2：按关卡提问与真实 ROS2 验证

- 七关教程和材料发布到 `newbie-course-v2` / `newbie-python-v2`，保留 V1 文件以兼容旧链接。
- 每关“问本关助教”生成可编辑草稿，包含本关目标、步骤、验收及提交要求。问题由用户确认发送；不自动附带个人资料、进度或证据。
- 已有聊天保留在历史中；课程入口新建草稿，修复有历史时忽略预填问题的问题。
- 前端构建从任务地图提取同一份公开课程数据，避免助教标准与课程漂移。
- 新助教入口、免登录与静态路由合计 24 项通过；七组课程材料和 CLI 流程检查通过。
- ROS2 在隔离的 Ubuntu 24.04 / Jazzy 容器中实际运行 turtlesim，通过真实 cmd_vel / pose 话题验证；未在生产服务器安装 ROS。
- 实测记录：[GitHub Actions 36145857455](https://github.com/maganrobotics-boop/originmind-oa/actions/runs/36145857455)，测试提交 `9429f922ccaeab6ccf7f2f3faa4a9c1289b14c4c`。rclpy 7.1.11，turtlesim 1.8.4；镜像摘要 `sha256:2f520187e84304fffb60d19c9a7d8e2e79d563a6e579a090427e5994eb1b8c45`。

| 实测 | pose 样本 | 记录时长 s | 累计路程 | 起终点误差 | 外接框 宽×高 |
| --- | ---: | ---: | ---: | ---: | --- |
| 标准圆 | 429 | 6.848 | 6.304 | 0.021 | 2.000×2.000 |
| 半速圆 | 429 | 6.849 | 3.144 | 0.002 | 1.000×1.000 |
| 反向圆 | 429 | 6.848 | 6.288 | 0.005 | 2.000×2.000 |

记录时长含停止缓冲；首次运行的命令行发现过早返回空列表，已改成 `--no-daemon --spin-time 3` 并将相同用法补入教程。三组均通过原有几何指标检查；CI 使用无窗口模式，学生仍须提交本人实验及界面证据。

## 发布检查

V1 已在阿里云完成 64 个文件 HTTP 内容校验。V2 静态发布 10df07c 已于 2026-09-25 14:19 UTC 完成：66 个文件、七份 ZIP、根聊天入口均通过 HTTP 内容校验，OA/Chat 均 active，受保护 dashboard 返回 401。执行记录 t-sz06y519xy4kge8。浏览器自动升级 HTTPS 而服务器尚为 HTTP 时，以服务端 HTTP 内容校验为准，不宣称已完成浏览器视觉验收。

## 后续修改

静态 `/assets/` 路径有长期缓存。首次部署之后若再次改教材，使用新版本目录；重新生成 ZIP，并检查任务材料映射。README 为六关教程的源文件，index.html 和 lesson.zip 由构建脚本生成。

## 线上助教联调与后端修复

最初真实请求返回通用新手村介绍：后端只要检索到 static:ta 就短路返回固定回复。7b63938 修复为从公开课程数据选择本关参考文档，课程提问与追问不再被该固定回复截断。前后端使用同一份生成的课程定义，学生提交的内容不会写成可信教材事实。

- 新助教前后端与 worker-contract 合计 45 项通过，包含首次提问、连续追问、模型实际调用、公开教材依据、伪造内容隔离、来源限制和预算/认证回归。
- 2026-09-25 14:36 UTC，阿里云执行 t-sz06y52szomj9q8 退出 0；仅对当前后端应用两处经过唯一匹配检查的修改并安装课程模块，重启 Chat。
- 线上从已发布 JS 中提取课程上下文，按网页同源请求格式调用公开 Chat，返回 HTTP 200、mode=ai、provider=bailian。
- 实际回答：“本关正常日志的累计路程标准值为 10 m，验收允许误差不超过 0.001 m。”
- modelReady / qwenReady / systemReady 均 true；originmind-chat / originmind-oa 均 active。
- 后端备份：/opt/originmind-oa/backups/tutor-backend-20260925T143621Z；静态入口备份：/opt/originmind-oa/backups/tutor-20260925T141913Z。
- 重启后首个健康检查遇到短暂 502，自动重试成功，随后上述模型请求成功；未触发回滚。

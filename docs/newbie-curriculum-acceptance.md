# 新手村完整课程 V1 验收记录

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

## 尚未完成的验收

- 此执行环境没有 ROS2 Jazzy 与图形 turtlesim；run_ros.py 已做语法检查，尚未在真实 ROS2 环境进行端到端运行。纯公式 CSV 不作为 ROS2 联调通过凭据。
- 阿里云服务器上线状态需在实际部署后核对，GitHub main 提交不等于服务器已经更新。

## 后续修改

静态 `/assets/` 路径有长期缓存。首次部署之后若再次改教材，使用新版本目录；重新生成 ZIP，并检查任务材料映射。README 为六关教程的源文件，index.html 和 lesson.zip 由构建脚本生成。

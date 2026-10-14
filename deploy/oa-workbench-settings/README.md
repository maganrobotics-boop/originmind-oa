# OA 工作台管理设置入口

已在阿里云 OA 工作台的“待我处理”右侧加入模型设置、实时字幕、会议设置和系统管理四个入口，仅系统管理员显示。模型与字幕入口分别定位到现有 /admin 配置区，登录验证完成后会滚动到对应区域。手机窄屏通过响应式样式换行。

现网源代码与 main 有独立差异。本次保留现网的所有功能，以 manifest.json 中的三项 SHA256 为基线，仅应用 production.patch 并新增 components/oa-workbench-settings.tsx 与 components/oa-workbench-settings.css；不能用 main 全量覆盖现网。production.patch 已在原快照上通过 git apply --check。

验证：Next 生产构建、完整 TypeScript 检查、4 项 OA 管理桥回归通过。组件渲染确认管理员显示 4 个入口、普通成员显示 0 个；3 个配置定位目标存在。已作为实际 OA 服务用户完成 218 项静态资源可读性检查。部署后 /、/admin、/admin/meeting-bot 返回 200，匿名管理接口返回 401。线上首页与管理页 HTTPS 均返回 200。未改变数据库、账号权限、API Key 或服务配置。

版本：oa-workbench-settings-20261014-v1。回退点：oa-subtitle-admin-20261014-v1。此前静态资源继续保留，供旧页面加载。

浏览器视觉检查尚未完成；云浏览器访问返回 502 / Connection refused，不能据此宣称已完成桌面或手机实机验收。

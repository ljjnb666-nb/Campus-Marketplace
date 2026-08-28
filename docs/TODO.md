# 开发计划

## Phase 1

- [x] 初始化 Next.js + Tailwind + Prisma
- [x] 使用 Docker Compose 配置本地 PostgreSQL
- [x] 设计 Prisma Schema
- [x] 接入 Auth.js 凭证登录
- [x] 创建首页、登录、注册和基础列表页
- [x] 建立 PRD / 架构 / 数据库 / API / 安全文档

## Phase 2

- [x] 商品详情、发布、编辑、上下架
- [x] 商品收藏
- [x] 跑腿接单流转
- [x] 技能服务详情、发布、编辑、上下架
- [x] 用户中心与校园认证页

## Phase 3

- [x] 订单流转与评价
- [x] 会话列表与站内消息
- [x] 举报系统
- [x] 管理后台
- [x] 搜索结果页、公开用户主页、分类与关键词管理
- [x] 任务分类模型、后台维护和前台筛选联动
- [ ] 测试补齐与体验优化（单元 / 组件 / API 层已完成补齐，端到端流程测试仍开放）

## 当前待补

- [ ] 沉淀 Playwright 端到端关键主链路（登录 → 发品 → 下单 → 收藏）并纳入 CI
- [ ] 继续做少量低频页面文案与体验收尾
- [ ] 增加更稳定的浏览器侧回归检查

## Production Phase 1（对象存储，2026-08-28 完成）

- [x] S3 兼容对象存储抽象（`StorageClient` 接口 + AWS SDK v3 实现：MinIO / S3 / R2）
- [x] 公私 bucket 隔离与访问策略（public 匿名可读禁写，private 全禁匿名）
- [x] `UploadedAsset` 统一资源模型 + migration（owner/配额/生命周期/业务绑定）
- [x] 图片内容安全管线：魔数 + decode + 像素上限 + EXIF/GPS 剥离 + 重编码
- [x] 并发安全用户配额（条件原子 UPDATE，默认 500MB）
- [x] 私有资源签名访问 API（`GET /api/assets/{id}/access`）与业务级授权
- [x] 敏感材料保留期（认证审核后 30 天自动清理原图）与孤儿回收（`npm run storage:cleanup`）
- [x] 真实 MinIO 集成测试 + 真实 DB 并发配额集成测试；CI 增加 MinIO 服务真实执行
- [x] 移除生产本地磁盘上传依赖（`UPLOAD_DIR` 废弃），前端表单切换即时上传 token 模式

## 最近进展

- [x] Production Phase 1 对象存储与私有资源安全体系（见 [STORAGE.md](STORAGE.md)）
- [x] 修复商品表单新图以 blob: 预览提交导致发品无法附图的问题（ImageUploader 改为选图即上传）
- [x] 修复租赁表单图片字段名与 action 不一致（`images[]` → `imageUrls`）导致图片被丢弃的问题
- [x] 修复商品详情 generateMetadata 吞掉 notFound 控制流错误的问题
- [x] app:smoke 断言对齐当前页面文案；未知路由 404 检查（流式 notFound 语义说明见脚本注释）
- [x] 上传接口错误响应不再透传内部 message，统一走 actionErrorMessage 并补泄漏防护用例
- [x] jest-dom 匹配器改为 vitest.setup.ts 全局注入，移除约 41 个测试文件的逐文件导入
- [x] 补齐 `src/lib/decimal.ts` 与 `health-repository.ts` 单测，消除零覆盖模块
- [x] shadcn 移至 devDependencies，新增 ioredis；删除无引用脚本 scripts/scan-quality.ts
- [x] Redis 限流外部化：ioredis 原子 Lua 固定窗口 + 进程内自动降级双模式（REDIS_URL 可选）
- [x] CSP 收紧：生产 script-src 改为每请求 nonce + strict-dynamic，middleware 按请求生成
- [x] 软删除统一化：Prisma client extension 自动过滤 deletedAt 并将 delete 映射为软删除
- [x] docker compose 与 CI 增加 Redis 服务；新增真实 Redis 集成测试（INTEGRATION_REDIS_URL 门控）
- [x] 修正 `prisma/seed.ts` 和 `src/lib/auth.ts` 中的乱码源头
- [x] 重写商品、跑腿、服务三类详情页及其测试
- [x] 修正商品、跑腿、服务状态常量与推荐理由文案
- [x] 新增 `npm run app:smoke:auth`，覆盖 `profile`、`my/*`、`messages`、`notifications`、`verification` 等登录态主链路
- [x] 保持 `npm run db:verify`、`npm run app:smoke`、`npm run app:smoke:auth` 可重复通过
- [x] 新增 `npm run text:verify`，把常见中文乱码片段纳入源码和文档检查

## 当前测试基线

以最近一轮验证为准（2026-08-28）：

- `189` 个测试文件，`983` 个测试通过（另有门控跳过）
- 覆盖率四项硬门槛 lines / branches / functions / statements ≥ 80%（实测 86.98 / 81.04 / 82.36 / 86.98）
- 另有真实数据库 / Redis / MinIO 集成测试，分别由 `INTEGRATION_DATABASE_URL`、`INTEGRATION_REDIS_URL`、`INTEGRATION_S3_ENDPOINT` 门控；CI 中全部真实执行

# 开发计划

## Production 阶段总览（formal phase map，2026-08-30 定稿）

| 阶段 | 名称 | 状态 |
| --- | --- | --- |
| Production Phase 1 | Object Storage + Sensitive File Separation | **DONE**（2026-08-28） |
| Production Phase 2 | Playwright Critical-path E2E + Release Gate | **DONE**（2026-08-30） |
| Production Phase 3A | Production Deployment Foundation（仓库侧） | **DONE / REPO_SIDE_ACCEPTED**（2026-08-30） |
| Production Phase 3B | Real Production Deployment（真实服务器上线） | **DEFERRED**（真实外部基础设施暂不提供） |
| Production Phase 4 | Observability / Monitoring / Recovery Foundation | **NEXT** |
| Production Phase 5 | Agreements / Privacy / Platform Rules / Data Governance | 未开始 |
| Production Phase 6 | Payment Domain Model | 未开始 |
| Production Phase 7 | Licensed Payment Provider Integration | 未开始 |
| Production Phase 8 | Refund / Split / Platform Fee / Ledger / Reconciliation | 未开始 |
| Production Phase 9 | Operations Dashboard / Funnel Analytics | 未开始 |
| Production Phase 10 | Controlled Single-campus Pilot | 未开始 |

> **PRODUCTION_LAUNCH_BLOCKED = TRUE**
>
> 原因：`PHASE_3B_REAL_DEPLOYMENT = DEFERRED`（非代码质量失败）。
> Phase 4 及其后的仓库开发可以继续，但**不得因后续 Phase 完成而认为产品可以正式公网发布**；
> 正式上线前必须重新打开并完成 Phase 3B（真实服务器、域名、DNS、生产 TLS、异地备份目标、
> 生产冒烟与 rollback drill 等全部硬门禁，见下节）。

## Production Phase 3A — Production Deployment Foundation（2026-08-30 完成）

`PHASE_3A_REPO_SIDE_ACCEPTED = YES`。范围限定为**仓库侧**生产部署基础，不包含真实公网部署。
权威文档：[PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md)、[BACKUP_RESTORE.md](BACKUP_RESTORE.md)、
[ROLLBACK.md](ROLLBACK.md)、[PRODUCTION_SECURITY.md](PRODUCTION_SECURITY.md)。

- [x] production Docker packaging：多阶段 Dockerfile（deps/builder/runner/migrator）、standalone 输出（仅容器构建启用）、非 root、HEALTHCHECK、GIT_SHA → `/api/health` release identity
- [x] production Compose topology：caddy（唯一 80/443）+ app + postgres + redis 全内网；数据端口零发布
- [x] Caddy/reverse proxy：ACME 自动 HTTPS 模板、HTTP→HTTPS 308、`/assets/*` 公共资产只读出口（bucket 前缀固定）
- [x] production env/secrets validation：`.env.production.example` + `production-env-check`（含 self-hosted bucket 固定契约）
- [x] PostgreSQL migration deployment：`migrate deploy` 一次性容器 + no-pending 验证；禁止 dev/db push
- [x] backup/restore tooling：`pg_dump -Fc` + SHA256 + retention + offsite 失败即整体 FAIL；restore 拒绝覆盖生产库名
- [x] restore drill tooling：`restore-drill.sh`（真实执行通过）
- [x] safe/hard rollback foundation：不可变 SHA 镜像、`switch_app_to` exact-image hard assert、`restore-production-postgres.sh` fail-closed
- [x] Redis production baseline：requirepass + EPHEMERAL 数据分类（仅限流）
- [x] S3/object-storage production foundation：fail-fast env 断言
- [x] self-hosted MinIO public/private delivery：least-privilege policy、public 匿名读/写拒、private 经同源代理端点 `/api/assets/[id]/content`（浏览器永不接触 minio:9000）
- [x] E2E production safety guard：destructive reset 显式 allow policy（NODE_ENV/库名/loopback/override）
- [x] CI release gates：verify（lint/typecheck/test/coverage/build）+ e2e（Playwright critical paths）双 job
- [x] master branch protection：PR before merge + verify/e2e required checks + enforce admins + 禁 force push/删除

## Production Phase 3B — Real Production Deployment（DEFERRED）

`PHASE_3B_REAL_DEPLOYMENT = DEFERRED`。原因：真实外部基础设施（服务器/域名/DNS 等）当前暂不提供——
这是外部资源缺口，不是代码质量失败。Phase 3A 的全部仓库侧能力已就绪，3B 启动时按以下硬门禁逐项执行：

1. Authorized Linux production server
2. Docker >= 24
3. Docker Compose v2
4. SSH management access
5. Real production domain
6. DNS A/AAAA
7. Real ACME HTTPS certificate
8. HTTP → HTTPS verification
9. Production PostgreSQL deployment
10. Production Redis verification
11. Real S3 or self-hosted MinIO production deployment
12. Off-site backup destination
13. Actual production backup
14. Actual restore drill
15. Actual restart/reboot verification
16. Actual exact-image rollback drill
17. External production-origin smoke
18. Authenticated production smoke
19. Public asset production verification
20. Private asset production verification
21. Network exposure verification（仅 80/443 公开；3000/5432/6379/9000/9001/22 约束见 PRODUCTION_SECURITY.md）
22. Real release SHA verification（`/api/health` release == 部署 SHA）

> **EXTERNAL_COMPLIANCE_PREREQUISITE**（若部署于中国大陆）：上线前必须实际确认
> ICP 备案/许可、公安联网备案、域名实名、云厂商接入要求等外部合规事项；
> 未取得真实凭证前不得声称已完成。法务细节属 Production Phase 5 范畴，此处仅标记前置条件。

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

## Production Phase 2（E2E Release Gate，2026-08-30 完成）

- [x] Playwright 基础设施：production build webServer + E2E 专用库 + 确定性账号 + storageState 运行时生成
- [x] 8 条 Golden Flow：认证/商品/订单状态机/跑腿/服务/租赁/消息/举报后台
- [x] 私有资产浏览器边界：`/api/assets/{id}/access` 四角色（双方/ADMIN/无关 403/匿名 401）
- [x] 安全负例：管理员越权、跨用户编辑 404、无关用户不可见他单、并发重复下单仅 1 有效订单
- [x] CI 拆分 verify + e2e 双 job（e2e 失败即失败，失败上传 report/trace/video artifacts）
- [x] 本地连续三轮 17/17 全绿；顺手修复 7 个 E2E 暴露的真实缺陷（见"最近进展"）

## 当前待补

- [x] GitHub branch protection：verify / e2e 已设为 required checks（PR before merge + enforce admins + 禁 force push/删除）
- [x] Production Phase 3A：仓库侧生产部署基础（见上节，REPO_SIDE_ACCEPTED）
- [ ] Production Phase 4：Observability / Monitoring / Recovery Foundation（NEXT）
- [ ] Production Phase 3B：真实服务器部署（DEFERRED——待真实服务器/域名/DNS 等外部资源就绪后重开）
- [ ] 继续做少量低频页面文案与体验收尾

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

- [x] Production Phase 2 E2E Release Gate（见上节）；E2E 暴露并修复 7 个真实缺陷：
  服务预约抽屉 hidden 字段名与 schema 不一致（预约完全无法提交）、举报弹窗原因下拉提交中文标签而非枚举、
  举报 schema 可选目标字段不接 FormData null（所有单目标举报必失败）、跑腿接单弹窗误绑 updateErrandStatus（接单静默失败）、
  跑腿"提交完成"后 Order 表状态不同步导致发布者无确认入口、Order 完成时不回写 ErrandTask 状态、
  租赁发布表单 uploading 状态不复位导致成功后页面卡死 + 租赁通知 payload 带非法 Order 外键（租赁申请必失败）

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

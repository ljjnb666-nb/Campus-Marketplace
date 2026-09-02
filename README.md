# 校园集市

面向大学校园的二手交易、校园跑腿、技能服务与闲置租赁撮合平台。当前优先完成网页版，使用本地 PostgreSQL、Prisma 和 Auth.js 作为第一版基础设施。

## 当前状态

当前仓库已经具备可运行的全栈 MVP，覆盖以下主流程：

- 用户注册、登录、退出、资料编辑、校园认证
- 二手商品发布、编辑、上下架、收藏、下单
- 跑腿任务发布、接单、状态流转
- 技能服务发布、编辑、上下架、预约下单
- 闲置租赁发布、租用申请、审批与归还流转
- 订单、站内消息、通知、评价、举报
- 管理后台、分类管理、违禁关键词管理

## 技术栈

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS v4
- Prisma ORM（挂载软删除统一拦截）
- PostgreSQL
- Redis（可选，限流计数外部化，见下方启动说明）
- Auth.js Credentials 登录

## 本地启动

1. 安装依赖

```bash
npm install
```

2. 复制环境变量

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. 启动本地 PostgreSQL、Redis 与 MinIO

```bash
docker compose up -d
```

> Redis 用于限流计数外部化（可选）：在 `.env` 中设置 `REDIS_URL="redis://localhost:6379"` 启用；
> 不设置时回退进程内计数，仅单实例部署语义。
>
> MinIO 为 S3 兼容对象存储（必需）：API 在 http://localhost:9100，Console 在 http://localhost:9101
> （minioadmin/minioadmin）。`docker compose up -d` 会自动创建 public/private bucket 并设置匿名访问策略；
> 所有上传文件（含学生证等敏感材料）都存储于此，生产环境替换为 AWS S3 / Cloudflare R2 等，
> 见 [docs/STORAGE.md](docs/STORAGE.md)。

4. 生成 Prisma Client 并执行迁移

```bash
npm run prisma:generate
npm run prisma:migrate
```

5. 数据库迁移与生产部署规范

- **本地开发演进**：使用 `npx prisma migrate dev --name <migration_name>`。请勿在开发环境使用 `prisma db push`，以确保所有结构变更均落地为 `prisma/migrations` 文件夹下的版本化 SQL 文件。
- **生产环境部署**：严格执行 `npx prisma migrate deploy`。此命令只应用已落盘的 SQL 迁移文件，不会修改已有的真实交易与会话数据。
- **异常恢复与回滚**：如遇生产部署失败，可通过 `npx prisma migrate status` 查验失败的 Migration ID；在紧急情况下执行 `prisma migrate resolve --rolled-back <migration_name>` 标记回滚，并按照关联 SQL 文件应用逆向 DDL 脚本。

6. 写入种子数据

```bash
npm run db:seed
```

可选：校验本地种子数据

```bash
npm run db:verify
```

可选：在开发服务启动后验证公开页面主链路

```bash
npm run app:smoke
```

可选：在开发服务启动后验证登录态页面主链路

```bash
npm run app:smoke:auth
```

对象存储清理（孤儿上传 / 敏感材料保留期 / 待删除重试，幂等，支持 dry-run）：

```bash
npm run storage:cleanup
npm run storage:cleanup -- --dry-run
```

可选：检查源码、文档和脚本里是否出现常见中文乱码片段

```bash
npm run text:verify
npm run e2e            # Playwright Release Gate（需先 docker compose up -d postgres redis minio）
```

7. 启动开发服务

```bash
npm run dev
```

默认访问 [http://localhost:3000](http://localhost:3000)。

## 测试账号

- 管理员：`admin@campus.local / Admin123456`
- 学生：`student1@campus.local / Student123456`

## 常用命令

```bash
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run db:verify
npm run app:smoke
npm run app:smoke:auth
npm run text:verify
```

## 文档

- [docs/MASTER_ROADMAP.md](docs/MASTER_ROADMAP.md)（产品工程路线权威来源，Master Roadmap v1.0）
- [docs/PRD.md](docs/PRD.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DATABASE.md](docs/DATABASE.md)
- [docs/API.md](docs/API.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/STORAGE.md](docs/STORAGE.md)
- [docs/E2E.md](docs/E2E.md)
- [docs/TODO.md](docs/TODO.md)

## 验证状态

最近一轮本地验证已通过以下命令：

- `npm run lint`
- `npm run typecheck`
- `npx vitest run`（全量测试）
- `npm run test:coverage`（覆盖率门槛全局 80%：lines / branches / functions / statements）
- `npm run e2e`（Playwright 关键链路 Release Gate：真实 PostgreSQL / Redis / MinIO + production build，详见 [docs/E2E.md](docs/E2E.md)）

依赖与 lock 文件注意事项：

- `package-lock.json` 在 Linux 容器中生成（`docker run --rm -v "%cd%:/app" -w /app node:24 npm install`，Git Bash 下加 `MSYS_NO_PATHCONV=1`）。Windows 上的 npm 会按当前平台裁剪 lock 的可选依赖条目（如 `@tailwindcss/oxide-linux-*`），提交后会导致 CI（Linux）的 `npm ci` 报 Missing。
- 本地开发用 `npm install`（宽松）即可，无需 `npm ci`；重装 node_modules 后记得 `npx prisma generate`。

当前测试基线（来源：master 最近一次成功的 GitHub Actions verify + e2e run，
2026-09-02 @ `be0fd94c`，不以本地估算为准）：

- 全量测试 `215` 个测试文件 / `1216` 个用例通过（CI 中真实数据库 / Redis / MinIO 集成测试全部真实执行），覆盖单元、组件与 API 路由层
- 覆盖率门槛 lines / branches / functions / statements ≥ 80%（本轮 CI 实测 88.23 / 81.84 / 84.06 / 88.23）
- E2E 基线：Playwright `24` 条关键链路测试（8 条 Golden Flow + 权限/并发/可观测性负例）CI 全绿
- 另有真实数据库 / Redis / MinIO 集成测试，需分别设置 `INTEGRATION_DATABASE_URL`、`INTEGRATION_REDIS_URL`、`INTEGRATION_S3_ENDPOINT` 时才运行（CI 中全部真实执行）
- 生产化存储专项：S3 兼容对象存储 + 公私隔离 + 上传配额 + 敏感文件生命周期（详见 [docs/STORAGE.md](docs/STORAGE.md)）；以及可靠性专项：数据库连接池治理、结构化日志、统一错误处理、请求计时中间件、会话搜索下推数据库的查询优化；安全专项：Redis 限流外部化、CSP nonce 收紧（script-src 每请求 nonce + strict-dynamic）、软删除统一拦截（详见 [docs/SECURITY.md](docs/SECURITY.md)）

## 安全加固

最近一轮安全审查修复了以下问题：

| # | 问题 | 修复方式 | 涉及文件 |
|---|------|----------|----------|
| 1 | Session 未显式设置有效期 | `maxAge` 缩短至 7 天，`updateAge` 显式声明 24h | `src/lib/auth.ts` |
| 2 | 数据库连接池未配置 | 自动注入 `connection_limit=10`、`pool_timeout=10` | `src/lib/prisma.ts` |
| 3 | 租赁订单并发无行锁兜底 | `createRentalOrderTx` 使用 `SELECT ... FOR UPDATE` 行锁 | `src/lib/rental-order-machine.ts` |
| 4 | 图片上传仅校验 MIME 类型 | 已有文件魔数校验（JPEG/PNG/WebP），无需额外修复 | `src/lib/upload.ts` |
| 5 | 密码强度无复杂度限制 | 注册 schema 增加大小写字母 + 数字要求 | `src/validators/auth.ts` |
| 6 | Seed 脚本无生产环境保护 | 入口处检查 `NODE_ENV`，生产环境直接退出 | `prisma/seed.ts` |
| 7 | 无 CORS 白名单配置 | Middleware 对 `/api/*` 收紧为仅允许同源请求 | `middleware.ts` |
| 8 | 限流计数进程内存储，多实例部署失效 | 支持配置 `REDIS_URL` 外部化（原子 Lua 固定窗口），未配置或 Redis 故障自动回退进程内；docker compose/CI 已加 Redis 服务 | `src/lib/rate-limit.ts` |
| 9 | 生产 CSP script-src 含 `unsafe-inline` | CSP 移至 middleware 按请求生成，script-src 采用每请求 nonce + `strict-dynamic`；style-src 因 React 行内样式保留 | `middleware.ts`、`next.config.ts` |
| 10 | 软删除过滤逐查询手写，有遗漏风险 | Prisma client extension 统一注入 `deletedAt: null` 过滤并将 delete 映射为软删除，显式声明 `deletedAt` 时豁免 | `src/lib/prisma-soft-delete.ts` |
| 11 | 上传文件写入本地 public/uploads，敏感材料（学生证等）成为永久公开静态文件 | 全面切换 S3 兼容对象存储（MinIO/R2/S3），公私 bucket 隔离；私有资源仅经鉴权签名 URL 短时访问；sharp 重编码剥离 EXIF/GPS；并发安全配额与生命周期清理 | `src/lib/storage/`、`src/lib/asset-service.ts`、`docs/STORAGE.md` |

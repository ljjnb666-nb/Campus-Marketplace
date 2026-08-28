# 系统架构

## 前端

- Next.js App Router
- React 19
- Tailwind CSS v4
- Server Components + Client Components 混合模式

## 服务端

- Next.js Route Handlers 提供少量读取接口
- Server Actions 承担主要写操作
- Auth.js Credentials 处理登录与会话
- `middleware.ts` 承担请求计时（Server-Timing）、CSP nonce 生成（script-src 每请求 nonce + strict-dynamic，见 SECURITY.md）与 API 同源收紧

## 数据层

- PostgreSQL 作为主数据库
- Prisma 负责 Schema、迁移与查询；导出的客户端挂载软删除统一拦截（`src/lib/prisma-soft-delete.ts`）
- Redis（可选）作为限流计数的外部存储：配置 `REDIS_URL` 启用多实例共享计数，未配置或故障时回退进程内计数
- S3 兼容对象存储（MinIO / AWS S3 / Cloudflare R2）承载全部上传文件：经 `StorageClient` 抽象访问，公私 bucket 隔离，私有资源走短时签名 URL（见 [STORAGE.md](STORAGE.md)）
- 本地通过 Docker Compose 运行数据库、Redis 与 MinIO 容器

## 目录职责

- `src/app`：路由、页面、Route Handlers
- `src/components`：页面组件与通用 UI
- `src/actions`：Server Actions（写操作入口）
- `src/repositories`：读模型查询与数据拼装
- `src/lib`：认证、上传、审核、限流、订单状态机、软删除拦截、对象存储（`storage/`）、资源服务（`asset-service.ts`）与工具函数
- `src/constants`：状态、选项、枚举标签
- `src/validators`：Zod 校验
- `prisma`：Schema、迁移、种子数据

## 存储分层（Production Phase 1）

上传链路强制经过抽象层，组件与页面不得直接触碰 S3 SDK：

```
表单/前端组件 → Upload API / Server Action
  → asset-service（配额 + 登记 + 授权）
    → StorageClient 接口
      → S3Storage（AWS SDK v3：MinIO / S3 / R2）
```

- 公开资源（avatar/product/rental/service）：公开 URL 直接访问
- 私有资源（verification/handover/return/report）：DB 存 `asset:<id>` 引用，
  访问经 `GET /api/assets/{id}/access` 业务鉴权后签发短时 URL
- 详细设计（key 规则、配额并发、孤儿回收、保留期、失败恢复）见 [STORAGE.md](STORAGE.md)

## 当前设计原则

- 读写分层，列表与详情由 repository 聚合查询
- 写操作统一在服务端做二次权限校验
- 先完成网页主流程，再继续扩展支付、实时能力和运营能力

## 分层边界（ESLint 强制）

依赖方向：`components → app（页面/布局）→ actions / repositories → lib/prisma`。由 `eslint.config.mjs` 的 `no-restricted-imports` 强制：

- `src/components` 禁止值导入 `@/lib/prisma`、`@prisma/client` 与 `@/repositories`（类型导入放行）；组件所需数据由 app 层查询后经 props 传入，或走 Server Actions。例如站点头部（`site/header.tsx`）的未读徽标由 `app/layout.tsx` 查询后以 props 传入。
- `src/app` 禁止值导入 `@/lib/prisma` 与 `@prisma/client`，读写统一走 `@/repositories`。

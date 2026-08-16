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

## 数据层

- PostgreSQL 作为主数据库
- Prisma 负责 Schema、迁移与查询
- 本地通过 Docker Compose 运行数据库容器

## 目录职责

- `src/app`：路由、页面、Route Handlers
- `src/components`：页面组件与通用 UI
- `src/actions`：Server Actions（写操作入口）
- `src/repositories`：读模型查询与数据拼装
- `src/lib`：认证、上传、审核、限流、订单状态机、工具函数
- `src/constants`：状态、选项、枚举标签
- `src/validators`：Zod 校验
- `prisma`：Schema、迁移、种子数据

## 当前设计原则

- 读写分层，列表与详情由 repository 聚合查询
- 写操作统一在服务端做二次权限校验
- 先完成网页主流程，再继续扩展支付、实时能力和运营能力

## 分层边界（ESLint 强制）

依赖方向：`components → app（页面/布局）→ actions / repositories → lib/prisma`。由 `eslint.config.mjs` 的 `no-restricted-imports` 强制：

- `src/components` 禁止值导入 `@/lib/prisma`、`@prisma/client` 与 `@/repositories`（类型导入放行）；组件所需数据由 app 层查询后经 props 传入，或走 Server Actions。例如站点头部（`site/header.tsx`）的未读徽标由 `app/layout.tsx` 查询后以 props 传入。
- `src/app` 禁止值导入 `@/lib/prisma` 与 `@prisma/client`，读写统一走 `@/repositories`。

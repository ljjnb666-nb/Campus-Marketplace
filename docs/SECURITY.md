# 安全设计

## 已实现

- Auth.js 会话管理
- Session 有效期显式配置：`maxAge` 7 天、`updateAge` 24 小时（2026-08-25 修复）
- `bcryptjs` 密码哈希存储
- 注册密码复杂度校验：至少 8 位，需包含大小写字母和数字（2026-08-25 修复）
- Zod 输入校验
- 服务端角色与归属权限检查
- 违禁关键词拦截基础能力
- 举报与后台审核链路
- 固定窗口限流（`src/lib/rate-limit.ts`）：登录防爆破 10 次/15 分钟，注册 5 次/小时，上传接口共用同一限流器。配置 `REDIS_URL` 时计数存入 Redis（原子 Lua 脚本，多实例共享）；未配置或 Redis 故障时自动回退进程内计数（仅单实例语义）（2026-08-26 外部化）
- 6 项安全响应头：nosniff、SAMEORIGIN、Referrer-Policy、Permissions-Policy、HSTS、CSP（CSP 由 middleware 按请求生成）
- CSP script-src 采用每请求 nonce + `strict-dynamic`，生产环境不再依赖 `unsafe-inline`；style-src 因 React 行内样式保留 `unsafe-inline`（2026-08-26 收紧，`middleware.ts` + `next.config.ts`）
- 软删除统一拦截（`src/lib/prisma-soft-delete.ts`）：User/Product/ErrandTask/ServiceListing/RentalListing 的列表查询自动注入 `deletedAt: null` 过滤，`delete/deleteMany` 自动映射为软删除打标记；调用方显式声明 `deletedAt` 条件时豁免（管理端仍可查删、物理清理走显式硬删除）（2026-08-26 统一化）
- 订单金额一律服务端取库，不信任表单价格
- 商品/跑腿下单与接单使用条件 `updateMany` 原子流转，防并发超卖/重复接单
- 租赁订单创建使用 `SELECT ... FOR UPDATE` 行锁，防止并发重复预订同一时段（2026-08-25 修复）
- 图片上传文件魔数校验：校验 JPEG/PNG/WebP 文件头字节，防止伪造 MIME 类型上传恶意内容（`src/lib/upload.ts`）
- 生产级对象存储体系（2026-08-28，Production Phase 1，详见 [STORAGE.md](STORAGE.md)）：
  - 全部上传改走 S3 兼容对象存储（MinIO / AWS S3 / Cloudflare R2），本地磁盘与 `public/uploads` 不再承接生产上传
  - 公私 bucket 隔离：avatar/product/rental/service 为公开对象；verification/handover/return/report 为私有对象，无永久公开 URL，仅业务鉴权后签发短时（默认 5 分钟）签名 URL
  - 私有访问授权：`GET /api/assets/{assetId}/access` 按资源归属校验（本人 / 对应订单参与方 / ADMIN），已删除 404、过期 410、无权 403
  - 图片内容安全管线（sharp）：魔数 + 真实 decode + 像素上限（12000px / 40MP）+ autoRotate + EXIF/GPS/相机 metadata 完全剥离 + 重编码（WebP，透明通道保留 PNG）
  - object key 全服务端生成（UUID），白名单校验拒绝路径穿越；用户输入不参与 key 拼接
  - 并发安全配额：`User.storageUsedBytes` 条件原子 UPDATE 预留/释放，配额默认 500MB/用户；S3/DB 失败路径均完整补偿，不留脏数据与永久占用
  - 敏感材料生命周期：认证审核后保留 `VERIFICATION_ASSET_RETENTION_DAYS`（默认 30 天）自动删除原图，认证结论保留
  - 孤儿回收：未绑定业务的临时上传超过 `ASSET_ORPHAN_TTL_HOURS`（默认 24h）由 `npm run storage:cleanup` 幂等清理
  - 结构化日志只记录 assetId/userId/category/sizeBytes/operation/duration/errorCode，不记录签名 token、objectKey、原始内容或鉴权头
- 数据库连接池显式配置：`connection_limit=10`、`pool_timeout=10`（2026-08-25 修复）
- Seed 脚本生产环境保护：`NODE_ENV=production` 时拒绝执行（2026-08-25 修复）
- API 路由 CORS 白名单：Middleware 对 `/api/*` 收紧为仅允许同源请求（2026-08-25 修复）

## 数据暴露约束

前台公开信息仅包含必要资料，例如昵称、头像、学校、校区、认证状态、订单数、好评率。

以下信息默认不公开：

- 完整学号
- 学生证图片
- 手机号
- 身份证号
- 精确宿舍号等敏感地址信息

## 后续加强方向

- 接入更完整的内容审核能力
- 增加登录风控与异常行为审计
- 引入更细粒度的后台操作留痕与告警
- 对象存储高流量场景演进：presigned 直传 + 后端校验回执，减少服务端中转带宽
- HTTPS 强制跳转依赖反向代理层（Nginx 等）配置
- next-auth v4 → v5（Auth.js）迁移

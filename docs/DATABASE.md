# 数据库设计

## 核心模型

- `User`：用户、角色、状态、认证状态、公开资料
- `Campus`：校区
- `UserVerification`：校园认证提交记录
- `Product` / `ProductCategory` / `ProductImage`：二手商品
- `ErrandTask` / `ErrandCategory` / `ErrandFavorite`：跑腿任务
- `ServiceListing` / `ServiceCategory` / `ServiceFavorite`：技能服务
- `RentalCategory` / `RentalListing` / `RentalListingImage`：闲置租赁发布
- `RentalUnavailablePeriod`：租赁不可租时段（冲突检测）
- `RentalOrder` / `RentalOrderStatusLog`：租赁订单与完整状态流水
- `RentalHandoverRecord` / `RentalReturnRecord`：租赁交接与归还记录
- `RentalExtensionRequest` / `RentalDamageClaim` / `RentalDispute`：续租、损坏定责与争议
- `RentalReview` / `RentalFavorite`：租赁评价与收藏
- `Order`：商品、任务、服务三类订单
- `Conversation` / `ConversationParticipant` / `Message`：站内会话与消息
- `Favorite`：商品收藏
- `BlockedUser`：用户拉黑
- `Review`：订单后评价
- `Report`：举报
- `ModerationKeyword`：违禁关键词
- `Notification`：站内通知
- `AdminLog`：后台操作日志

## 设计原则

- 商品、任务、服务统一围绕“发布者 + 状态 + 校区”建模
- 订单统一抽象，避免三套独立交易流；租赁因状态机复杂度单独成域并保留全程状态流水
- 软删除统一拦截（2026-08-27）：`User / Product / ErrandTask / ServiceListing / RentalListing`
  五个模型的列表查询由 Prisma client extension 自动注入 `deletedAt: null` 过滤，
  `delete/deleteMany` 自动映射为打标记；显式声明 `deletedAt` 条件的查询豁免（管理端可查删、物理清理走显式硬删除），详见 `src/lib/prisma-soft-delete.ts`
- 敏感信息仅在服务端保留，不直接对前台开放
- 为支付、AI 审核、多校区扩展预留字段和状态模型

## 本地数据准备

- 迁移目录：`prisma/migrations`
- Schema：`prisma/schema.prisma`
- 种子：`prisma/seed.ts`

默认种子会写入：

- 1 个管理员
- 10 个学生用户
- 商品、跑腿、服务示例数据
- 订单、评价、会话与举报示例数据

## 连接池容量规划（FINAL REPAIR A / LR-014）

生产 Postgres `max_connections` 由 `compose.production.yml` 的
`max_connections=${POSTGRES_MAX_CONNECTIONS:-100}` 提供；应用侧 Prisma 池
由 `DATABASE_URL` 的 `connection_limit` / `pool_timeout` 控制，二者均由
`scripts/production-env-check.ts` 在部署前强制校验（launch gate）。

容量公式：

```text
web 实例数 × connection_limit + worker 实例数 × worker_connection_limit
  ≤ max_connections − 保留位

保留位 ≥ admin(1) + migration(1) + monitoring/backup(2) + failover 余量(6)
```

默认拓扑（单 web 实例、无独立 worker、max_connections=100）：
`connection_limit=10` 留有 90 连接余量，属于保守安全默认，不是"调大=修复"
的对象；扩容实例时按公式重算并同步修改连接串。

配套事实（FINAL REPAIR A 实测与修复）：

- `src/lib/prisma.ts` 在生产同样挂 global 单例。此前生产每个模块图实例
  各建一个 PrismaClient，单进程真实连接上限 = 池数 × connection_limit
  （campus_perf 压测实测峰值 17–18 > 10），容量公式因此失真；单例化后
  每进程恰一个池，公式按 `connection_limit` 直接核算。
- `pool_timeout=10`：池饱和时请求最长等待 10s 后失败。该值决定饱和行为
  是"长尾延迟"而非"快速失败"；在公开读已接入 30s TTL 缓存（下节）后，
  池饱和概率显著下降。调整该值前必须先看最新压测的 p99 与池等待证据，
  禁止无证据调参。
- 单请求 DB fan-out：匿名首页由 12 条查询降为 0 条（缓存命中时）；登录
  用户仅保留 3 条身份相关查询。`/products` 计数查询（~20ms）为已知成本。

## 公开读缓存策略（FINAL REPAIR A / LR-011）

`src/lib/public-cache.ts` 提供进程内 TTL 缓存，接入范围与 SLA：

| 数据 | SLA | 说明 |
| --- | --- | --- |
| 首页榜单/计数（`home-repository` 公共部分） | stale ≤ 30s | key 仅 campusId 维度 |
| 校区/分类元数据（`getProductFormMeta`） | stale ≤ 60s | 公共元数据 |

契约：

- 只缓存与请求者身份无关的公开共享数据；`userSummary`（未读数/进行中
  订单）与 favorites 标记等 viewer 相关读一律不缓存，防 cross-user /
  auth-state / favorite-state 泄漏。
- 高基数参数（`/search` 的 q、`/products` 的 q/category/status/price/
  sort/page）不作为缓存 key，搜索结果不做页面/数据级缓存——其性能由
  query-shape 复合索引承担（migration `20260926100802`，Product/ErrandTask/
  ServiceListing/RentalListing 四域；检索子查询经 createdAt 索引游走 + LIMIT
  提前终止）。pg_trgm GIN 经实测评估后不交付：2 字关键词（中文最常见长度）
  触发全索引扫描回退且无法在 datamodel 表达（drift=NONE 不变量），
  详见 BACKLOG REPAIR-A-DEBT-PERF-01。

  LR-012 正式分类 = MITIGATED_WITH_DOCUMENTED_BOUNDARY
  （PRODUCTION_BLOCKER = NO，STRUCTURAL_DEBT = YES）：游走优化依赖
  "ORDER BY createdAt + LIMIT 12 + 匹配项足够早出现"；零匹配/极低匹配/
  typo 查询无法提前终止，仍可能退化到接近基线 Seq Scan 成本（
  bench-results/search-boundary.json 实测：COMMON 数码 c=100 p99 ~1.2s、
  RARE midi键盘 c=100 p99 ~2.4s、ZERO 显微镜 c=100 p99 ~2.6s，
  对应 EXPLAIN 见 bench-results/plans-search-boundary.txt）。通用解
  （pg_trgm/FTS/中文分词/外部搜索引擎）属 FINAL REPAIR B / backlog。
- 失效为 TTL eventual consistency：listing 增删改、favorite、订单完成、
  治理 takedown 等 mutation 不主动失效，公开榜单/计数最多陈旧 30s；
  元数据最多 60s。这是记录在案的 SLA 取舍。
- 不依赖 Redis：公开页面可用性与 Redis 可用性解耦（单实例 compose 拓扑）。

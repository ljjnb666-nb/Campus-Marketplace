# 生产安全基线（Production Security）

> 部署拓扑见 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)；本文聚焦安全控制与验证方法。

## 1. 网络最小暴露面

- 公网只开 **80（仅 HTTPS 重定向）/ 443**，由 Caddy 提供；验证：
  `ss -tlnp | grep -E ':(3000|5432|6379|9000|9001)'` 在宿主机应无公网监听
- `5432/6379/9000/9001/3000` 只存在于 compose `backend` 网络（未发布端口）
- 云厂商安全组：只放行 80/443；22 限源 IP 或走 VPN/堡垒机
- Redis `requirepass` 强密码 + `allkeys-lru` 128MB（数据分类 EPHEMERAL，
  仅限流计数，见 PRODUCTION_DEPLOYMENT.md 第 2 节）

## 2. Secrets 管理

- 全部秘密来自服务器上的 `.env.production`（不入 Git，被 .gitignore 忽略）
- **不进镜像**：Dockerfile 无秘密 build args、无 .env 复制；.dockerignore 排除 `.env*`
- **不进客户端**：代码零 `NEXT_PUBLIC_*` 变量（已审计），无秘密可达 bundle
- **不进日志**：env-check 只打印变量名 PASS/FAIL；应用日志不打印完整
  DATABASE_URL/access key（logger 只记上下文字段）；GitHub Actions 日志只
  使用 dummy CI 凭据
- 生产 fail-fast：`src/lib/env.ts` 启动即拒绝 minioadmin/localhost 对象存储；
  `scripts/production-env-check.ts` 部署前拒绝危险默认值（postgres/postgres、
  CI dummy、短密码等）

## 3. 对象存储安全模型（Phase 1 模型不回退）

- 双桶分离：`S3_BUCKET_PUBLIC`（头像/商品图，匿名可下载、匿名写拒绝）与
  `S3_BUCKET_PRIVATE`（认证材料/交接凭证，匿名 GET/LIST 全拒绝，无永久公开 URL）
- **私有对象唯一出口：同源代理端点** `GET /api/assets/:assetId/content`
  （需登录，每次请求重新执行服务端授权：owner/订单参与者/ADMIN，无关用户 403、
  匿名 401、过期 410）→ server 用内部凭据经 `S3_ENDPOINT` 读取后转发，
  响应 `Cache-Control: private, no-store` + `X-Content-Type-Options: nosniff`。
  浏览器侧 URL 永远不含对象存储端点/桶名/objectKey
- 公开对象经 Caddy `/assets/*` 只读出口交付（self-hosted MinIO 时 bucket 前缀
  硬编码为 `campus-public`，与 minio-init/env-check 的固定契约一致——
  self-hosted 部署使用非默认桶名会被 production-env-check 直接拒绝）
- 公开对象 Cache-Control `public, max-age=31536000, immutable`；
  对象 key 全部服务端生成（用户文件名只作审计元数据）
- 生产冒烟必须验证的矩阵见 docs/SECURITY.md 与 tests/e2e/security.spec.ts

## 4. 应用层控制（已内建，不因部署改变）

- 中间件：同源校验（跨源 API 403）、CSP nonce（`strict-dynamic`）、安全头
- 登录限流：10 次/15 分钟/邮箱或 IP（Redis 固定窗口 + 单机降级；
  Redis 故障时进入 30s 失败冷却、立即本地回退，恢复详见
  docs/OBSERVABILITY.md「限流的失败冷却合同」）
- 上传限流：20 次/分钟/用户；请求体外层信封上限（Caddy 12MB 字节级
  authoritative + app 快速拒绝）；MIME/大小白名单；sharp 服务端重编码
  （两层限制合同见 docs/STORAGE.md §5.1）
- 限流依赖 `X-Forwarded-For` 第一跳，Caddy 已配置覆写为真实客户端 IP
  （deploy/Caddyfile），否则该键可被伪造

## 5. 依赖与漏洞

- npm audit 基线：3 high（deepmerge-ts < 8.0.0 栈耗尽，经 @prisma/config →
  prisma CLI 链路）。属 dev-time 工具链（prisma CLI 迁移时运行），运行时生产
  bundle 不含 prisma CLI；无已知 remote exploitable 生产 blocker
- 修复需 Prisma major 升级（>6.19），不夹带进部署阶段；见 docs/TODO.md 债务清单
- 禁止 `npm audit fix --force`

## 6. 重启生存性验证清单

部署后至少验证一次（每项：重启服务 → 等待 healthy → 验证）：

| 重启对象 | 验证 |
| --- | --- |
| app | `/api/health` 200；登录可用 |
| caddy | https://域名 200；HTTP→HTTPS 重定向 |
| postgres | health 后商品列表可读、下单事务正常 |
| redis | 限流生效（连续登录 11 次第 11 次被拒）；清空后业务数据无损 |
| host（可选） | 授权且确认可安全重连时方可执行 reboot survival test；否则记录 `HOST_REBOOT_NOT_EXECUTED` 并以 `restart: unless-stopped` 配置佐证 auto-start |

## 7. branch / 发布纪律

- master 受保护：PR before merge、`verify` + `e2e` required checks、
  禁 force push / 禁删除、enforce admins
- 发布镜像不可变 tag（git SHA）；部署历史见 `.releases.log`

## 8. Transactional Email 安全契约（Phase 9B）

所有 transactional email 经唯一链路投递：canonical Notification →
NotificationDelivery（EMAIL 渠道快照）→ NOTIFICATION_DELIVERY AsyncJob
（Phase 9A 队列）→ EmailProvider（resend）。业务事务绝不直接调用外部
email API（只 durable record intent；external send 仅发生在 async-worker
的 job 执行事务内）。

- **API key 处理**：`RESEND_API_KEY` 仅存在于 env（`.env.production`，
  600 权限）；只进 `Authorization` header，绝不入库、绝不入日志、绝不进
  错误对象/上报。preflight（`npm run env:check`）只打印变量名 + PASS/FAIL。
- **provider 幂等**：每次发送携带 deterministic `Idempotency-Key`
  （`notification/<notificationId>/email/v1`），重试/超时重放在 provider
  24h 保留窗口内收敛为一次真实投递；本地安全窗口 23h，超窗后任何 retry
  一律 no-provider-call → DEAD_LETTER（fail closed，禁止盲目重发；如需
  重发必须显式产生新的 notification/delivery intent）。
  窗口起算锚点 `NotificationDelivery.firstAttemptAt` 是【provider attempt
  safety-window anchor】：在第一次 external provider attempt 执行前以独立
  短事务 durable COMMIT（NULL → timestamp 单向迁移，绝不回退/重置），
  因此 provider accept 后的任何 crash/rollback 都不会重新起算 23h 窗口。
  它【不是】acceptance timestamp——acceptance 语义只属于
  `providerAcceptedAt`。
- **EMAIL_FROM 域名验证**：发信域名必须在 Resend 完成域名验证（SPF/DKIM）。
  域名验证属 Phase 3B external evidence；未完成前生产 email gate 通过也
  不代表真实收件可用。
- **日志红线**：结构化日志只允许 notificationId / deliveryId / jobId /
  provider / kind / attempt / durationMs / 安全错误码。收件地址、主题、
  正文、API key、provider raw response 绝不入日志，也绝不入 DB
  （DB 只存 provider / providerMessageId / providerAcceptedAt /
  受控 suppressionCode；destination 属 CONTACT_INFO，注销时清空）。
- **dead-letter 行为**：PERMANENT 失败（auth/请求非法/幂等键冲突）立即
  DEAD_LETTER；RETRYABLE（429/5xx/超时/网络）按 9A 中央退避重试至
  maxAttempts。dead-letter 不自动重放；409 invalid_idempotent_request 或
  超出幂等窗口的投递如需重发必须显式新 intent。
- **providerAcceptedAt 语义**：= provider 接受发送请求。绝不声称邮箱实际
  收件/已读（API success 不能证明 mailbox delivery）；9B 不做 delivery
  webhook。历史真实邮箱不永久保留：注销时 unsent 投递被抑制
  （RECIPIENT_ERASED）、已接受投递的 destination 一并清空。

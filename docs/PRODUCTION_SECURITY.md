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
- 登录限流：10 次/15 分钟/邮箱或 IP（Redis 固定窗口 + 单机降级）
- 上传限流：20 次/分钟/用户；MIME/大小白名单；sharp 服务端重编码
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

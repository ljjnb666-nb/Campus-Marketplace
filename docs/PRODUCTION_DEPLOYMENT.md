# 生产部署（Production Deployment）

> 运行拓扑、部署流程与日常运维的权威文档。备份/恢复见 [BACKUP_RESTORE.md](./BACKUP_RESTORE.md)，
> 回滚见 [ROLLBACK.md](./ROLLBACK.md)，安全基线见 [PRODUCTION_SECURITY.md](./PRODUCTION_SECURITY.md)。

## 1. 基础设施需求

单校园 MVP 最低配置：

| 资源 | 要求 |
| --- | --- |
| 服务器 | 1 台 VPS（2C4G 起步），Linux（Ubuntu 22.04+），已安装 Docker ≥ 24 与 Compose v2 |
| 域名 | 1 个公网域名，A/AAAA 记录指向服务器 IP |
| 对象存储 | 外部 S3 兼容提供商（推荐）或自建 MinIO（compose profile） |
| 磁盘 | 数据库卷与备份目录必须分属不同分区/挂载点 |

## 2. 架构

```
Internet ── 80/443 ──▶ caddy（唯一公网入口）
                          │  reverse_proxy + 自动 ACME HTTPS
                          ▼
                        app（Next.js standalone，非 root，仅内网 3000）
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
          postgres     redis      对象存储
        （持久卷）  （限流/EPHEMERAL）
```

- 端口暴露原则：**只有 caddy 的 80/443 对公网开放**。3000/5432/6379/9000/9001 一律
  不发布端口，仅在 compose 内部 `backend` 网络互通（见 `compose.production.yml`）。
- Redis 数据分类 `EPHEMERAL`：仅限流计数（`ratelimit:*` 键，TTL ≤ 15 分钟），
  不承载任何持久业务数据；清空/重启不影响订单、资产、账户。因此不挂持久卷。
- 对象存储：优先使用外部 S3 提供商（此时**不要**启用 `selfhosted-minio` profile）。
  自建 MinIO 走 `selfhosted-minio` profile：bucket policy 保持 Phase 1 安全模型
  （public 桶仅匿名下载、private 桶全私有），应用凭据为专用用户并绑定
  least-privilege policy（仅两个业务 bucket 的业务读写，无任何 admin 权限），
  Console(9001)/API(9000) 不发布端口，数据持久卷 `minio_data`。
  **Public asset 交付路径**：浏览器通过 `https://<域名>/assets/<objectKey>`
  （Caddy 只读出口 → `minio:9000/campus-public/*`）访问公开对象；该 route 的
  bucket 前缀固定，private 桶与 MinIO Console/Admin API 不可达，写操作由
  bucket policy 拒绝。详见 deploy/Caddyfile 注释。

### 两个对象存储 URL 的区分（不得混用）

| 变量 | 用途 | 自建 MinIO 时 | 外部 S3 时 |
| --- | --- | --- | --- |
| `S3_ENDPOINT` | 应用后端（服务器侧）访问对象存储 | `http://minio:9000`（backend 网络内） | 提供商 https endpoint |
| `PUBLIC_ASSET_BASE_URL` | 浏览器访问 public object 的公网地址 | `https://<域名>/assets`（Caddy 出口） | 提供商/CDN 的 bucket 级公网 URL |

应用生成公开图片 URL 的唯一来源是 `buildPublicObjectUrl()` =
`PUBLIC_ASSET_BASE_URL/<objectKey>`（src/lib/storage/access-policy.ts）。

### env 与 compose 调用约定（唯一方式）

- 生产 env 唯一来源：项目根 `.env.production`。
- Compose 模型插值（`SITE_ADDRESS`/`POSTGRES_*`/`GIT_SHA` 等）只通过
  `--env-file` 提供；service 级 `env_file:` 仅负责容器环境，不是插值来源。
- 所有脚本统一经由 `scripts/ops/lib.sh` 的 `compose_run`
  （= `docker compose --env-file .env.production -f compose.production.yml`）。
  手工执行时也必须带同样的 `--env-file`：

  ```bash
  docker compose --env-file .env.production -f compose.production.yml <命令>
  ```

- 操作员无需手工 export 任何变量；脚本自行从 `.env.production` 读取。

## 3. 首次部署

1. **准备 env**：
   ```bash
   cp .env.production.example .env.production
   # 逐项填写；POSTGRES_PASSWORD/REDIS_PASSWORD/NEXTAUTH_SECRET 用
   # openssl rand -base64 32 生成
   npx tsx scripts/production-env-check.ts   # preflight，只打印 PASS/FAIL 不输出秘密
   ```
2. **启动数据层**：
   `docker compose --env-file .env.production -f compose.production.yml up -d postgres redis`
3. **对象存储**：外部提供商直接填 env；自建 MinIO（幂等，可重复运行）：
   ```bash
   docker compose --env-file .env.production -f compose.production.yml \
     --profile selfhosted-minio up -d minio
   docker compose --env-file .env.production -f compose.production.yml \
     --profile selfhosted-minio up minio-init
   ```
   minio-init 会：建 public/private 桶 → Phase 1 匿名策略（public 仅下载 /
   private 全私有）→ 创建应用专用用户 → 绑定 least-privilege policy
   （仅两个业务桶业务读写，无 admin 权限）。
   轮换 `S3_SECRET_ACCESS_KEY` 后需同步更新 MinIO 用户：
   `mc admin user add local <S3_ACCESS_KEY_ID> <新secret>`（用 root 凭据执行）。
4. **迁移**（一次性容器，禁止 `migrate dev` / `db push`）：
   ```bash
   GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env.production \
     -f compose.production.yml --profile ops run --rm migrate
   ```
5. **构建并启动全栈**：
   ```bash
   GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env.production \
     -f compose.production.yml --profile ops up -d --build
   ```
6. **验证**：`curl https://<域名>/api/health` → `{"status":"ok","release":"<sha>",...}`，
   release 必须等于部署 SHA。

日常部署直接用封装脚本：`./scripts/ops/deploy.sh`（= preflight → 备份 → 迁移 →
滚动更新 → health/release 验证 → 写 release 日志）。

## 4. TLS / 证书

- 使用正式域名时 Caddy 自动 ACME 签发并续期（Let's Encrypt），证书存于
  `caddy_data` 卷；验证：`openssl s_client -connect <域名>:443 -servername <域名>`。
- DNS 未生效或暂无域名时，TLS 无法签发（`TLS_NOT_EXECUTED_EXTERNAL_DOMAIN_REQUIRED`）；
  不得以 self-signed 冒充正式 HTTPS。
- 80 端口仅用于 HTTP→HTTPS 重定向（Caddy 默认行为）。

## 5. 服务管理

```bash
COMPOSE="docker compose --env-file .env.production -f compose.production.yml"
$COMPOSE ps                 # status（含 healthcheck）
$COMPOSE logs -f app        # 应用日志（tailing）
$COMPOSE restart app        # 重启单个服务
$COMPOSE up -d --no-deps --wait app   # 更新 app 后等待 healthy
$COMPOSE stop && $COMPOSE up -d       # 停机/恢复
```

所有服务 `restart: unless-stopped`：Docker daemon 随主机启动后自动拉起全部服务，
应用不依赖人工 SSH 启动。重启顺序测试（app/proxy/postgres/redis）见
docs/PRODUCTION_SECURITY.md 第 6 节。

## 6. 迁移纪律

- 生产只允许 `prisma migrate deploy`（`compose.production.yml` 的 `migrate`
  一次性服务，target `migrator`）。禁止 `migrate dev`、`db push`、任何 reset。
- 每次部署前自动备份（deploy.sh step 3）；迁移后必须二次执行显示
  `No pending migrations` 才算迁移验证通过。
- 迁移必须向前兼容（新增列带默认值、先加列后删列等），以支持不回滚 schema 的
  应用回滚（见 ROLLBACK.md）。

## 7. 升级 / 日常部署

```bash
git fetch && git checkout <release_sha>   # 在服务器上的代码副本
./scripts/ops/deploy.sh                   # 全流程（含备份/迁移/验证）
cat .releases.log                         # 部署历史（RELEASE_SHA/IMAGE/时间）
```

## 8. 磁盘空间

- `docker system df` 查看占用；定期 `docker image prune -f` 清理悬空镜像
  （保留最近 2–3 个 `campus-marketplace-app:<sha>` 用于回滚）。
- Postgres 卷膨胀：`VACUUM` 由 autovacuum 处理；磁盘告警阈值建议 80%。
- 备份目录 retention 自动清理（`BACKUP_RETENTION_DAYS`，默认 14 天），
  异地备份见 BACKUP_RESTORE.md。

## 9. 中国大陆部署前置条件（EXTERNAL_COMPLIANCE_PREREQUISITE）

若服务器位于中国大陆并使用正式域名，上线前需核实（属法务/合规范畴，
代码侧无法替代）：ICP 备案/许可、公安联网备案、域名实名认证、云厂商接入要求。
备案是否完成必须以真实凭证为准，未完成时分类为外部合规前置条件，不阻塞仓库侧验收。

## 10. 端口红线（绝不对公网开放）

| 端口 | 服务 | 原因 |
| --- | --- | --- |
| 3000 | Next.js | 绕过反代会失去 TLS/限流头处理 |
| 5432 | PostgreSQL | 数据库裸公网 = 直连攻击面 |
| 6379 | Redis | 限流存储，未授权访问可刷写键 |
| 9000/9001 | MinIO API/Console | 对象存储控制面 |
| 22 | SSH | 仅管理需要，建议限源 IP/VPN |

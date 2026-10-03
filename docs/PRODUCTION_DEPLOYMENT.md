# 生产部署（Production Deployment）

> **阶段状态**：本文档描述的能力属于 **Production Phase 3A — Production Deployment Foundation**
> （`REPO_SIDE_ACCEPTED = YES`）。真实服务器/域名/DNS/生产 TLS 等外部执行项属于
> **Production Phase 3B — Real Production Deployment**（`DEFERRED`，硬门禁清单见
> [MASTER_ROADMAP.md](MASTER_ROADMAP.md) §4（Phase 3A / 3B Boundary）与 docs/TODO.md）。正式公网上线前必须完成 3B：
> `PRODUCTION_LAUNCH_BLOCKED = TRUE`。
>
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
              ▲
              │  周期幂等清理（仅 backend 网络，无端口）
     storage-cleanup（常驻单实例 worker，Dockerfile target cleanup-runner）
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
7. **统一运维检查**（部署后一次性验证 env 契约/依赖连通性/备份健康/release
   identity 六项，LAUNCH_REHEARSAL_REPAIR R1 起为唯一 canonical 生产命令）：
   ```bash
   GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env.production \
     -f compose.production.yml --profile ops run --rm --no-deps --build ops-check
   ```
   `--no-deps` 为诊断合同（OBSERVE ONLY：不启动/修复被观察依赖）。
   前提：`BACKUP_DIR` 已配置（宿主机绝对路径；该目录被 ops-check 只读挂载）
   且已有一次成功备份；生产合同要求 `BACKUP_OFFSITE_TARGET` 异地副本成功，
   未配置时 `backup_health` FAIL 属 Phase 3B 设计语义。详见
   [OBSERVABILITY.md §7](./OBSERVABILITY.md#7-统一运维检查)。

日常部署直接用封装脚本：`./scripts/ops/deploy.sh`（= preflight → 备份 → 迁移 →
滚动更新 → RELEASE READINESS GATE → 写 release 日志）。deploy.sh 与 rollback.sh
的 SUCCESS 都必须通过统一发布门禁
`scripts/ops/release-readiness-check.ts`（见 §3.1），仅 verifier PASS 才写
`.releases.log`（记录 `READINESS=ready`，不含 dependency URLs/credentials/bucket names）。

### 3.1 健康语义与发布门禁（RB-06）

三个概念严格区分，不得混用：

| 概念 | 载体 | 语义 |
| --- | --- | --- |
| `GET /api/health` | liveness | 只证明 Next.js 进程存活 + release identity。**不访问** PostgreSQL/Redis/S3；依赖 outage 时不影响容器健康判定 |
| `GET /api/ready` | runtime readiness | 当前实例的依赖状态：DB/storage 失败 → `not_ready`（503）；Redis 失败 → `degraded`（**仍 200**，运行时 availability policy：限流有本地降级，可继续接流量） |
| RELEASE READINESS GATE | deploy/rollback SUCCESS | `scripts/ops/release-readiness-check.ts`（deploy 与 rollback 共用的唯一权威 verifier） |

**Docker HEALTHCHECK 故意仍指向 `/api/health`（liveness）**：若 DB/Redis/S3 暂时
故障就把正常运行的 app 容器标成 unhealthy，会制造 restart storm。
`CONTAINER_HEALTH = LIVENESS`、`RELEASE_SUCCESS = READINESS`，两者不是同一概念。

**发布门禁契约（fail closed）**——deploy/rollback 只有全部满足才 SUCCESS：

1. `/api/health`：HTTP 2xx、`status=ok`、`release == EXPECTED_SHA`；
2. `/api/ready`：响应可解析（JSON.parse + 结构校验，禁止 grep/sed）、
   `release == EXPECTED_SHA`、`status === "ready"`、
   `dependencies.database/redis/storage` 全部 `"ok"`。

关键区分：`/api/ready` 返回 **HTTP 200 + `degraded` 仍然 FAIL release gate**
（运行中服务可继续接流量 ≠ 新 release 可被认证为健康）。
EXPECTED_SHA 必须是 40 位 hex Git commit SHA（`unknown`/`dev`/短 SHA/分支名
在进入任何网络验证前即被拒绝）。verifier 有 bounded polling（默认 3s 间隔 /
120s deadline）；连接拒绝等瞬时错误重试到 deadline，超时 exit 1。
失败输出只含 reason code、HTTP 状态与 release 标识，绝不输出 secrets、
dependency 异常细节或 bucket 名称。

**Source artifact identity（deploy STEP 0，RB-06 FINAL）**：release SHA 不是
operator label。deploy.sh 在任何生产副作用（env preflight / build / backup /
migration / app switch / gate）之前 hard verify：

- 入参（若显式给出）本身已是 40-hex——禁止截断任意输入后再接受
  （`INVALID_EXPECTED_SHA`）；
- 当前 checkout HEAD 可解析为 40-hex（`RELEASE_SOURCE_HEAD_UNRESOLVED`）；
- 显式入参（normalize 小写）必须等于 HEAD，否则 `RELEASE_SOURCE_SHA_MISMATCH`
  ——远端 endpoint 自报的 release 不能覆盖本地 artifact identity mismatch；
- `git rev-parse --verify <SHA>^{commit}` 成功（`RELEASE_SOURCE_COMMIT_NOT_FOUND`）；
- `git status --porcelain` 为空（tracked/staged 修改或 untracked
  build-context 文件都会被 `COPY .` 带入镜像 → `RELEASE_SOURCE_TREE_DIRTY`；
  `.env.production`/`.releases.log` 等由 `.gitignore` 管理，不进 porcelain，
  不做手工 allowlist）。

完整 release identity chain（§30），任何一环不同即 DEPLOY FAIL：

```
git committed tree == clean checkout HEAD == GIT_SHA build arg
  == image tag == runtime RELEASE_SHA == health.release == ready.release
```

**Docker build context provenance（RB-06 FINAL-03）**：clean worktree 本身
不足以保证 artifact identity —— git ignored 文件不出现在 `git status
--porcelain`，但会被 `COPY . .` 从 build context 带入镜像。因此
`.dockerignore` 与 `.gitignore` 的本地/运行时产物对齐（`public/uploads/*`
运行时上传、`next-env.d.ts`、`*.log`、`prisma/dev.db`、`/*.png`、`*.pem`、
`.vercel`、`.playwright-mcp`、`.tmp-test-uploads` 等；tracked placeholder
资产经 negation 保留），使 **Docker build input 是 committed git tree 的
确定性投影**：

```
committed git tree + clean worktree + dockerignore 全量本地/运行时排除
  == deterministic docker context
```

静态 gate：`tests/ops/docker-context-provenance.test.ts`（冻结关键
pattern + placeholder negation）；真实 canary probe（`tests/ops/
docker-context-probe.Dockerfile`，FROM scratch + COPY，`docker export`
列举 context）验证 ignored 本地文件（含 `public/uploads` 运行时内容）不进
context、tracked placeholder 不缺席。部署主机遗留上传文件的
inventory/quarantine 属既有 operational debt（BACKLOG
AUDIT_DEBT_LEGACY_UPLOADS_PUBLIC_DIR），本机制仅保证它们不进镜像。

`deploy.sh <sha>` 因此只起 "assert expected checkout" 作用。运维步骤
`git checkout <release_sha>` 只是操作说明；deploy.sh 自身仍会 hard verify。
rollback 不重新构建 source，不要求 PREVIOUS_SHA == HEAD，但同样在任何 side
effect 之前校验 40-hex 并禁止截断。

生产 deploy/rollback 脚本不存在任何 verifier env override（`OPS_RELEASE_VERIFIER`
类 test seam 已移除，静态 gate 见 `tests/ops/ops-scripts.test.ts`）：
deploy 与 rollback 的 SUCCESS 判定只能出自
`scripts/ops/release-readiness-check.ts`。`OPS_HEALTH_TIMEOUT` 仅允许在脚本内
把等待预算调整为正整数（非法值回默认），不能把失败变成功。

门禁失败时 deploy.sh 不写 release log，打印 rollback 命令参考后 exit 1；
**不自动回滚**（自动回滚存在 schema compatibility 风险，由操作员执行
`scripts/ops/rollback.sh <previous_git_sha>`）。

### 3.2 MinIO/mc 镜像不可变 pin 与更新流程

`compose.production.yml`（官方 upstream `minio/minio`、`minio/mc`）与
`.github/workflows/ci.yml`（GHCR mirror `ghcr.io/ljjnb666-nb/*`）中的镜像一律
`@sha256:<digest>` immutable pin，**禁止 `:latest` / floating tag**
（静态 gate：`tests/ops/image-immutability.test.ts`）。不新增自动同步 latest
的 workflow。镜像更新必须走显式流程：

1. 选择明确的上游版本（官方 release）；
2. 验证官方来源（minio/minio、minio/mc 官方仓库）；
3. authenticated pull 该版本镜像；
4. `docker inspect --format '{{index .RepoDigests 0}}'` 取得真实 digest
   （**禁止猜 digest**；无法从真实 registry 获得时停止并报告）；
5. 更新 CI mirror / production compose 的 digest（CI 与生产 pin 同一官方构建）；
6. 跑 full CI（含 MinIO 启动、mc bootstrap、真实 S3 集成测试）；
7. PR review 后合并。

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
$COMPOSE logs -f storage-cleanup   # 存储清理 worker 日志
$COMPOSE restart app        # 重启单个服务
$COMPOSE up -d --no-deps --wait app   # 更新 app 后等待 healthy
$COMPOSE stop && $COMPOSE up -d       # 停机/恢复
```

所有服务 `restart: unless-stopped`：Docker daemon 随主机启动后自动拉起全部服务，
应用不依赖人工 SSH 启动。重启顺序测试（app/proxy/postgres/redis）见
docs/PRODUCTION_SECURITY.md 第 6 节。

### 5.1 存储清理 worker（storage-cleanup）

`storage-cleanup` 是常驻单实例后台服务（Dockerfile target `cleanup-runner`，
仅 backend 网络、无端口发布、与 app 共用 `.env.production`），周期执行幂等的
`runStorageCleanup`：stale UPLOADING / 超 UPLOADED 孤儿 / 保留期到期 /
PENDING_DELETE 重试（语义见 [STORAGE.md §10](./STORAGE.md)）。

- **deploy 接线（FINAL REPAIR B release lifecycle）**：`deploy.sh` 构建
  release artifact set（`app migrate storage-cleanup`，同一 `GIT_SHA`），
  在 migrate 完成后切换 worker（绝不在 pre-migration schema 上运行新 worker），
  并逐一验证：resolved image == `campus-marketplace-cleanup:<GIT_SHA>` →
  启动 → compose authoritative running 状态 → 运行容器 exact image →
  `--run-once --dry-run` 无副作用 runtime smoke。任何一步失败 → 部署失败、
  不写 release log。`.releases.log` 记录 artifact pair：
  `APP_IMAGE=... CLEANUP_IMAGE=... CLEANUP=running`。
- 周期：`ASSET_CLEANUP_INTERVAL_SECONDS`（默认 1800；**生产下限 60**，
  production-env-check preflight 与 worker 同一契约校验，非法配置以非零
  退出交由 restart policy）。空转周期不输出日志；产生实际工作（删除/标记/
  失败）时输出 `storage_cleanup_cycle_completed` summary。
- **Readiness 解耦**：cleanup backlog 是后台恢复，不是接流量依赖——
  `/api/ready` 仍只看 DB/Redis/Storage（`VERIFIED_AUTOMATIC`，
  见 STORAGE.md §10.1）。
- 手动 escape hatch（incident response，无需宿主机 node_modules）：

```bash
COMPOSE="docker compose --env-file .env.production -f compose.production.yml"
# 立即执行一轮真实清理后退出
$COMPOSE run --rm storage-cleanup --run-once
# 只打印清理计划，不执行任何删除/转移
$COMPOSE run --rm storage-cleanup --run-once --dry-run
```

### 5.2 生产数据库恢复的 writer quiesce（restore）

`restore-production-postgres.sh` 覆盖生产库前必须停止**全部 production DB
writers**（app + storage-cleanup）并逐一验证已停止。语义全部 fail closed——
**writer 状态未知 ≠ writer 已停止**：`compose ps` 命令失败（无论发现阶段还是
停止后验证阶段）都直接失败，绝不把命令失败解释成"无容器/已停止"；容器不存在 =
无该 writer（pre-worker release 兼容）；停止命令失败或停止后仍在 running →
FAIL CLOSED，绝不执行 terminate/DROP/restore。失败消息区分两个阶段：quiesce
完成前失败只声明"未执行任何破坏性恢复操作"（不声称 writers 已停止）；quiesce
成功后的失败才声明"production writers 保持停止"。恢复后（无论成败）writers
状态由操作员按目标 release topology 恢复：post-worker release 启动
app + storage-cleanup；pre-worker 目标仅启动 app（cleanup 保持停止）。
`rollback.sh --hard` 会自动按该 policy 切换。

## 6. 迁移纪律

- 生产只允许 `prisma migrate deploy`（`compose.production.yml` 的 `migrate`
  一次性服务，target `migrator`）。禁止 `migrate dev`、`db push`、任何 reset。
- 每次部署前自动备份（deploy.sh step 3）；迁移后必须二次执行显示
  `No pending migrations` 才算迁移验证通过。
- 迁移必须向前兼容（新增列带默认值、先加列后删列等），以支持不回滚 schema 的
  应用回滚（见 ROLLBACK.md）。

## 7. 升级 / 日常部署

```bash
git fetch && git checkout <release_sha>   # 在服务器上的代码副本（clean worktree）
./scripts/ops/deploy.sh [<release_sha>]   # 全流程（含备份/迁移/发布门禁）；
                                          # 显式 SHA 只起 assert expected checkout 作用
cat .releases.log                         # 部署历史（RELEASE_SHA/IMAGE/READINESS=ready）
```

升级/回滚 SUCCESS 均以 RELEASE READINESS GATE（§3.1）为准；worktree 必须 clean
（deploy STEP 0 hard verify，dirty → `RELEASE_SOURCE_TREE_DIRTY`）；回滚见
[ROLLBACK.md](./ROLLBACK.md)。

## 8. 磁盘空间

- `docker system df` 查看占用；定期 `docker image prune -f` 清理悬空镜像。
  **release artifact pair 成对保留**：每个 release 由
  `campus-marketplace-app:<sha>` 与 `campus-marketplace-cleanup:<sha>` 组成，
  最近 2–3 个 release 的两个镜像都需保留（回滚必须成对切换，见 ROLLBACK.md；
  rollback 前置检查 `docker images 'campus-marketplace-app'` 与
  `docker images 'campus-marketplace-cleanup'`）。
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

## 11. Transactional Email 配置（Phase 9B）

email 投递复用现有 `async-worker` 服务（禁止新增 email-worker 容器）——
NOTIFICATION_DELIVERY job 与既有 job 同一 claim/lease/backoff/dead-letter
机制，继续受 immutable release SHA 保护。

`.env.production` 必须包含（`npm run env:check` fail-closed 校验，缺失/
非法拒绝部署）：

```text
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxx            # Resend 控制台创建；绝不提交真实值入仓
EMAIL_FROM=noreply@<已验证域名>   # 域名需在 Resend 完成 SPF/DKIM 验证
EMAIL_REPLY_TO=                  # 可选
EMAIL_PROVIDER_TIMEOUT_MS=10000  # 1000..30000
RESEND_API_BASE_URL=             # 生产禁止设置（固定 https://api.resend.com）
```

部署后验证：

1. `npm run env:check` 全部 PASS（只打印变量名，不输出秘密值）。
2. 触发一条双渠道通知（如 PRODUCT 预留过期）：`async-worker` 日志出现
   `email_delivery_attempted` / `email_delivery_provider_accepted`；
   NotificationDelivery 行 `providerAcceptedAt` 非空且
   `providerMessageId` 非空。
3. 失败排查：dead-letter 查询见 `src/lib/notifications/email-ops.ts`
   （dead-lettered email deliveries / oldest pending email /
   provider-accepted count，read-only）。`lastErrorCode` 为受控机器码
   （EMAIL_PROVIDER_AUTH_FAILED = key/域名问题；EMAIL_PROVIDER_TIMEOUT =
   网络问题会自动重试）。

红线：生产不得覆盖 `RESEND_API_BASE_URL`（防 SSRF/secret exfil）；
CI 永不发起真实 Resend 调用（真实 provider 验证属 Phase 3B）。

## 12. Errand deadline 定时到期（Phase 9C-02）

跑腿任务 deadline 到期的 materialization 复用 `async-worker` 服务（不新增
容器/队列）。worker 每个 cycle 的顺序：

```
schedule due domain intents（errand deadline discovery）
  → claim due jobs → execute（canonical domain lifecycle）
  → claim outbox events → dispatch
```

契约要点（SSOT 见 `src/lib/async/errand-deadline-scheduler.ts` 与
`src/lib/async/job-types.ts`）：

- AsyncJob kind registry 新增 `ERRAND_DEADLINE_EXPIRE@1`，payload 只允许
  `{ errandId }`（strict，未知键拒绝落库）；dedupeKey =
  `ERRAND_DEADLINE_EXPIRE:<errandId>`——一个 Errand 生命周期至多一个
  expiry intent，任何状态（PENDING/RETRY/RUNNING/COMPLETED/DEAD_LETTER）
  的既有 job 都会被 scheduler discovery 的 anti-join 排除，绝不复制
  （DEAD_LETTER 走既有 requeue seam）。
- public correctness 不依赖 scheduler latency：deadline 过期的任务在
  公开列表/首页/搜索/推荐/收藏/陌生详情即时消失（query-time
  `OPEN + deadline > now`，`errandPublicExposureFilter` 唯一口径）；
  scheduler 只负责最终把 DB 行 materialize 成 CANCELLED。
- 过期 materialize = OPEN → CANCELLED（不新增 EXPIRED enum）；deadline
  不自动终止既有 CLAIMED/IN_PROGRESS 履约义务；过期任务禁止通过编辑
  deadline 或 CLAIMED→OPEN 撤单复活（锁内 fresh 判定）。
- Recurrence 冻结原则：recurrence 属 scheduler producer / worker cycle；
  AsyncJob 永远是一次性 durable intent。禁止"永久存在的 sweep job +
  无限 RESCHEDULE 同一行"（attempts = 实际 claim 次数且 RESCHEDULE 不
  重置，会污染 attempts/maxAttempts 语义）；RESCHEDULE 仅允许用于
  one-shot intent 的 NOT_DUE stale-schedule 防御。未来若需要周期性业务
  tick，必须 new job per deterministic time bucket。
- 运维验证：`async-worker --run-once` 单次 invocation 即可完成
  discovery → enqueue → claim → CANCELLED（结构化日志事件
  `errand_deadline_scheduler_cycle`，只含 IDs/counts）。

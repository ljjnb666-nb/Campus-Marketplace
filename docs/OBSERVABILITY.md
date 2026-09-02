# 可观测性契约（Observability Contract）

> Phase 4（Observability / Monitoring / Recovery Foundation）建立的 repo-side 运维基础。
> 状态：`IMPLEMENTED / PENDING_INDEPENDENT_REVIEW`（Phase 3B 仍 DEFERRED，
> `PRODUCTION_LAUNCH_BLOCKED = TRUE`——本文件描述的是**仓库侧能力**，
> 不代表真实公网监控已上线）。

目标：把应用部署到任意 Linux + Docker 环境后，无需额外采购，即可回答：

- 系统是不是活着（liveness）
- 系统能不能正常接流量（readiness）
- 哪个依赖坏了（dependency health）
- 哪个请求出了错（request correlation）
- 哪个 release 出问题（release identity）
- backup 是否过期、restore 是否还能工作（backup freshness / drill）
- 什么情况应该告警（ALERTING.md）
- 故障发生后怎么处理（INCIDENT_RESPONSE.md）

---

## 1. Request / Correlation ID

| 层 | 实现 |
| --- | --- |
| Edge 入口 | `src/proxy.ts`（Next 16 proxy 约定）校验/生成 `x-request-id`，回写响应头 + 透传 server runtime |
| 格式契约 | `src/lib/request-id.ts`：白名单 `^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$`，非法即重新生成（防 header 注入/超长/恶意形态；ID 天然不含 email/userId/IP/cookie/token） |
| 服务端日志关联 | `src/lib/request-context.ts`：Node runtime 以 `AsyncLocalStorage` 承载 requestId，`logger` 自动附带 |
| 路由接入 | `/api/health`、`/api/ready`、`/api/internal/metrics` 已包裹 `withApiRequestContext`；其他路由渐进采用（非破坏性） |

客户端可用合法 `X-Request-ID` 传入实现跨服务链路追踪；任何不符合格式契约的值都会被丢弃重生成，绝不回显。

## 2. 结构化日志

`src/lib/logger.ts`：单行机器可解析 JSON。标准字段：

```text
timestamp  level  message  service  environment  release  requestId  context
```

- `service` ← `APP_NAME`（默认 campus-marketplace）；`release` ← `RELEASE_SHA`（默认 dev）
- `context` = operation（来源模块/请求场景）；业务字段以 extra 附加
  （`orderId`/`conversationId`/`durationMs`/`statusCode`…，最小必要原则）
- Level 覆盖：`LOG_LEVEL` 环境变量（debug|info|warn|error）；未设置时
  开发环境 debug、其他 info

### Log level policy

| 级别 | 语义 | 例子 |
| --- | --- | --- |
| DEBUG | 开发排障细节，生产默认关闭 | 中间处理步骤 |
| INFO | 正常业务里程碑、readiness 非 ready 报告 | 订单创建、server 启动 |
| WARN | 可自动恢复的降级 / 需要关注的预期外状态 | Redis 降级本地限流、4xx 业务错误聚合 |
| ERROR | 服务端自身故障，需要运维关注 | DB 不可达、S3 不可达、未处理异常 |

**用户可预期的业务错误（401/403/404/409/429）不是 error 级事件**；只有
基础设施故障与未处理异常才是（见 §3 分类）。

### Redaction（出口统一脱敏）

不依赖开发者"记得不打印"——`logger` 出口统一擦除：

- 键名命中敏感模式（password/secret/token/authorization/cookie/credential/
  api key/access key/session/presigned/x-amz/database url/redis url…）→ `[REDACTED]`
- 字符串值中的秘密形态：`Bearer …`、`X-Amz-Signature=`/`X-Amz-Credential=`、
  URL 内嵌密码（postgres/redis/mysql…）、`aws_secret_access_key=` 行
- 嵌套对象/数组递归（深度上限）、超长字符串截断、Error 序列化后同样过 redaction
- extra 中的保留键（message/level/…）改名 `x_*`，不覆盖标准字段

禁止直接输出（redaction 之外，代码层也不允许）：完整 request body、完整
FormData、私有对象内容、objectKey 明文、校园认证原图/租赁交接证据/举报证据。

## 3. 错误分类（运维视角）

`src/lib/error-taxonomy.ts`：`VALIDATION / AUTHENTICATION / AUTHORIZATION /
NOT_FOUND / CONFLICT / RATE_LIMIT / DEPENDENCY / DATABASE / CACHE / STORAGE / INTERNAL`。

- 业务错误体系不变（ZodError/AssetServiceError/handleError 仍是用户消息的来源）；
- 分类只回答运维三问：category、logLevel、`isServerFault`（是否计入
  `unexpected_server_errors_total`）
- `handleError`（server action/route 兜底入口）已集成：server fault 日志附带
  `event=server_error_classified` + category + requestId；预期业务错误维持不刷日志

## 4. Liveness vs Readiness

| | `/api/health`（liveness） | `/api/ready`（readiness） |
| --- | --- | --- |
| 问题 | 进程活着吗 | 当前实例能接正常业务流量吗 |
| 检查 | **无依赖访问**（handler 能执行即 200） | PostgreSQL + Redis + Storage 并行探测 |
| 速度 | 快、无副作用 | 每依赖独立 timeout（默认 2s，总预算 ≤5s 量级），bounded |
| 失败 | handler 挂了才会有非 200 | 503 `{"status":"not_ready", dependencies:{...}}` |
| 响应契约 | `{status, release, timestamp}`（不可变更：deploy.sh/HEALTHCHECK/Playwright 依赖） | `{status: ready|degraded|not_ready, release, dependencies}`，只含高层状态 |

> BLOCKER 2 修正：`/api/health` 是**真 liveness**——不访问 PostgreSQL/Redis/S3，
> 无副作用。DB outage 不再导致 app 容器被 Docker HEALTHCHECK 误判 unhealthy
> （HEALTHCHECK 只证明 app 进程存活）；依赖级健康完全由 `/api/ready` 表达。
> 故障演练（observability-drill）以黑盒方式证明：PostgreSQL 停机时
> `/api/health` 仍 200、`/api/ready` 变 503 not_ready、恢复后回到 ready。

Readiness 探测方式（无副作用）：

- database：`SELECT 1`（复用 `pingDatabase()`）
- redis：`PING`（复用 rate-limit 的共享 ioredis 客户端）
- storage：`HeadBucket`（bucket 元数据；**禁止**上传测试对象）

### REDIS_READINESS_POLICY

**Redis 故障 → `degraded`，仍返回 200 接流量。** 依据：

- 业务对 Redis 的唯一消费方是限流计数（`src/lib/rate-limit.ts`）
- Redis 故障时已有进程内本地固定窗口降级（可用性优先，已上线能力）
- 降级削弱的能力：跨实例共享计数精确性（多实例部署时各实例独立计数，
  阈值近似 N×limit）；单实例语义不变
- 触发信号：`/api/ready` dependencies.redis=degraded、
  `dependency_readiness_failures_total{dependency="redis"}`、WARN 级
  `dependency_health_failed` 事件
- 未配置 `REDIS_URL`（本地限流模式）= 无依赖可失败，redis 报 ok

database/storage 故障 → `not_ready`（503）：无 DB 无法服务任何业务；
上传与私有资产同源交付是核心能力，存储不可达即不可接流量。

### 依赖失败事件（不刷屏）

正常探测**零日志**；失败时每依赖一条结构化事件（经 logger redaction，
不输出 connection string/endpoint 凭据）：

```json
{"event":"dependency_health_failed","dependency":"database","status":"failed","durationMs":12,"requestId":"..."}
```

并计入 `dependency_readiness_failures_total{dependency=...}`。

## 5. Metrics foundation（vendor-neutral）

`src/lib/metrics.ts`：进程内 registry + Prometheus 文本渲染（无第三方依赖，
未绑定任何付费厂商；未来可被任意 Prometheus 兼容采集器抓取）。

标准指标（label 白名单：route family/method/status_class/dependency/category/outcome）：

```text
http_requests_total                     {route, method, status_class}
http_errors_total                       {route, method, status_class}
http_request_duration_ms (histogram)    {route}
dependency_readiness_failures_total     {dependency}
unexpected_server_errors_total          {category}
```

基数控制（METRIC_CARDINALITY_TEST 强制）：

- label 键白名单 + 值形态校验（非法即抛错，而非静默接受）
- 路径折叠为 route family：`/api/assets/<id>/content` → `/api/assets/:id/content`
- 绝不使用 userId/email/productId/orderId/arbitrary URL 作为 label

端点：`/api/internal/metrics`（Prometheus 文本格式）。

- **默认关闭**：未配置 `METRICS_BEARER_TOKEN` → 404（无裸露默认面）
- **HTTP 指标是 runtime-fed（BLOCKER 3B）**：`withHttpMetrics` wrapper 接入
  全部自营 API route handlers（Next 16 的 proxy 与 Node runtime 隔离，
  因此计数点在 Node 侧、与 metrics 读取端同进程——真实请求驱动计数，
  黑盒 Playwright 测试 `http-metrics.spec.ts` 在 production build 上验证
  http_requests_total / http_request_duration_ms / http_errors_total 真实增长）
- **token 安全契约由代码强制（BLOCKER 3）**：`src/lib/metrics-token.ts` 是
  唯一裁决点，production-env-check（preflight）与端点（运行时 fail-closed）
  共用同一规则：未设置=关闭（允许）；设置则必须 ≥24 字符、不命中危险
  默认值/placeholder、**不得复用 NEXTAUTH_SECRET**——违反时端点保持 404
  并记录结构化配置错误（只记 reason 枚举，绝不记录值）

## 6. Backup freshness

`backup-postgres.sh` 每次执行（无论成败）写 `${BACKUP_DIR}/backup-status.json`：

```json
{"status":"success|failed","completedAt":"...","filename":"...","checksumVerified":true,"offsiteStatus":"success|not_configured|failed","stage":"..."}
```

- 只含非敏感 metadata；写状态失败不影响备份真实退出码（trap + best effort）
- `checksumVerified=true` **确实经过校验**（BLOCKER 4）：脚本写入 `.sha256`
  后必须执行 `sha256sum --check` 重新读取 dump 全量验证，通过才置 true
- trap 在 BACKUP_DIR 可用后立即注册（BLOCKER 4B）：其后任何前置配置失败
  （如 POSTGRES_USER 缺失）都会留下 `status=failed` 状态产物（stage 明确）
- 检查器 `npm run ops:backup-health`（`scripts/ops/backup-health-check.ts`）：
  - 阈值 `BACKUP_MAX_AGE_HOURS` 可配置（默认 26）
  - **不盲信状态布尔**：真实验证 dump 文件与 `.sha256` 仍存在，且流式重算
    dump 的 SHA256 与 checksum 一致（发现"备份后损坏/篡改"）
  - production 模式 fail-closed；development 模式只报告事实（`--strict` 可升级）
  - `offsiteStatus=not_configured` → 本地备份 healthy 但 `productionBackupReady=false`
    （Phase 3B DEFERRED：不宣称生产备份已就绪）

## 7. 统一运维检查

```bash
npm run ops:check        # scripts/ops/ops-check.ts [--mode production|development|ci]
```

检查项：environment contract（production 强制）、database/redis/storage 连通性
（bounded 4s）、backup health、release identity。输出逐行 JSON + 汇总
`{"result":"PASS|FAIL"}`；必需检查失败 → exit 1（fail-closed，绝不
swallow / 绝不失败后打印 PASS）。

Production 无 bypass（BLOCKER 1/1B）：

- `--mode production --skip-connectivity` → 直接 FAIL
  （`reason=PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED`，exit 1）；
  connectivity 只能跳过于 development/CI
- production 下 `productionBackupReady !== true`（如 offsite not_configured）
  → `backup_health` FAIL（`PRODUCTION_BACKUP_NOT_READY`）→ 整体 FAIL

| mode | env 契约 | 连通性 | 生产备份 | RELEASE_SHA |
| --- | --- | --- | --- | --- |
| development | skipped | 已配置则检查 | 报告事实，不阻断 | 可选 |
| ci | skipped | 同 development | 同上 | 可选 |
| production | 强制 | 强制（不可 skip） | 强制（productionBackupReady 必须 true） | 必须 |

## 8. Error UI / boundary

- `src/app/error.tsx`：路由级错误 UI + `digest` 参考编号展示（安全随机标识，
  便于用户反馈对账；不含个人数据）
- `src/app/global-error.tsx`：root layout 级最后防线（通用提示 + digest + 重试）
- 用户永远看不到 stack/SQL/内部路径/凭据/原始异常；服务端记录脱敏结构化错误

## 9. 故障演练

```bash
npm run ops:observability-drill   # scripts/ops/observability-drill.sh
```

本地可重复的 OBSERVABILITY_FAILURE_DRILL：真实停掉 PostgreSQL → 验证
readiness 变 not_ready、无秘密泄漏、失败事件与指标产生 → 恢复 → readiness
回到 healthy。自动 cleanup，不留 broken 环境。详见 `docs/INCIDENT_RESPONSE.md`。

## 10. 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `RELEASE_SHA` | 生产必须 | release identity（部署注入） |
| `APP_NAME` | 否 | 日志 service 字段 |
| `LOG_LEVEL` | 否 | 日志级别覆盖（debug/info/warn/error） |
| `METRICS_BEARER_TOKEN` | 否 | metrics 端点开关+访问凭据（未设置=端点关闭） |
| `BACKUP_MAX_AGE_HOURS` | 否 | 备份新鲜度阈值（默认 26） |

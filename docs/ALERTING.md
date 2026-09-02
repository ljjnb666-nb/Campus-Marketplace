# 告警规则定义（Alerting Rules）

> Phase 4 repo-side 规则定义。**当前没有真实告警渠道接入**（Phase 3B
> DEFERRED：无生产服务器/域名，未配置 PagerDuty/钉钉/飞书/Slack 等）。
> 本文档是将来接入任何通知渠道时的规则契约（signal → threshold →
> severity → initial action → runbook），不声称真实 alerts 已经发送。
> 状态：`IMPLEMENTED / PENDING_INDEPENDENT_REVIEW`。

信号来源：`/api/health`、`/api/ready`、`/api/internal/metrics`（需
METRICS_BEARER_TOKEN）、结构化日志（`docker compose logs app` 或日志采集器）、
`backup-status.json`、`npm run ops:check`。

原则：

- **窗口/持续时间/比例优先，杜绝单点误报**（例：单个 HTTP 500 不触发任何告警）
- 每条规则标注处置入口：`docs/INCIDENT_RESPONSE.md` 对应场景章节

---

## P0 / Critical（立即响应，用户面已受损或数据面临风险）

### P0-1 应用完全不可用

- signal：`/api/health` 连续失败（非 200）。注意 `/api/health` 是**真 liveness**
  （不访问任何依赖）：它失败 = app 进程/容器层面故障，而非依赖故障
  （依赖故障走 P0-2/P1-5 的 readiness 信号）
- threshold/window：连续 ≥3 次探测失败、间隔 30s（≈90s 完全不可用）
- severity：P0
- initial action：`docker compose ps` 确认 app/caddy 状态；查 app 日志最近 ERROR
- runbook：INCIDENT_RESPONSE.md §场景 1 / 场景 7-8（bad release → rollback）

### P0-2 PostgreSQL 不可用

- signal：`/api/ready` dependencies.database=failed（503）；`dependency_readiness_failures_total{dependency="database"}` 持续增长
- threshold/window：≥2 分钟持续（排除瞬时抖动/滚动重启）
- severity：P0（DB 是所有业务的前置）
- initial action：`docker compose ps postgres`；`docker compose logs postgres --tail 100`；磁盘是否满
- runbook：INCIDENT_RESPONSE.md §场景 2

### P0-3 恢复不可能（restore 不可用）

- signal：restore drill 失败（手动演练或 restore-drill.sh FAIL）
- threshold/window：任一次 drill 失败即为 P0（备份是最后防线）
- severity：P0
- initial action：立即按 docs/BACKUP_RESTORE.md 排查 dump 完整性/sha256/pg 版本
- runbook：INCIDENT_RESPONSE.md §场景 5

### P0-4 数据损坏嫌疑

- signal：业务侧持续 5xx + 数据异常报告；或 pg 日志 corruption 关键字
- threshold/window：出现即 P0
- severity：P0
- initial action：**停止写路径评估**（必要时停 app 保现场），不要先重启
- runbook：INCIDENT_RESPONSE.md §场景 4 引用；恢复走 docs/BACKUP_RESTORE.md

### P0-5 安全事件（凭据泄漏/私有资产暴露嫌疑）

- signal：凭据出现在日志/仓库/公网；私有对象可被未授权访问的举报或自证
- threshold/window：出现即 P0
- severity：P0
- initial action：轮换受影响凭据（DB/Redis/S3/NEXTAUTH），按 docs/PRODUCTION_SECURITY.md
- runbook：INCIDENT_RESPONSE.md §场景 10-11

---

## P1 / High（核心能力受损，尽快响应）

### P1-1 Readiness 持续失败（非 DB 单因）

- signal：`/api/ready` 503（database 或 storage failed）持续
- threshold/window：≥5 分钟（deploy 滚动期不算：配合 `.releases.log` 时间窗）
- severity：P1（若同时命中 P0-2 则按 P0）
- initial action：`npm run ops:check`（生产机上）定位第一个 fail 的依赖
- runbook：INCIDENT_RESPONSE.md §场景 2/4

### P1-2 备份过期（stale）

- signal：`backup-status.json` 的 completedAt 距今 > BACKUP_MAX_AGE_HOURS（默认 26h）
- threshold/window：超过阈值即触发；>48h 升级关注
- severity：P1
- initial action：手动执行 `./scripts/ops/backup-postgres.sh`；cron 是否还活着；磁盘是否满
- runbook：INCIDENT_RESPONSE.md §场景 6

### P1-3 备份失败 / 异地备份失败

- signal：`backup-status.json` status=failed；或 offsiteStatus=failed
- threshold/window：任一次失败（脚本 exit != 0 本身也是信号）
- severity：P1（offsite failed = 3-2-1 缺口）
- initial action：看 stage 字段定位失败阶段（含 checksum 验证失败）；aws CLI 凭据/网络
- runbook：INCIDENT_RESPONSE.md §场景 5

### P1-4 意外错误率激增

- signal：`http_errors_total` / `unexpected_server_errors_total` 增速
  （http_errors_total 由 runtime 的 withHttpMetrics 真实计数；按 route 维度人工对比）
- threshold/window：5 分钟窗口内 rate > 基线 3 倍且绝对值 ≥10 次（无基线时：
  5 分钟 ≥20 次）
- severity：P1
- initial action：按日志 `event=server_error_classified` 的 category 聚合定位
  （DATABASE/STORAGE/INTERNAL…）；确认是否伴随新 release（`.releases.log`）
- runbook：INCIDENT_RESPONSE.md §场景 8（新 release 引入 → rollback）

### P1-5 对象存储不可用

- signal：`/api/ready` dependencies.storage=failed；上传接口 5xx 聚集
- threshold/window：≥5 分钟
- severity：P1（上传/私有资产交付受损；浏览仍可用）
- initial action：`docker compose ps minio`；`docker compose logs minio --tail 100`；磁盘容量
- runbook：INCIDENT_RESPONSE.md §场景 4

---

## P2 / Medium（降级可用，择机处理）

### P2-1 Redis 降级（本地限流兜底仍工作）

- signal：`/api/ready` dependencies.redis=degraded（仍 200）；`dependency_readiness_failures_total{dependency="redis"}`
- threshold/window：≥15 分钟持续（短暂抖动自愈不告警）
- severity：P2（依据 REDIS_READINESS_POLICY：多实例限流精确性下降，业务可用）
- initial action：`docker compose ps redis`；`docker compose logs redis --tail 50`；确认单实例部署影响有限
- runbook：INCIDENT_RESPONSE.md §场景 3

### P2-2 延迟上升

- signal：`http_request_duration_ms` p95（histogram）较近期基线明显上升
- threshold/window：10 分钟窗口 p95 > 基线 2 倍且 >1s
- severity：P2
- initial action：区分 route family 定位慢路由；DB 慢查询/连接池；磁盘 IO
- runbook：INCIDENT_RESPONSE.md §场景 12

### P2-3 磁盘容量告警

- signal：`df`（宿主机）/容器日志卷占用
- threshold/window：>80% 警告（P2）；>90% 升级 P1（备份与 Postgres 同机时 DB 有锁死风险）
- severity：P2
- initial action：清理旧备份（BACKUP_RETENTION_DAYS 生效确认）；`docker system prune` 谨慎评估后执行
- runbook：INCIDENT_RESPONSE.md §场景 12

### P2-4 证书过期预警

- signal：TLS 证书剩余有效期（Phase 3B 外部依赖：ACME/域名）
- threshold/window：剩余 <14 天（Caddy 自动续期正常时不需动作）
- severity：P2（标记 Phase 3B external：当前 DEFERRED，真实部署后生效）
- initial action：确认 Caddy 自动 ACME 续期日志无错误
- runbook：INCIDENT_RESPONSE.md §场景 13

---

## 接入说明（Phase 3B 之后）

接入真实渠道时保持规则语义不变：探测类（P0-1/P0-2/P1-1）由 uptime 探针
执行；指标类由 Prometheus 兼容采集器抓 `/api/internal/metrics` 后按
threshold/window 表达式实现；备份类由 cron 调 `npm run ops:backup-health
--mode production`（exit 1 即触发）。禁止把单请求事件直接接到 P0/P1。

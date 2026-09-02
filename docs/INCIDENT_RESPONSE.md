# 事件响应手册（Incident Response Runbook）

> Phase 4 repo-side runbook。真实公网告警渠道尚未接入（Phase 3B DEFERRED），
> 检测信号以本文所列探针/日志/指标为准。状态：`DONE / MERGED / MASTER-GREEN / CLOSED`
> （2026-09-02，权威路线见 [MASTER_ROADMAP.md](MASTER_ROADMAP.md)）。
> 权威操作流程以既有文档为准，本文只做**调度与引用**，不复制第二套
> restore/rollback 步骤：
>
> - 部署：docs/PRODUCTION_DEPLOYMENT.md
> - 备份/恢复：docs/BACKUP_RESTORE.md
> - 回滚：docs/ROLLBACK.md
> - 安全：docs/PRODUCTION_SECURITY.md
> - 可观测性契约：docs/OBSERVABILITY.md
> - 告警规则：docs/ALERTING.md

## 0. 事件流程总览

```text
detect（探针/告警/用户报告）
  → triage（定 severity：ALERTING.md P0/P1/P2；确认影响面与起始时间）
  → contain（止损优先：rollback/停写/隔离，评估后再动）
  → recover（按对应场景 runbook 执行）
  → verify（/api/health release 正确 + /api/ready 全绿 + ops:check PASS）
  → postmortem（48h 内：时间线、根因、行动项）
```

Severity 定义见 docs/ALERTING.md 分级。所有 P0/P1 记录处置时间线（命令 +
时间戳），供 postmortem。

通用排查入口：

```bash
docker compose ps                                # 组件存活
docker compose logs app --tail 200               # 应用结构化日志（JSON 行）
curl -fsS https://<域名>/api/health              # liveness：进程存活 + release（不探依赖）
curl -fsS https://<域名>/api/ready               # readiness：依赖状态（DB/Redis/Storage）
./scripts/ops/lib.sh 依赖的工具见各场景          # 统一 env contract
```

> 语义提醒：`/api/health` 失败 = 进程/容器层故障；依赖故障只反映在
> `/api/ready`（DB/Storage 失败 → 503 not_ready，Redis 故障 → degraded）。
> 两者分离意味着 DB outage 时 app 容器 healthcheck 仍正常。

---

## 场景 1：应用完全不可用

- 信号：/api/health 连续失败（ALERTING P0-1）
- 处置：
  1. `docker compose ps`：app/caddy 是否 running/healthy
  2. app 容器反复重启 → `docker compose logs app --tail 200` 看启动期 ERROR
  3. `.releases.log` 最近一次部署时间：若故障紧随部署 → 直接走场景 8（rollback）
  4. 非 deploy 相关崩溃：宿主机资源（内存 OOM：`docker inspect` OOMKilled）
  5. 恢复后 verify（见 §0）

## 场景 2：PostgreSQL 不可用

- 信号：/api/ready dependencies.database=failed（ALERTING P0-2）
- 处置：
  1. `docker compose ps postgres`（healthcheck=pg_isready）
  2. `docker compose logs postgres --tail 100`：常见根因=磁盘满/内存/配置
  3. **不要**在未评估前重启（写缓存/恢复流程可能受影响）；磁盘满先清日志卷
  4. 恢复后：`/api/ready` database=ok；若曾发生非正常宕机，按
     docs/BACKUP_RESTORE.md 评估是否需要 consistency 检查
  5. 数据损坏嫌疑 → 升级场景 4 处理

## 场景 3：Redis 不可用（降级运行）

- 信号：/api/ready dependencies.redis=degraded（仍 200 接流量；ALERTING P2-1）
- 语义：REDIS_READINESS_POLICY（docs/OBSERVABILITY.md §4）——限流自动回退
  进程内本地计数，业务可用；多实例部署时限流精确性下降
- 处置：
  1. `docker compose ps redis` / `docker compose logs redis --tail 50`
  2. redis 配置为 EPHEMERAL（appendonly no）：重启即恢复，无数据恢复负担
  3. `docker compose restart redis` → 观察 /api/ready 回到 ready
  4. 若 redis 反复挂：查内存（maxmemory 128mb）与宿主机资源

## 场景 4：S3/MinIO 不可用

- 信号：/api/ready dependencies.storage=failed（ALERTING P1-5）
- 影响：上传、私有资产同源交付不可用；浏览/搜索不受影响
- 处置：
  1. `docker compose ps minio` / `docker compose logs minio --tail 100`
  2. 磁盘容量（MinIO 数据卷）：磁盘满→ 场景 12
  3. 凭据/策略漂移（minio-app-policy）：对照 docs/STORAGE.md 契约
  4. 恢复验证：`/api/ready` storage=ok + 实际上传一次图片（用户路径）

## 场景 5：备份失败

- 信号：backup-status.json status=failed（ALERTING P1-3）；脚本 exit != 0
- 处置：
  1. 读 `stage` 字段：`dump`（DB 连接）/`empty_dump`（pg_dump 异常输出）/
     `offsite`（aws CLI/网络/凭据）/`retention`
  2. stage=offsite 且本地 dump 正常：先确认为何失败（`aws s3 ls` 验证），
     本地备份仍在但缺异地副本（3-2-1 缺口，24h 内必须补齐）
  3. 根因修复后手动重跑 `./scripts/ops/backup-postgres.sh`，确认
     backup-status.json 回到 success
  4. 若 dump 持续失败 → 立即评估现有最近一次 good backup 的可用性
     （docs/BACKUP_RESTORE.md restore drill）

## 场景 6：备份过期（stale）

- 信号：completedAt > BACKUP_MAX_AGE_HOURS（ALERTING P1-2）
- 处置：
  1. cron/计划任务是否存活（`docker compose --profile ops run --rm backup`？
     按实际调度方式检查）
  2. 手动补跑一次备份并成功后，检查下一次调度是否恢复
  3. 若因磁盘满无法写备份 → 场景 12 优先处理
  4. stale 期间如需重启/迁移/升级 DB：**先补一次成功备份再操作**

## 场景 7：部署失败（deploy 中断）

- 信号：deploy.sh 非零退出（preflight/build/migrate/up/health 验证任一阶段）
- 处置：
  1. deploy.sh 是幂等流程（docs/PRODUCTION_DEPLOYMENT.md）：
     定位失败阶段看输出（preflight=env 契约；build=镜像；migrate=DB；
     up/health=容器与验证）
  2. migrate 失败：**不要**手动改库；按 docs/ROLLBACK.md 决策表处理
     （schema 只向前原则）
  3. 已切流量的失败部署 → 场景 8 rollback

## 场景 8：坏版本（bad release，流量已切）

- 信号：错误率激增随新 release 出现（ALERTING P1-4）；`.releases.log` 对时
- 处置：
  1. 确认当前 release：`curl /api/health` 的 `release` 字段
  2. 回滚走 **docs/ROLLBACK.md**（唯一权威流程）：
     - 默认 `./scripts/ops/rollback.sh <prev_sha>`（safe：不碰 DB）
     - 涉及 schema 的破坏性迁移 → `--hard` 路径（先 restore 后切应用）
  3. 回滚后 verify：/api/health release == prev_sha 且 /api/ready 全绿
  4. postmortem：坏变更如何通过 CI（补测试/门禁）

## 场景 9：回滚操作本身

- 流程：docs/ROLLBACK.md（safe/hard 决策表、`.releases.log` 标记不可逆迁移）
- 关键纪律：
  1. hard rollback 的前置是 restore 成功——restore 失败绝不切应用（脚本已内置）
  2. 回滚后必须做 release 验证（EXACT SHA）与 `/api/ready`
  3. 回滚不是终点：24h 内决定 forward-fix 还是保持

## 场景 10：凭据泄漏嫌疑

- 信号：ALERTING P0-5
- 处置：
  1. 确认泄漏面：日志（logger redaction 失效？）/仓库（.env 提交？）/公网
  2. **立即轮换**（并行进行）：DB/Redis/S3/NEXTAUTH_SECRET/METRICS token
     （更新 .env.production → 按序重启受影响服务）
  3. 泄漏进 git 历史 → 按 docs/PRODUCTION_SECURITY.md 处理（含历史清理评估）
  4. 评估滥用窗口：S3 访问日志/DB 连接日志（可获取时）
  5. postmortem 必须包含 redaction 层或流程的改进项

## 场景 11：私有资产暴露嫌疑

- 信号：私有对象（校园认证/交接证据/举报证据）可被未授权访问
- 处置：
  1. 复现访问路径：直接对象 URL / presigned URL 泄漏 / 代理端点鉴权绕过
  2. 临时止损：收紧 minio-app-policy（仅 app 凭据可读 private 桶）+
     检查 /assets/* 出口只指向 public 桶（deploy/Caddyfile 契约）
  3. 涉及用户数据 → 按合规要求评估通知义务；保留访问证据
  4. 修复验证：未登录/越权访问 private 资产必须 401/403（回归测试覆盖）
  5. 对账：docs/PRODUCTION_SECURITY.md 的访问控制矩阵

## 场景 12：磁盘容量耗尽

- 信号：ALERTING P2-3（>80% 警告，>90% 升 P1）
- 处置：
  1. 定位大头：`docker system df`、备份目录（BACKUP_RETENTION_DAYS 是否
     生效）、容器日志卷（compose logging 上限，见 compose.production.yml）
  2. 优先清理项（安全序）：过期备份（脚本 retention 已覆盖，可手动 find 验证）
     → 构建缓存 → `docker system prune`（评估后）
  3. **不要**删除当前最近一次 good backup
  4. Postgres/MinIO 数据卷满导致的故障（场景 2/4）在清理后自愈；否则按对应场景

## 场景 13：TLS/域名故障（Phase 3B external，当前 DEFERRED）

- 状态：真实域名/DNS/ACME 属 Production Phase 3B，当前未部署；
  本场景为**前瞻定义**，真实部署后生效
- 信号：证书过期告警（ALERTING P2-4）/ DNS 解析失败
- 处置：
  1. Caddy 自动 ACME：`docker compose logs caddy --tail 100` 看续期错误
  2. DNS/域名商控制台确认解析与有效期
  3. 更换域名/证书时同步 NEXTAUTH_URL/SITE_ADDRESS/PUBLIC_ASSET_BASE_URL
     并按 docs/PRODUCTION_DEPLOYMENT.md 重新 preflight

---

## 恢复验证（所有场景收尾必做）

```bash
curl -fsS https://<域名>/api/health   # {"status":"ok","release":"<期望 SHA>"}（进程/发布层）
curl -fsS https://<域名>/api/ready    # {"status":"ready", dependencies 全 ok}（依赖层）
npm run ops:check -- --mode production # 全部 PASS（exit 0；生产模式无 skip bypass）
```

涉及数据恢复的场景追加：按 docs/BACKUP_RESTORE.md 执行一次 restore drill
抽样验证（表计数/迁移数）。

## Postmortem（48h 内）

- 时间线（检测→contain→recover→verify，带时间戳与命令）
- 根因（区分触发因素与系统性缺口）
- 行动项（可执行：测试/门禁/文档/阈值调整，标注 owner 与期限）
- P0/P1 事件回填 ALERTING.md 规则是否需要调整阈值/新增信号

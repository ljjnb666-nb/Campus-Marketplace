# Phase 9 运维手册（Async / Outbox / Notification / Retention）

> Phase 9C-04 交付物。面向平台运营者/值班人员；分类与保留策略权威见
> [DATA_GOVERNANCE.md](DATA_GOVERNANCE.md) §2.1，隐私运营见
> [PRIVACY_OPERATIONS.md](PRIVACY_OPERATIONS.md)，日志红线见
> [LOG_PRIVACY.md](LOG_PRIVACY.md)。
>
> Phase 9 status：**CLOSED**（2026-10-05，final master `e497dcde`，closure record 见 [MASTER_ROADMAP.md](MASTER_ROADMAP.md) §5.5）。

## 1. 运行拓扑与 cadence owner（单实例不变量）

生产**只有一个** periodic cleanup / retention cadence owner：

```
compose.production.yml  storage-cleanup 服务（单实例、仅 backend 网络、无端口发布）
  每轮（ASSET_CLEANUP_INTERVAL_SECONDS，默认 1800s，生产下限 60s）：
    runStorageCleanup()               → S3 对象 / 上传资源 / 导出 artifact 清理
    runPhase9RetentionMaintenance()   → Phase 9 retention / reconcile（9C-04）
```

- 服务名保持 `storage-cleanup`（不重命名，避免生产 topology drift）；
  9C-04 起它同时负责 S3 cleanup 与 Phase 9 retention/reconcile；
- 不存在第二套 daemon / 第二套命令入口；`npm run storage:cleanup` 与
  生产 worker 执行同一完整周期；
- 与 `/api/ready` 完全解耦：retention/cleanup backlog（含 dead letter）
  是后台运维面，**绝不翻转 readiness**（§35）；
- retention 子任务失败（`phase9Failures > 0`）→ 整周期按 FAIL 处理：
  记 errorName-only 失败日志、不打印成功 summary、run-once 退出码 1，
  等下轮重试（全部转移幂等，部分成功下轮继续安全）。

## 2. Retention defaults（工程 baseline）

| 环境变量 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `ASYNC_TERMINAL_RETENTION_DAYS` | 30 | 1–3650 | COMPLETED AsyncJob / PUBLISHED OutboxEvent payload compaction 窗口 |
| `NOTIFICATION_DELIVERY_PII_RETENTION_DAYS` | 30 | 1–3650 | EMAIL delivery terminal contact snapshot redaction 窗口 |

> **LEGAL_REVIEW_REQUIRED = TRUE**：以上是工程治理 baseline，不是法律意见；
> 生产期限需正式 legal review 后以 env 覆盖。

Terminal anchor（排队/重试时间绝不吞掉 terminal retention）：

- AsyncJob → `completedAt`；OutboxEvent → `publishedAt`；
- NotificationDelivery → `providerAcceptedAt` 或 `suppressedAt`（先到者）；
- **绝不使用 `createdAt`**。

redactedAt 单向性（Review R1 RB03 冻结）：`redactedAt` = **第一次**将
destination 收敛为 redacted sentinel 的时间——只允许 `NULL → timestamp`
单向迁移，一旦非空永不被覆盖（retention 与 account erasure 并发时，无论
谁先完成第一次 transition，首次时间戳保留，后到路径条件谓词不命中）。
account erasure 的 destination 写入是**无条件**的（注销后 destination 必须
立即 redacted，即便 redactedAt 已存在）——两个目标同时满足：立即 redact +
不覆盖首次时间戳。

## 3. Tombstone 语义（dedupe-safe，绝不 DELETE）

COMPLETED AsyncJob / PUBLISHED OutboxEvent 达到 retention cutoff 后做
**in-place compaction**：

```
payload    → {"retained":"TOMBSTONE"}（固定机器 marker，故意不符合任何
             job/event payload schema——COMPLETED/PUBLISHED 行永不再次
             claim/dispatch，形状漂移无 runtime 风险）
诊断/lease  → null
tombstonedAt → now
状态        → 保持 COMPLETED / PUBLISHED（绝不新增第二套终态状态机）
dedupeKey   → 永久保留（UNIQUE = exactly-once / replay suppression
             authority；删行 = 释放幂等身份 = duplicate side effect 窗口）
```

安全性质：

- tombstoned 行永不进入 claim/dispatch 候选（候选只含 PENDING/RETRY/
  RUNNING 与 PENDING/PROCESSING）；
- `requeueDeadLetterJobTx` 只接受 DEAD_LETTER——tombstone 无 revive 路径；
- 同 dedupeKey 的 stale replay 仍被写边界拒绝（`recorded=false`）；
- DEAD_LETTER **不是** retention candidate（未决运维事件，保留诊断面）。

## 4. Dead-letter 处理策略

### 4.1 查看现状

```bash
npm run ops:phase9-status
```

`asyncJobs.deadLetter` / `outbox.deadLetter` / `email.unresolvedDeadLetter`
给出计数与最老年龄（`oldestDeadLetterAgeMs`）；存在 dead letter 时
`attentionRequired=true`——这是"需要人看"的标记，**不是**平台不可运行，
也不翻转 readiness。

### 4.2 NOTIFICATION_DELIVERY dead-letter（自动 bounded reconcile）

EMAIL 投递 job 因幂等安全窗口过期 / provider permanent failure / retry
预算耗尽进入 DEAD_LETTER 后，delivery intent 已无法由 canonical worker
继续发送。maintenance 每周期 bounded 扫描并收敛：

- **candidate discovery 只选择 canonical actionable 行**（Review R1 RB01/
  RB02 冻结合同）：payload strict-parseable（`{ deliveryId }` 单键对象）
  **且** `dedupeKey == NOTIFICATION_DELIVERY:<payload.deliveryId>` **且**
  delivery 存在 **且** delivery 未收敛（accepted/suppressed 皆空）——
  已 suppressed、provider-accepted 异常、invalid payload、binding mismatch、
  missing delivery 全部不占 batch（resolved/anomaly 行永久存在也不会
  阻塞真正 actionable backlog 的公平进展）；
- 未收敛 delivery → `suppressedAt=now` +
  `suppressionCode=NOTIFICATION_JOB_DEAD_LETTER`；
- provider-accepted 的 DEAD_LETTER → **绝不改写**（accepted provenance 是
  外部投递事实；与 DEAD_LETTER 是矛盾 terminal provenance）；
- **structural corruption 只报告、绝不自动 mutation**（Review R1 RB02：
  payload 与 dedupeKey 不一致时不同代码路径会认不同 delivery，自动
  suppress 任一方都是正确性错误；dedupeKey 只用于与 payload 的一致性
  校验，绝不在 payload invalid 时充当 replacement authority）；
- 结构异常分类（machine counts，ops snapshot 的
  `notificationDeadLetterAnomalies`）：`invalidPayload` / `bindingMismatch`
  / `missingDelivery` / `acceptedAnomaly`——与 reconcile discovery 使用
  同一 canonical binding 谓词，互斥分类。

**禁止 blind resend**：超过幂等安全窗口或 dead-letter 的投递不得通过
generic requeue 直接重用原 delivery（`requeueNotificationDelivery` 这类
入口不存在也不允许新增）。确需重发必须创建显式新 notification/delivery
intent。

### 4.3 其它 DEAD_LETTER（AsyncJob / OutboxEvent 通用）

- 保留全部诊断字段（安全 errorCode + 受控文案），不自动删除/tombstone；
- 处置走既有 `requeueDeadLetterJobTx` / `requeueDeadLetterOutboxEventTx`
  seam（内部 service 调用，修复根因后 requeue）；
- 长期未解决的 dead letter 通过 ops snapshot 的 age 观测升级（P2 事件流程）。

## 5. 手动运维入口（不需要手工 SQL）

```bash
# 查看现状（只读 JSON，无副作用）
npm run ops:phase9-status
npm run ops:phase9-status -- --strict   # structural invariant violation → exit 1

# dry-run（计算计划，零 mutation）
docker compose --env-file .env.production -f compose.production.yml \
  run --rm storage-cleanup --run-once --dry-run

# 实际执行（完整周期：storage cleanup + Phase 9 retention/reconcile）
docker compose --env-file .env.production -f compose.production.yml \
  run --rm storage-cleanup --run-once
```

- `--strict` 只对 structural inconsistency FAIL（如 COMPLETED 但
  completedAt 为空、PUBLISHED 但 publishedAt 为空、redactedAt 已设但
  destination 未收敛、NOTIFICATION_DELIVERY dead-letter 的 invalid payload /
  binding mismatch / missing delivery / provider-accepted 矛盾 provenance、
  READY artifact 缺 expiresAt）；仅存在 dead letter 时 result 仍 PASS
 （attentionRequired=true）；
- ops 输出是 machine-only（counts/ages/status）——绝不包含 payload、
  收件目的地、存储定位符、providerMessageId、dedupeKey raw、原始错误文案、
  连接串（CI 以 stdout 全量捕获锁定：`PHASE9-OPS-NO-SECRET-01`）；
- 未开启 `--strict` 时输出不含结构检查明细；dead letter / anomaly 的
  具体行不允许从 ops surface 获取（需要诊断时走受控 DB 只读查询，
  由工程人员执行并遵守 LOG_PRIVACY 红线）。

## 6. 禁止的手工操作（红线）

运营/工程**不得**直接执行以下 DB 操作（必须走 maintenance service）：

```text
DELETE FROM "AsyncJob" ...            -- 释放 dedupeKey = 释放 exactly-once 身份
DELETE FROM "OutboxEvent" ...         -- 同上
UPDATE "NotificationDelivery" ...     -- destination/redactedAt 有唯一权威
                                      -- 写入方（erasure / retention service）
UPDATE "AsyncJob" SET status=...      -- 状态机只在 worker/repository 内转移
```

- 未知结构异常（structural inconsistency）**只报告、fail strict**，
  绝不自作主张"猜一个状态写回"；
- 需要人工修复时：先在工单记录 invariant violation 证据（ops snapshot
  JSON），由工程人员评估后经受控 service seam 修复并留操作记录；
- PrivacyRequest 台账（GOVERNANCE_AUDIT）不做自动 purge，也禁止手工删除；
- 用户 notification inbox 历史不因 retention 改变（产品策略另行决策）。

## 7. 观测事件

| 事件 | 级别 | 内容 |
| --- | --- | --- |
| `phase9_retention_cycle_completed` | INFO（仅实际 work > 0） | counts only（tombstoned / reconciled / redacted） |
| `phase9_retention_subtask_failed` | ERROR | subtask 名 + errorName only（无 raw message） |
| `storage_cleanup_cycle_completed` | INFO（仅实际 work > 0） | cleanup + retention counts only |
| `phase9_retention_cycle_failed` | ERROR | errorName only；run-once 退出码 1 |

任何 retention/ops 日志都不允许出现：payload、收件目的地、bucket/objectKey、
provider 原始响应、lastErrorMessage raw。

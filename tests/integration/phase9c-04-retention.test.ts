import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runPrismaCommand } from "../../scripts/resilience/spawn-worker.mjs";

/**
 * Phase 9C-04（RETENTION / TOMBSTONES / OPS-RECONCILE）集成测试（真实 PostgreSQL）。
 *
 * 第一核心不变量（INV-9C04-01）：retention 永远不释放已成功 intent/event 的
 * dedupe identity——tombstone 后同 dedupeKey 重放必须被写边界拒绝（§9）。
 *
 * dedupe-safe tombstone（§5/§8/INV-9C04-02/03）：
 *   RET-JOB-DEDUPE-01       COMPLETED → tombstone → 同 dedupeKey enqueue
 *                           recorded=false，行数保持 1；tombstone 行永不
 *                           claim / 不存在 revive 路径（§7/§58）
 *   RET-OUTBOX-DEDUPE-01    PUBLISHED → tombstone → 同 dedupeKey record
 *                           recorded=false；永不再次 dispatch
 *
 * bounded（§22/§55/§56/INV-9C04-09）：
 *   RET-JOB-BOUNDED-01      100 旧 COMPLETED，batchLimit=10 → 每轮 <= 10，
 *                           重复至全量收敛
 *   RET-OUTBOX-BOUNDED-01   同构
 *
 * race（§24/§60/INV-9C04-10，真实 PG 条件转移谓词）：
 *   RET-RACE-JOB-01 / RET-RACE-OUTBOX-01 / RET-RACE-DELIVERY-01
 *                           两个并发 maintenance worker → 逻辑转移恰好一次
 *
 * notification（§13/§18/§49/§50/INV-9C04-05/06/07 + Review R1）：
 *   RECON-NOTIFICATION-DL-01       未收敛 DEAD_LETTER → canonical suppression，
 *                                  幂等重放 0 mutation
 *   RECON-NOTIFICATION-ACCEPTED-01 provider-accepted 的 DEAD_LETTER 异常 →
 *                                  绝不改写 accepted provenance（§50）；
 *                                  anomaly 行不占 actionable batch
 *   RECON-NOTIFICATION-FAIRNESS-01（RB01）resolved/anomaly 不占 batch——
 *                                  unresolved 有限轮次内必然收敛
 *   RECON-NOTIFICATION-INVALID-PAYLOAD-01（RB02）payload 非 strict →
 *                                  0 mutation，只报告 structural anomaly
 *   RECON-NOTIFICATION-BINDING-MISMATCH-01（RB02）payload/dedupeKey 不一致
 *                                  → A、B 都不动 + ops strict FAIL
 *   RET-NOTIFICATION-PII-01        terminal 超窗 → destination redacted，
 *                                  provenance 保留
 *   RET-NOTIFICATION-SUPPRESSED-01 / RET-NOTIFICATION-RECENT-01 /
 *   RET-NOTIFICATION-PENDING-01    suppressed 超窗 redact / 近期 terminal
 *                                  不动 / pending 永不动
 *   RET-ERASURE-REDACT-01（RB03）  retention 先 redact → erasure 不得覆盖
 *                                  redactedAt（首次脱敏时间权威）
 *   RET-ERASURE-REDACT-RACE-01（RB03）erasure 持行锁在先 → retention 后到
 *                                  零覆盖（真实 PG 行锁 barrier，零 sleep）
 *
 * dry-run（§25/§59/INV-9C04-11）：
 *   RET-DRY-RUN-01           backlog 存在 → planned > 0 且零 mutation
 *
 * ops surface（§32/§36/§37/§81/INV-9C04-12）：
 *   PHASE9-OPS-NO-SECRET-01  CLI stdout 全量捕获：无 email/@、私有定位符、
 *                            连接串、X-Amz、payload/destination 等任何秘密
 *                            形态；--strict 对 structural invariant violation
 *                            FAIL + exit 1；dead letter 只置 attentionRequired
 *                            （不翻转整体结果）。
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const REPO_ROOT = process.cwd();
const PHASE9_STATUS_ENTRY = path.join(REPO_ROOT, "scripts", "ops", "phase9-status.ts");

/** 生产同款入口直接 spawn（node --import tsx，不经 npx/.cmd 包装） */
function runPhase9StatusCli(
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", PHASE9_STATUS_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 9C-04 retention / tombstone / ops reconcile（真实 PG）",
  () => {
  type PrismaModule = typeof import("@/lib/prisma");
  type RetentionModule = typeof import("@/lib/async/retention");
  type JobRepoModule = typeof import("@/lib/async/job-repository");
  type OutboxModule = typeof import("@/lib/async/outbox");
  type DeliveryModule = typeof import("@/lib/notifications/notification-delivery");

  let prisma: PrismaModule["prisma"];
  let withTransaction: PrismaModule["withTransaction"];
  let tombstoneCompletedAsyncJobs: RetentionModule["tombstoneCompletedAsyncJobs"];
  let tombstonePublishedOutboxEvents: RetentionModule["tombstonePublishedOutboxEvents"];
  let redactTerminalNotificationDestinations: RetentionModule["redactTerminalNotificationDestinations"];
  let reconcileDeadLetterNotificationDeliveries: RetentionModule["reconcileDeadLetterNotificationDeliveries"];
  let runPhase9RetentionMaintenance: RetentionModule["runPhase9RetentionMaintenance"];
  let PHASE9_RETENTION_TOMBSTONE_MARKER: RetentionModule["PHASE9_RETENTION_TOMBSTONE_MARKER"];
  let enqueueAsyncJobTx: JobRepoModule["enqueueAsyncJobTx"];
  let requeueDeadLetterJobTx: JobRepoModule["requeueDeadLetterJobTx"];
  let claimDueAsyncJobs: JobRepoModule["claimDueAsyncJobs"];
  let recordOutboxEventTx: OutboxModule["recordOutboxEventTx"];
  let claimDueOutboxEvents: OutboxModule["claimDueOutboxEvents"];
  let REDACTED_EMAIL_DESTINATION: DeliveryModule["REDACTED_EMAIL_DESTINATION"];
  let NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER: DeliveryModule["NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER"];
  type ErasureModule = typeof import("@/lib/privacy/account-erasure");
  let eraseAccount: ErasureModule["eraseAccount"];

  let rawClient: PrismaClient;
  let isolatedUrl: string;

  let isolatedDbName: string;
  const adminUrlFor = (url: string) => {
    const parsed = new URL(url);
    parsed.pathname = "/postgres";
    return parsed.toString();
  };

  /** retention 窗口固定 30 天；"旧" = 31 天前，"近期" = 现在。 */
  const RETENTION_DAYS = 30;
  const OLD = new Date(Date.now() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
  const NOW = new Date();

  let uniqueCounter = 0;
  const unique = (prefix: string) => `${prefix}-${Date.now()}-${++uniqueCounter}-${Math.random().toString(36).slice(2, 8)}`;

  /** 直接落一行旧 COMPLETED AsyncJob（payload 允许任意 JSON：tombstone
   * 不做 payload 校验，本表候选只看 status + terminal anchor + tombstonedAt） */
  async function seedCompletedJob(overrides: {
    dedupeKey?: string;
    completedAt?: Date | null;
    tombstonedAt?: Date | null;
    payload?: unknown;
    lastErrorMessage?: string | null;
  } = {}) {
    const dedupeKey = overrides.dedupeKey ?? unique("RET-JOB");
    const row = await rawClient.asyncJob.create({
      data: {
        kind: "PRODUCT_RESERVATION_EXPIRE",
        schemaVersion: 1,
        dedupeKey,
        payload: (overrides.payload ?? { orderId: unique("order") }) as object,
        status: "COMPLETED",
        runAt: OLD,
        completedAt: overrides.completedAt === undefined ? OLD : overrides.completedAt,
        tombstonedAt: overrides.tombstonedAt ?? null,
        lastErrorMessage: overrides.lastErrorMessage ?? null,
      },
    });
    return row;
  }

  async function seedPublishedEvent(overrides: {
    dedupeKey?: string;
    publishedAt?: Date | null;
    tombstonedAt?: Date | null;
  } = {}) {
    const dedupeKey = overrides.dedupeKey ?? unique("RET-EVT");
    return rawClient.outboxEvent.create({
      data: {
        eventType: "PRODUCT_RESERVATION_EXPIRED",
        schemaVersion: 1,
        aggregateType: "ORDER",
        aggregateId: unique("order"),
        dedupeKey,
        payload: { orderId: unique("order") },
        status: "PUBLISHED",
        availableAt: OLD,
        publishedAt: overrides.publishedAt === undefined ? OLD : overrides.publishedAt,
        tombstonedAt: overrides.tombstonedAt ?? null,
      },
    });
  }

  /** 直接落一行 NotificationDelivery（裸 notificationId 列，无 FK——
   * 与 schema 注释一致；retention/reconcile 只依赖本行自身字段） */
  async function seedDelivery(overrides: {
    destination?: string;
    providerAcceptedAt?: Date | null;
    suppressedAt?: Date | null;
    suppressionCode?: string | null;
    redactedAt?: Date | null;
    createdAt?: Date;
    providerMessageId?: string | null;
  } = {}) {
    return rawClient.notificationDelivery.create({
      data: {
        notificationId: unique("notif"),
        channel: "EMAIL",
        provider: "resend",
        destination: overrides.destination ?? "student@campus.edu",
        senderSnapshot: "noreply@platform",
        providerIdempotencyKey: unique("idem"),
        providerMessageId: overrides.providerMessageId ?? `msg-${unique("x")}`,
        providerAcceptedAt:
          overrides.providerAcceptedAt === undefined ? null : overrides.providerAcceptedAt,
        suppressedAt: overrides.suppressedAt === undefined ? null : overrides.suppressedAt,
        suppressionCode: overrides.suppressionCode ?? null,
        redactedAt: overrides.redactedAt ?? null,
        createdAt: overrides.createdAt ?? NOW,
      },
    });
  }

  /** 直接落一行 NOTIFICATION_DELIVERY DEAD_LETTER job（payload = {deliveryId}，
   * 与 9B 写边界 payload 契约同形） */
  async function seedNotificationDeadLetterJob(
    deliveryId: string,
    payload?: unknown,
    deadLetteredAt: Date = OLD,
  ) {
    return rawClient.asyncJob.create({
      data: {
        kind: "NOTIFICATION_DELIVERY",
        schemaVersion: 1,
        dedupeKey: `NOTIFICATION_DELIVERY:${deliveryId}`,
        payload: (payload ?? { deliveryId }) as object,
        status: "DEAD_LETTER",
        runAt: OLD,
        deadLetteredAt,
        lastErrorCode: "EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED",
        lastErrorMessage: "EMAIL 幂等安全窗口（23h）已过期",
      },
    });
  }

  /** 直接落一行任意 ND DEAD_LETTER job（structural corruption fixtures 用：
   * dedupeKey/payload 完全由调用方指定） */
  async function seedRawNotificationDeadLetterJob(input: {
    dedupeKey: string;
    payload: unknown;
    deadLetteredAt?: Date;
  }) {
    return rawClient.asyncJob.create({
      data: {
        kind: "NOTIFICATION_DELIVERY",
        schemaVersion: 1,
        dedupeKey: input.dedupeKey,
        payload: input.payload as object,
        status: "DEAD_LETTER",
        runAt: OLD,
        deadLetteredAt: input.deadLetteredAt ?? OLD,
      },
    });
  }

  /** 注销测试夹具用户（裸 User 行即满足 eraseAccount 前置检查） */
  let campusId: string;
  async function createErasureFixtureUser(label: string) {
    return rawClient.user.create({
      data: {
        name: `9c04-${label}`,
        email: `9c04-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@campus.local`,
        passwordHash: "test-only",
        schoolName: "集成测试大学",
        campusId,
      },
    });
  }


  /** 注销测试夹具：用户 + canonical In-App 通知 */
  async function seedNotificationForUser(userId: string) {
    return rawClient.notification.create({
      data: {
        userId,
        type: "SYSTEM",
        title: "9C-04 erasure fixture",
        content: "fixture notification",
      },
    });
  }

  beforeAll(async () => {
    const parsed = new URL(integrationDatabaseUrl!);
    isolatedDbName = `campus_9c04_it_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    parsed.pathname = `/${isolatedDbName}`;
    isolatedUrl = parsed.toString();
    await runPrismaCommand(
      ["db", "execute", "--stdin"],
      { DATABASE_URL: adminUrlFor(integrationDatabaseUrl!) },
      `CREATE DATABASE "${isolatedDbName}";`,
    );
    const migrated = await runPrismaCommand(
      ["migrate", "deploy"],
      { DATABASE_URL: isolatedUrl },
    );
    expect(
      migrated.code,
      `migrate deploy failed: ${migrated.stderr.slice(0, 400)}`,
    ).toBe(0);

    process.env.DATABASE_URL = isolatedUrl;

    ({ prisma, withTransaction } = await import("@/lib/prisma"));
    ({
      tombstoneCompletedAsyncJobs,
      tombstonePublishedOutboxEvents,
      redactTerminalNotificationDestinations,
      reconcileDeadLetterNotificationDeliveries,
      runPhase9RetentionMaintenance,
      PHASE9_RETENTION_TOMBSTONE_MARKER,
    } = await import("@/lib/async/retention"));
    ({
      enqueueAsyncJobTx,
      requeueDeadLetterJobTx,
      claimDueAsyncJobs,
    } = await import("@/lib/async/job-repository"));
    ({ recordOutboxEventTx, claimDueOutboxEvents } = await import("@/lib/async/outbox"));
    ({ eraseAccount } = await import("@/lib/privacy/account-erasure"));
    const delivery = await import("@/lib/notifications/notification-delivery");
    REDACTED_EMAIL_DESTINATION = delivery.REDACTED_EMAIL_DESTINATION;
    NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER =
      delivery.NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER;

    rawClient = new PrismaClient({ datasources: { db: { url: isolatedUrl } }, log: ["error"] });

    const campus = await rawClient.campus.create({
      data: {
        name: "9C-04 retention 集成测试校区",
        slug: `it-9c04-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolName: "集成测试大学",
      },
    });
    campusId = campus.id;
  }, 240_000);

  afterAll(async () => {
    await rawClient?.$disconnect();
    if (prisma) {
      await prisma.$disconnect();
      await runPrismaCommand(
        ["db", "execute", "--stdin"],
        { DATABASE_URL: adminUrlFor(integrationDatabaseUrl!) },
        `DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE);`,
      );
    }
  }, 60_000);

  it("RET-JOB-DEDUPE-01：COMPLETED → tombstone → 同 dedupeKey 重放被拒；行数保持 1；永不 claim / revive", async () => {
    const dedupeKey = unique("RET-DEDUPE");
    const job = await seedCompletedJob({
      dedupeKey,
      payload: { orderId: "ret-dedupe-order" },
    });

    const summary = await tombstoneCompletedAsyncJobs({ retentionDays: RETENTION_DAYS, now: NOW });
    expect(summary.tombstoned).toBeGreaterThanOrEqual(1);

    const tombstoned = await rawClient.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(tombstoned.status).toBe("COMPLETED");
    expect(tombstoned.tombstonedAt).not.toBeNull();
    expect(tombstoned.payload).toEqual(PHASE9_RETENTION_TOMBSTONE_MARKER);
    // dedupe identity / 执行 provenance 保留
    expect(tombstoned.dedupeKey).toBe(dedupeKey);
    expect(tombstoned.completedAt).not.toBeNull();

    // §9：tombstone 后同 dedupeKey 重放 → 写边界拒绝（recorded=false）
    const replay = await withTransaction((tx) =>
      enqueueAsyncJobTx(tx, {
        kind: "PRODUCT_RESERVATION_EXPIRE",
        schemaVersion: 1,
        dedupeKey,
        payload: { orderId: "ret-dedupe-order" },
        runAt: NOW,
      }),
    );
    expect(replay.recorded).toBe(false);
    const rowCount = await rawClient.asyncJob.count({ where: { dedupeKey } });
    expect(rowCount).toBe(1);

    // §7：COMPLETED（含 tombstone）不存在 revive 路径
    const revived = await withTransaction((tx) => requeueDeadLetterJobTx(tx, job.id));
    expect(revived.requeued).toBe(false);

    // §58：tombstoned COMPLETED 行永不 claim（即使 runAt 已到）
    await rawClient.asyncJob.update({ where: { id: job.id }, data: { runAt: new Date(0) } });
    const claimed = await withTransaction((tx) =>
      claimDueAsyncJobs(tx, { workerId: "it-9c04", leaseSeconds: 60, batchSize: 100, now: NOW }),
    );
    expect(claimed.map((row) => row.id)).not.toContain(job.id);
    const afterClaim = await rawClient.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterClaim.status).toBe("COMPLETED");
    expect(afterClaim.attempts).toBe(0);
  });

  it("RET-OUTBOX-DEDUPE-01：PUBLISHED → tombstone → 同 dedupeKey 重放被拒；永不 dispatch", async () => {
    const dedupeKey = unique("RET-OUT-DEDUPE");
    const event = await seedPublishedEvent({ dedupeKey });

    const summary = await tombstonePublishedOutboxEvents({ retentionDays: RETENTION_DAYS, now: NOW });
    expect(summary.tombstoned).toBeGreaterThanOrEqual(1);

    const tombstoned = await rawClient.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(tombstoned.status).toBe("PUBLISHED");
    expect(tombstoned.tombstonedAt).not.toBeNull();
    expect(tombstoned.payload).toEqual(PHASE9_RETENTION_TOMBSTONE_MARKER);
    expect(tombstoned.dedupeKey).toBe(dedupeKey);
    expect(tombstoned.publishedAt).not.toBeNull();

    const replay = await withTransaction((tx) =>
      recordOutboxEventTx(tx, {
        eventType: "PRODUCT_RESERVATION_EXPIRED",
        schemaVersion: 1,
        aggregateType: "ORDER",
        aggregateId: tombstoned.aggregateId,
        dedupeKey,
        payload: { orderId: tombstoned.aggregateId },
      }),
    );
    expect(replay.recorded).toBe(false);
    expect(await rawClient.outboxEvent.count({ where: { dedupeKey } })).toBe(1);

    // §58：PUBLISHED tombstone 永不 dispatch
    const dispatched = await withTransaction((tx) =>
      claimDueOutboxEvents(tx, { workerId: "it-9c04", leaseSeconds: 60, batchSize: 100, now: NOW }),
    );
    expect(dispatched.map((row) => row.id)).not.toContain(event.id);
    const afterClaim = await rawClient.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(afterClaim.status).toBe("PUBLISHED");
  });

  it("RET-JOB-BOUNDED-01：100 旧 COMPLETED，batchLimit=10 → 每轮 <= 10，重复至全量收敛", async () => {
    const batchSize = 100;
    const batchLimit = 10;
    const keys = Array.from({ length: batchSize }, () => unique("RET-BOUNDED"));
    await rawClient.asyncJob.createMany({
      data: keys.map((dedupeKey) => ({
        kind: "PRODUCT_RESERVATION_EXPIRE",
        schemaVersion: 1,
        dedupeKey,
        payload: { orderId: dedupeKey },
        status: "COMPLETED",
        runAt: OLD,
        completedAt: OLD,
      })),
    });

    let totalTombstoned = 0;
    let rounds = 0;
    for (;;) {
      const summary = await tombstoneCompletedAsyncJobs({
        retentionDays: RETENTION_DAYS,
        now: NOW,
        batchLimit,
      });
      expect(summary.tombstoned).toBeLessThanOrEqual(batchLimit);
      if (summary.tombstoned === 0) {
        break;
      }
      totalTombstoned += summary.tombstoned;
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(batchSize); // 防死循环
    }

    expect(totalTombstoned).toBe(batchSize);
    const tombstonedCount = await rawClient.asyncJob.count({
      where: { dedupeKey: { in: keys }, tombstonedAt: { not: null } },
    });
    expect(tombstonedCount).toBe(batchSize);
  });

  it("RET-OUTBOX-BOUNDED-01：100 旧 PUBLISHED，batchLimit=10 → bounded 全量收敛", async () => {
    const batchSize = 100;
    const batchLimit = 10;
    const keys = Array.from({ length: batchSize }, () => unique("RET-OUT-BOUNDED"));
    await rawClient.outboxEvent.createMany({
      data: keys.map((dedupeKey) => ({
        eventType: "PRODUCT_RESERVATION_EXPIRED",
        schemaVersion: 1,
        aggregateType: "ORDER",
        aggregateId: dedupeKey,
        dedupeKey,
        payload: { orderId: dedupeKey },
        status: "PUBLISHED",
        availableAt: OLD,
        publishedAt: OLD,
      })),
    });

    let totalTombstoned = 0;
    let rounds = 0;
    for (;;) {
      const summary = await tombstonePublishedOutboxEvents({
        retentionDays: RETENTION_DAYS,
        now: NOW,
        batchLimit,
      });
      expect(summary.tombstoned).toBeLessThanOrEqual(batchLimit);
      if (summary.tombstoned === 0) {
        break;
      }
      totalTombstoned += summary.tombstoned;
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(batchSize);
    }

    expect(totalTombstoned).toBe(batchSize);
  });

  it("RET-RACE-JOB-01：两个并发 retention worker → tombstone 逻辑转移恰好一次", async () => {
    const job = await seedCompletedJob();

    const [a, b] = await Promise.all([
      tombstoneCompletedAsyncJobs({ retentionDays: RETENTION_DAYS, now: NOW }),
      tombstoneCompletedAsyncJobs({ retentionDays: RETENTION_DAYS, now: NOW }),
    ]);

    expect(a.tombstoned + b.tombstoned).toBe(1);
    const row = await rawClient.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.tombstonedAt).not.toBeNull();
    expect(row.payload).toEqual(PHASE9_RETENTION_TOMBSTONE_MARKER);
  });

  it("RET-RACE-OUTBOX-01：两个并发 retention worker → outbox tombstone 恰好一次", async () => {
    const event = await seedPublishedEvent();

    const [a, b] = await Promise.all([
      tombstonePublishedOutboxEvents({ retentionDays: RETENTION_DAYS, now: NOW }),
      tombstonePublishedOutboxEvents({ retentionDays: RETENTION_DAYS, now: NOW }),
    ]);

    expect(a.tombstoned + b.tombstoned).toBe(1);
    const row = await rawClient.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.tombstonedAt).not.toBeNull();
  });

  it("RET-NOTIFICATION-PII-01：accepted 超窗 → destination redacted，provenance 保留", async () => {
    const delivery = await seedDelivery({
      destination: "ret-pii-student@campus.edu",
      providerAcceptedAt: OLD,
      providerMessageId: "prov-msg-1",
    });

    const summary = await redactTerminalNotificationDestinations({
      retentionDays: RETENTION_DAYS,
      now: NOW,
    });
    expect(summary.redacted).toBeGreaterThanOrEqual(1);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.destination).toBe(REDACTED_EMAIL_DESTINATION);
    expect(row.redactedAt).not.toBeNull();
    // PII 消失，delivery provenance 保留（§17）
    expect(row.providerMessageId).toBe("prov-msg-1");
    expect(row.providerIdempotencyKey).toBe(delivery.providerIdempotencyKey);
    expect(row.providerAcceptedAt).toEqual(OLD);
    expect(row.suppressedAt).toBeNull();
  });

  it("RET-NOTIFICATION-SUPPRESSED-01：suppressed 超窗 → destination redacted", async () => {
    const delivery = await seedDelivery({
      destination: "ret-supp-student@campus.edu",
      suppressedAt: OLD,
      suppressionCode: "PROVIDER_DISABLED",
    });

    await redactTerminalNotificationDestinations({ retentionDays: RETENTION_DAYS, now: NOW });

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.destination).toBe(REDACTED_EMAIL_DESTINATION);
    expect(row.redactedAt).not.toBeNull();
    expect(row.suppressedAt).toEqual(OLD);
    expect(row.suppressionCode).toBe("PROVIDER_DISABLED");
  });

  it("RET-NOTIFICATION-RECENT-01：terminal 年龄 < retentionDays → 不得 redaction", async () => {
    const delivery = await seedDelivery({
      destination: "ret-recent-student@campus.edu",
      providerAcceptedAt: NOW,
    });

    const summary = await redactTerminalNotificationDestinations({
      retentionDays: RETENTION_DAYS,
      now: NOW,
    });
    // 本用例 DB 中已无其它旧 terminal 候选（前序用例均已收敛）
    expect(summary.redacted).toBe(0);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.destination).toBe("ret-recent-student@campus.edu");
    expect(row.redactedAt).toBeNull();
  });

  it("RET-NOTIFICATION-PENDING-01：pending（双 anchor 皆空）无论多老 → destination 不变", async () => {
    const delivery = await seedDelivery({
      destination: "ret-pending-student@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
      createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });

    const summary = await redactTerminalNotificationDestinations({
      retentionDays: RETENTION_DAYS,
      now: NOW,
    });
    expect(summary.redacted).toBe(0);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.destination).toBe("ret-pending-student@campus.edu");
    expect(row.redactedAt).toBeNull();
    expect(row.providerAcceptedAt).toBeNull();
    expect(row.suppressedAt).toBeNull();
  });

  it("RET-RACE-DELIVERY-01：两个并发 maintenance worker → redactedAt 转移恰好一次", async () => {
    const delivery = await seedDelivery({
      destination: "ret-race-student@campus.edu",
      providerAcceptedAt: OLD,
    });

    // §60：完整 maintenance orchestrator 级并发（不是单函数）
    const [a, b] = await Promise.all([
      runPhase9RetentionMaintenance({ retentionDays: RETENTION_DAYS, now: NOW }),
      runPhase9RetentionMaintenance({ retentionDays: RETENTION_DAYS, now: NOW }),
    ]);

    expect(
      a.notificationDestinationsRedacted + b.notificationDestinationsRedacted,
    ).toBe(1);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.destination).toBe(REDACTED_EMAIL_DESTINATION);
    expect(row.redactedAt).not.toBeNull();
  });

  it("RECON-NOTIFICATION-DL-01：未收敛 DEAD_LETTER → canonical suppression；重放 0 mutation", async () => {
    const delivery = await seedDelivery({
      destination: "recon-dl-student@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    await seedNotificationDeadLetterJob(delivery.id);

    const first = await reconcileDeadLetterNotificationDeliveries({ now: NOW });
    expect(first.scannedCanonical).toBeGreaterThanOrEqual(1);
    expect(first.reconciled).toBe(1);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.suppressedAt).not.toBeNull();
    expect(row.suppressionCode).toBe(NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER);

    // 幂等：再次 reconcile → canonical 已收敛的行退出 discovery → 0 mutation
    const second = await reconcileDeadLetterNotificationDeliveries({ now: NOW });
    expect(second.scannedCanonical).toBe(0);
    expect(second.reconciled).toBe(0);
    const rowAfter = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(rowAfter.suppressedAt).toEqual(row.suppressedAt);
    expect(rowAfter.suppressionCode).toBe(NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER);
  });

  it("RECON-NOTIFICATION-ACCEPTED-01：provider-accepted 的 DEAD_LETTER 异常 → 绝不改写 accepted provenance", async () => {
    // §50/§15：accepted provenance 是外部投递事实——reconcile 不得伪称
    // suppressed；且 anomaly 行不进入 actionable batch（RB01，不阻塞别人）
    const acceptedDelivery = await seedDelivery({
      destination: "recon-accepted-student@campus.edu",
      providerAcceptedAt: OLD,
    });
    const acceptedJob = await seedNotificationDeadLetterJob(acceptedDelivery.id);

    // §37/§38：引用缺失 delivery 的 canonical DEAD_LETTER = structural
    // anomaly——只报告，绝不猜测修复（用后清理：不污染后续 strict 检查）
    const missingDeliveryId = unique("missing-delivery");
    const missingDeliveryJob = await seedNotificationDeadLetterJob(missingDeliveryId);

    const summary = await reconcileDeadLetterNotificationDeliveries({ now: NOW });
    // anomaly 行不进入 canonical actionable discovery（RB01/RB02）
    expect(summary.scannedCanonical).toBe(0);
    expect(summary.reconciled).toBe(0);

    // structural counts（ops strict path，RB02 §12）：accepted anomaly 与
    // missing delivery 各自可见
    const { getPhase9StructuralInconsistencies } = await import("@/lib/async/phase9-ops");
    const inconsistencies = await getPhase9StructuralInconsistencies();
    expect(inconsistencies.notificationDeadLetterAcceptedAnomaly).toBeGreaterThanOrEqual(1);
    expect(inconsistencies.notificationDeadLetterMissingDelivery).toBeGreaterThanOrEqual(1);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: acceptedDelivery.id },
    });
    expect(row.suppressedAt).toBeNull();
    expect(row.suppressionCode).toBeNull();
    expect(row.providerAcceptedAt).toEqual(OLD);
    expect(row.destination).toBe("recon-accepted-student@campus.edu");

    // 清理 structural-violation fixtures（不污染后续 strict 检查；
    // anomaly 行为只报告不修复——这里是测试夹具自身的回收）
    await rawClient.asyncJob.delete({ where: { id: missingDeliveryJob.id } });
    await rawClient.asyncJob.delete({ where: { id: acceptedJob.id } });
  });

  it("RECON-NOTIFICATION-FAIRNESS-01（RB01）：resolved/anomaly 不占 batch——unresolved 有限轮次内必然收敛", async () => {
    // 构造：10 条更老的 resolved（canonical binding + delivery 已 suppressed）
    // DEAD_LETTER job + 1 条较新的 canonical unresolved。旧实现 discovery
    // 不过滤 resolved/anomaly，batchLimit=10 时较新 unresolved 永久饥饿
    //（本测试在旧实现上第一轮 reconciled=0 → FAIL）；新实现 discovery 在
    // SQL 层只选 canonical actionable 候选 → 第一轮即收敛。
    const batchLimit = 10;
    for (let i = 0; i < batchLimit; i += 1) {
      // suppressedAt 用近期时间：resolved 行不成为 PII redaction 候选，
      // 保持本用例对 reconcile 行为的断言纯净
      const resolvedDelivery = await seedDelivery({
        destination: `fair-resolved-${i}@campus.edu`,
        suppressedAt: NOW,
        suppressionCode: "PROVIDER_DISABLED",
      });
      await seedNotificationDeadLetterJob(resolvedDelivery.id, undefined, OLD);
    }
    const target = await seedDelivery({
      destination: "fair-target@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    await seedNotificationDeadLetterJob(target.id, undefined, NOW);

    const first = await reconcileDeadLetterNotificationDeliveries({
      now: NOW,
      batchLimit,
    });

    // 第一轮即收敛（旧实现：scanned 全为 resolved → reconciled=0 → FAIL）
    expect(first.scannedCanonical).toBe(1);
    expect(first.reconciled).toBe(1);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.suppressedAt).not.toBeNull();
    expect(row.suppressionCode).toBe(NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER);
    // 更老的 resolved 行不被重复触碰（幂等收敛状态保持）
    const resolvedStill = await rawClient.notificationDelivery.findFirstOrThrow({
      where: { destination: "fair-resolved-0@campus.edu" },
    });
    expect(resolvedStill.suppressionCode).toBe("PROVIDER_DISABLED");
  });

  it("RECON-NOTIFICATION-INVALID-PAYLOAD-01（RB02）：payload 非 strict {deliveryId} → 0 mutation，只报告", async () => {
    // 构造：delivery A unresolved + DEAD_LETTER job 的 payload 带 extra 键
    //（zod .strict() 拒绝）但 dedupeKey 与 payload.deliveryId 一致。
    // 旧实现：payload parse 失败 → fallback dedupeKey → 自动 suppress A
    //（structural corruption 经未证明字段猜测修复——本测试在旧实现 FAIL）；
    // 新实现：invalid payload 不进 actionable batch，A 保持原状，仅计数。
    const deliveryA = await seedDelivery({
      destination: "invalid-payload-a@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    const badJob = await seedRawNotificationDeadLetterJob({
      dedupeKey: `NOTIFICATION_DELIVERY:${deliveryA.id}`,
      payload: { deliveryId: deliveryA.id, extra: true },
    });

    const summary = await reconcileDeadLetterNotificationDeliveries({ now: NOW, batchLimit: 10 });
    expect(summary.scannedCanonical).toBe(0);
    expect(summary.reconciled).toBe(0);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryA.id },
    });
    expect(row.suppressedAt).toBeNull();
    expect(row.suppressionCode).toBeNull();
    expect(row.destination).toBe("invalid-payload-a@campus.edu");

    const { getPhase9StructuralInconsistencies } = await import("@/lib/async/phase9-ops");
    const inconsistencies = await getPhase9StructuralInconsistencies();
    expect(inconsistencies.notificationDeadLetterInvalidPayload).toBeGreaterThanOrEqual(1);

    // fixture 回收（structural corruption 只报告不修复；测试自清不污染后续）
    await rawClient.asyncJob.delete({ where: { id: badJob.id } });
  });

  it("RECON-NOTIFICATION-BINDING-MISMATCH-01（RB02）：payload B / dedupeKey A → A、B 都不动 + strict FAIL", async () => {
    // 构造：payload.deliveryId = B，dedupeKey = NOTIFICATION_DELIVERY:A。
    // 旧实现：payload parse 成功 → 自动 suppress B（不同代码路径认不同
    // delivery——本测试在旧实现 FAIL）；新实现：binding 不一致 = structural
    // anomaly，0 automatic reconciliation。
    const deliveryA = await seedDelivery({
      destination: "mismatch-a@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    const deliveryB = await seedDelivery({
      destination: "mismatch-b@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    const mismatchJob = await seedRawNotificationDeadLetterJob({
      dedupeKey: `NOTIFICATION_DELIVERY:${deliveryA.id}`,
      payload: { deliveryId: deliveryB.id },
    });

    const summary = await reconcileDeadLetterNotificationDeliveries({ now: NOW, batchLimit: 10 });
    expect(summary.scannedCanonical).toBe(0);
    expect(summary.reconciled).toBe(0);

    const rowA = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryA.id },
    });
    const rowB = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryB.id },
    });
    for (const row of [rowA, rowB]) {
      expect(row.suppressedAt).toBeNull();
      expect(row.suppressionCode).toBeNull();
    }
    expect(rowA.destination).toBe("mismatch-a@campus.edu");
    expect(rowB.destination).toBe("mismatch-b@campus.edu");

    const { getPhase9StructuralInconsistencies } = await import("@/lib/async/phase9-ops");
    const inconsistencies = await getPhase9StructuralInconsistencies();
    expect(inconsistencies.notificationDeadLetterBindingMismatch).toBeGreaterThanOrEqual(1);
    expect(inconsistencies.any).toBe(true);

    // §13/§14：strict CLI 对 binding mismatch → FAIL + exit 1（非 strict
    // 仍 exit 0，attentionRequired 表达）
    const strict = await runPhase9StatusCli(["--strict"], { DATABASE_URL: isolatedUrl });
    expect(strict.code).toBe(1);
    const failPayload = JSON.parse(strict.stdout) as {
      result: string;
      structuralInconsistencies: { notificationDeadLetterBindingMismatch: number };
    };
    expect(failPayload.result).toBe("FAIL");
    expect(failPayload.structuralInconsistencies.notificationDeadLetterBindingMismatch).toBeGreaterThanOrEqual(1);
    const nonStrict = await runPhase9StatusCli([], { DATABASE_URL: isolatedUrl });
    expect(nonStrict.code).toBe(0);

    // fixture 回收
    await rawClient.asyncJob.delete({ where: { id: mismatchJob.id } });
  });

  it("RET-ERASURE-REDACT-01（RB03）：retention 先 redact → erasure 不得覆盖 redactedAt", async () => {
    // 旧实现：erasure 无条件 redactedAt = erasedEmailAt（覆盖 T1）→ 本测试
    // FAIL；新实现：redactedAt 只 NULL → timestamp 单向迁移（INV-R1-05），
    // 但 destination 仍无条件收敛（INV-R1-06）。
    const user = await createErasureFixtureUser("redact-monotonic");
    const notification = await seedNotificationForUser(user.id);
    const delivery = await seedDelivery({
      destination: "erasure-redact-student@campus.edu",
      providerAcceptedAt: OLD,
      providerMessageId: "msg-redact-monotonic",
    });
    await rawClient.notificationDelivery.update({
      where: { id: delivery.id },
      data: { notificationId: notification.id },
    });

    // Step 1：retention 先完成第一次 redaction（T1 = retentionNow）
    const retentionNow = new Date(Date.now() - 5_000);
    const summary = await redactTerminalNotificationDestinations({
      retentionDays: RETENTION_DAYS,
      now: retentionNow,
    });
    expect(summary.redacted).toBeGreaterThanOrEqual(1);
    const afterRetention = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(afterRetention.destination).toBe(REDACTED_EMAIL_DESTINATION);
    expect(afterRetention.redactedAt).toEqual(retentionNow);

    // Step 2：account erasure 后到——destination 保持 sentinel（目标 A），
    // redactedAt 保持 T1（目标 B）
    await eraseAccount(user.id);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(row.destination).toBe(REDACTED_EMAIL_DESTINATION);
    expect(row.redactedAt).toEqual(retentionNow);
    expect(row.suppressedAt).toBeNull();
    expect(row.suppressionCode).toBeNull();
    expect(row.providerAcceptedAt).toEqual(OLD);
    expect(row.providerMessageId).toBe("msg-redact-monotonic");
  });

  it("RET-ERASURE-REDACT-RACE-01（RB03）：erasure 持行锁在先 → retention 后到零覆盖，首次时间戳保留", async () => {
    // 受控 barrier（真实 PG 行锁，零 sleep）：erasure 事务在 racePoint 时
    // 已写入 destination + redactedAt（未提交、持行锁）；racePoint 中发射
    // retention（不 await——await 会形成应用层死锁）。retention 的
    // updateMany 阻塞至 erasure 提交，随后按 READ COMMITTED 重评谓词
    //（redactedAt IS NULL 已不成立）→ 0 转移。最终：destination sentinel +
    // redactedAt = erasure 首次 transition 时间（INV-R1-07；retention-first
    // ordering 的 teeth 见 RET-ERASURE-REDACT-01）。
    const user = await createErasureFixtureUser("redact-race");
    const notification = await seedNotificationForUser(user.id);
    const delivery = await seedDelivery({
      destination: "erasure-race-student@campus.edu",
      providerAcceptedAt: OLD,
    });
    await rawClient.notificationDelivery.update({
      where: { id: delivery.id },
      data: { notificationId: notification.id },
    });

    const retentionNow = new Date();
    let retentionPromise: Promise<{ redacted: number }> | null = null;
    await eraseAccount(user.id, undefined, undefined, async () => {
      retentionPromise = redactTerminalNotificationDestinations({
        retentionDays: RETENTION_DAYS,
        now: retentionNow,
      });
    });
    expect(retentionPromise).not.toBeNull();
    const summary = await retentionPromise!;

    // retention 后到：零转移（erasure 的 redactedAt 已占位）
    expect(summary.redacted).toBe(0);

    const row = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(row.destination).toBe(REDACTED_EMAIL_DESTINATION);
    expect(row.redactedAt).not.toBeNull();
    // 首次 transition 决定时间戳：不是 retention 的 now（retention 0 转移）
    expect(row.redactedAt!.getTime()).not.toBe(retentionNow.getTime());
    expect(row.suppressedAt).toBeNull();
    expect(row.suppressionCode).toBeNull();
    expect(row.providerAcceptedAt).toEqual(OLD);
  });

  it("RET-DRY-RUN-01：retention backlog 存在 → planned > 0 且零 mutation", async () => {
    const job = await seedCompletedJob();
    const event = await seedPublishedEvent();
    const delivery = await seedDelivery({
      destination: "ret-dry-student@campus.edu",
      providerAcceptedAt: OLD,
    });
    const pendingDelivery = await seedDelivery({
      destination: "ret-dry-pending@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    const dlDelivery = await seedDelivery({
      destination: "ret-dry-dl@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    const dlJob = await seedNotificationDeadLetterJob(dlDelivery.id);

    const summary = await runPhase9RetentionMaintenance({ dryRun: true, retentionDays: RETENTION_DAYS, now: NOW });

    // planned > 0（§59）
    expect(summary.dryRun).toBe(true);
    expect(summary.asyncJobsTombstoned).toBeGreaterThanOrEqual(1);
    expect(summary.outboxEventsTombstoned).toBeGreaterThanOrEqual(1);
    expect(summary.notificationDestinationsRedacted).toBeGreaterThanOrEqual(1);
    expect(summary.notificationDeadLettersReconciled).toBeGreaterThanOrEqual(1);
    expect(summary.phase9Failures).toBe(0);

    // 零 mutation（§25：不是"update 后 rollback"假装）
    const jobAfter = await rawClient.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfter.tombstonedAt).toBeNull();
    expect(jobAfter.payload).toEqual({ orderId: expect.any(String) });
    const eventAfter = await rawClient.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(eventAfter.tombstonedAt).toBeNull();
    const deliveryAfter = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(deliveryAfter.destination).toBe("ret-dry-student@campus.edu");
    expect(deliveryAfter.redactedAt).toBeNull();
    const pendingAfter = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: pendingDelivery.id },
    });
    expect(pendingAfter.destination).toBe("ret-dry-pending@campus.edu");
    const dlDeliveryAfter = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: dlDelivery.id },
    });
    expect(dlDeliveryAfter.suppressedAt).toBeNull();
    const dlJobAfter = await rawClient.asyncJob.findUniqueOrThrow({ where: { id: dlJob.id } });
    expect(dlJobAfter.status).toBe("DEAD_LETTER");

    // 真实执行后 backlog 收敛（同一批候选全部转移，pending 保护行不动）
    const applied = await runPhase9RetentionMaintenance({ retentionDays: RETENTION_DAYS, now: NOW });
    expect(applied.asyncJobsTombstoned).toBeGreaterThanOrEqual(1);
    expect(applied.notificationDeadLettersReconciled).toBeGreaterThanOrEqual(1);
    expect(applied.notificationDestinationsRedacted).toBeGreaterThanOrEqual(1);
    const dlDeliveryApplied = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: dlDelivery.id },
    });
    expect(dlDeliveryApplied.suppressedAt).not.toBeNull();
    // suppression 发生在本周期（terminal age ≈ 0 < 窗口）——destination
    // 保持原值，待 terminal 超窗后由后续周期 redact（anchor 语义 §21）
    expect(dlDeliveryApplied.destination).toBe("ret-dry-dl@campus.edu");
    const pendingApplied = await rawClient.notificationDelivery.findUniqueOrThrow({
      where: { id: pendingDelivery.id },
    });
    expect(pendingApplied.destination).toBe("ret-dry-pending@campus.edu"); // pending 保护
  });

  it("PHASE9-OPS-NO-SECRET-01：ops CLI stdout 零秘密；strict 结构检查与 attentionRequired 语义", async () => {
    // 含秘密形态的 fixture：真实邮箱 destination、raw payload、
    // lastErrorMessage、dedupeKey——任何一项泄漏进 stdout 即 FAIL
    const secretDelivery = await seedDelivery({
      destination: "secret-user@campus.edu",
      providerAcceptedAt: OLD,
    });
    await seedCompletedJob({
      dedupeKey: `SECRET-DEDUPE-${unique("k")}`,
      lastErrorMessage: "SECRET-ERROR-TEXT-should-never-leak",
    });

    const cliEnv = { DATABASE_URL: isolatedUrl };

    const pass = await runPhase9StatusCli([], cliEnv);
    expect(pass.code).toBe(0);
    const payload = JSON.parse(pass.stdout) as {
      result: string;
      attentionRequired: boolean;
      asyncJobs: { completed: number; tombstoned: number };
      email: { accepted: number; piiRedactionBacklog: number };
    };
    expect(payload.result).toBe("PASS");
    expect(payload.asyncJobs.completed).toBeGreaterThan(0);
    expect(payload.asyncJobs.tombstoned).toBeGreaterThan(0);
    expect(payload.email.accepted).toBeGreaterThan(0);

    // §81：全量 stdout 秘密扫描
    expect(pass.stdout).not.toContain("@");
    expect(pass.stdout).not.toContain("secret-user");
    expect(pass.stdout).not.toContain("SECRET-ERROR-TEXT");
    expect(pass.stdout).not.toContain("SECRET-DEDUPE");
    expect(pass.stdout).not.toContain("private/data-exports/");
    expect(pass.stdout).not.toContain("bucket");
    expect(pass.stdout).not.toContain("objectKey");
    expect(pass.stdout).not.toContain("destination");
    expect(pass.stdout).not.toContain("payload");
    expect(pass.stdout).not.toContain("postgresql://");
    expect(pass.stdout).not.toContain("redis://");
    expect(pass.stdout).not.toContain("X-Amz-");
    expect(pass.stderr).not.toContain("postgresql://");

    // --strict：无 structural violation → PASS + exit 0
    const strictPass = await runPhase9StatusCli(["--strict"], cliEnv);
    expect(strictPass.code).toBe(0);
    expect((JSON.parse(strictPass.stdout) as { result: string }).result).toBe("PASS");

    // §37：注入 structural invariant violation（COMPLETED 但 completedAt null）
    await rawClient.asyncJob.create({
      data: {
        kind: "PRODUCT_RESERVATION_EXPIRE",
        schemaVersion: 1,
        dedupeKey: unique("RET-STRUCTURAL"),
        payload: { orderId: "structural" },
        status: "COMPLETED",
        runAt: NOW,
        completedAt: null,
      },
    });
    const strictFail = await runPhase9StatusCli(["--strict"], cliEnv);
    expect(strictFail.code).toBe(1);
    const failPayload = JSON.parse(strictFail.stdout) as {
      result: string;
      structuralInconsistencies: { completedJobsMissingTerminalAt: number; any: boolean };
    };
    expect(failPayload.result).toBe("FAIL");
    expect(failPayload.structuralInconsistencies.completedJobsMissingTerminalAt).toBeGreaterThanOrEqual(1);
    expect(failPayload.structuralInconsistencies.any).toBe(true);

    // §36：仅 dead letter / 结构 violation 的语义边界——非 strict 下 violation
    // 通过 result 表达（PASS→FAIL），但进程不因 attentionRequired 崩溃
    const nonStrictWithViolation = await runPhase9StatusCli([], cliEnv);
    expect(nonStrictWithViolation.code).toBe(0);

    // DEAD_LETTER 存在 → attentionRequired=true 但 result=PASS（§36）
    const dlDelivery = await seedDelivery({
      destination: "ops-attention@campus.edu",
      providerAcceptedAt: null,
      suppressedAt: null,
    });
    await seedNotificationDeadLetterJob(dlDelivery.id);
    const attention = await runPhase9StatusCli([], cliEnv);
    expect(attention.code).toBe(0);
    const attentionPayload = JSON.parse(attention.stdout) as {
      result: string;
      attentionRequired: boolean;
      email: { unresolvedDeadLetter: number };
    };
    expect(attentionPayload.result).toBe("PASS");
    expect(attentionPayload.attentionRequired).toBe(true);
    expect(attentionPayload.email.unresolvedDeadLetter).toBeGreaterThanOrEqual(1);

    expect(secretDelivery.destination).toContain("@"); // sanity：fixture 本身含秘密
  });
  },
);

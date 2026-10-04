import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { PermanentJobFailure, dataExportGeneratePayloadSchema } from "@/lib/async/job-types";
import { enqueueAsyncJobTx } from "@/lib/async/job-repository";
import {
  DATA_EXPORT_GENERATE_JOB_KIND,
  DATA_EXPORT_GENERATE_JOB_SCHEMA_VERSION,
  type ClaimedAsyncJob,
  type JobExecutionOutcome,
} from "@/lib/async/job-types";
import type { ActiveAccountMutationSeams } from "@/lib/governance/active-account-mutation";
import { prepareActiveAccountMutation } from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { governanceError } from "@/lib/governance/domain-errors";
import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import { isRbacError } from "@/lib/rbac/errors";
import { getStorage } from "@/lib/storage";
import {
  findArtifactByRequestIdTx,
  transitionDataExportArtifact,
} from "@/lib/privacy/data-export-artifact";
import {
  DATA_EXPORT_ARTIFACT_CACHE_CONTROL,
  DATA_EXPORT_ARTIFACT_MIME_TYPE,
  DATA_EXPORT_REJECT_REASON,
  DATA_EXPORT_S3_PUT_OPERATION_TIMEOUT_MS,
  buildDataExportObjectKey,
  dataExportArtifactBucket,
  dataExportArtifactExpiresAt,
  dataExportArtifactMaxBytes,
} from "@/lib/privacy/data-export-contract";
import {
  assertNoForbiddenExportFields,
  buildUserExport,
  DataExportSecurityValidationError,
  type UserExportPayload,
} from "@/lib/privacy/data-export";
import { transitionPrivacyRequest } from "@/lib/privacy/privacy-request-service";

/**
 * Phase 9C-03：durable async data export 服务层（唯一 production 创建与
 * 执行 authority）。
 *
 * lifecycle（authoritative，§4）：
 *
 *   HTTP createAsyncDataExportRequest：
 *     USER governance lock → fresh active-account check
 *     → PrivacyRequest(DATA_EXPORT, REQUESTED) + AsyncJob
 *       DATA_EXPORT_GENERATE@1 {requestId}
 *     → 同一事务 COMMIT（§6 原子落盘：绝不允许 request committed + job
 *       missing，或反向；enqueue 契约校验失败整体回滚零落库）
 *
 *   Worker handler（processDataExportGenerateJob，Step A/B §13）：
 *     Step A prepare：REQUESTED → IN_PROGRESS + DataExportArtifact WRITING
 *       （deterministic object key，任何 S3 PUT 之前 durable 落库 = recovery
 *       anchor）→ COMMIT → RESCHEDULE 立即
 *     Step B generate：USER 锁内 fresh 复核 → buildUserExport（唯一 DTO
 *       authority，§42）→ 序列化 → 资源上界检查（§15，超限 REJECTED 不
 *       截断）→ PUT deterministic object（ambiguous PUT 安全：WRITING
 *       anchor + 重试覆盖同一 key，§12）→ artifact READY + request
 *       COMPLETED（同一事务）
 *
 *   失败收敛（§19/§20/§21）：
 *     - handler 内可判定 permanent（结构损坏 / owner inactive / too-large）
 *       → 事务内 REJECT request + job 正常 COMPLETED（intent 已收敛）；
 *     - 瞬态（S3/DB）→ throw → AsyncJob RETRY（backoff），request 保持
 *       IN_PROGRESS 合法非终态；
 *     - retry 预算耗尽 → DEAD_LETTER → reconcileDataExportDeadLetters()
 *       （scoped、幂等、bounded，生产 worker 每周期执行）收敛
 *       REJECTED——绝不永久 IN_PROGRESS。
 *
 * snapshot 语义（§44）：buildUserExport 使用普通 DB 读——export 是生成
 * 期间的 best-effort point-in-time logical snapshot；request lifecycle 与
 * artifact finalization 有明确事务边界，业务表不承诺单一 DB snapshot。
 *
 * erasure race（§22/§23）：export 侧在 build/finalize 全程持有 USER
 * governance lock——
 *   export wins：READY + COMPLETED 先提交，随后 erasure 标记 artifact
 *     PENDING_DELETE（注销后下载立即拒绝，对象物理删除）；
 *   erasure wins：worker 锁内 fresh 复核见 erased/inactive → REJECT +
 *     artifact PENDING_DELETE，绝不复活 artifact。
 */

const RECONCILE_BATCH_LIMIT = 10;

export type AsyncDataExportRequestResult = {
  request: {
    id: string;
    type: "DATA_EXPORT";
    status: "REQUESTED";
    requestedAt: string;
  };
};

/**
 * 唯一 production 创建入口（§6）：PrivacyRequest + AsyncJob 原子落盘。
 *
 * 被删除的 createDataExportRequest footgun（"只建 REQUESTED 不 enqueue"）
 * 不复活：本函数不提供任何"只建请求"的路径，enqueue 失败即整体回滚。
 * 并发重复（双击 / 多 tab / HTTP retry）由 partial unique index 兜底
 * （P2002 → DATA_EXPORT_ALREADY_ACTIVE 稳定 machine code，§7）。
 */
export async function createAsyncDataExportRequest(
  userId: string,
  activeAccountSeams?: ActiveAccountMutationSeams,
): Promise<AsyncDataExportRequestResult> {
  try {
    return await withTransaction(async (tx) => {
      // RB-03 contract：guard 在 PrivacyRequest.create 之前——race-loss 零新 request
      await prepareActiveAccountMutation(tx, userId, activeAccountSeams);

      const created = await tx.privacyRequest.create({
        data: { userId, type: "DATA_EXPORT", status: "REQUESTED" },
      });

      // §6 原子落盘：job intent 与 request 同事务。dedupeKey =
      // DATA_EXPORT_GENERATE:<requestId>——一个 request 恰好一个
      // canonical generation intent（§5）。
      const enqueued = await enqueueAsyncJobTx(tx, {
        kind: DATA_EXPORT_GENERATE_JOB_KIND,
        schemaVersion: DATA_EXPORT_GENERATE_JOB_SCHEMA_VERSION,
        dedupeKey: `${DATA_EXPORT_GENERATE_JOB_KIND}:${created.id}`,
        payload: { requestId: created.id },
        runAt: new Date(),
      });

      if (!enqueued.recorded) {
        // dedupeKey 撞车（requestId 全局唯一 cuid，理论不可达）防御：
        // 拒绝静默降级为"只建请求"
        throw new PermanentJobFailure(
          "DATA_EXPORT_JOB_DUPLICATE",
          "导出生成意图已存在（requestId 冲突）",
        );
      }

      logger.info("privacy_request_created", "privacy", {
        requestId: created.id,
        requestType: created.type,
      });

      return {
        request: {
          id: created.id,
          type: "DATA_EXPORT",
          status: "REQUESTED",
          requestedAt: created.requestedAt.toISOString(),
        },
      };
    });
  } catch (error) {
    // §7：并发重复创建稳定映射 DATA_EXPORT_ALREADY_ACTIVE
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      throw governanceError("DATA_EXPORT_ALREADY_ACTIVE");
    }

    throw error;
  }
}

/**
 * 非 terminal request 的 REJECTED 收敛（同事务内）。
 * REQUESTED 不允许直接 → REJECTED（状态机），先收敛 IN_PROGRESS。
 * artifact（若存在且非终态）→ PENDING_DELETE：对象可能已被 PUT
 * （ambiguous PUT / retry 后再失败），key 已被 WRITING 行 durable 追踪，
 * cleanup 必然物理收敛（§11/§12）。
 */
async function convergeDataExportRejectedTx(
  tx: Prisma.TransactionClient,
  request: { id: string; status: string; userId: string },
  reasonCode: string,
): Promise<void> {
  const artifact = await findArtifactByRequestIdTx(tx, request.id);

  if (artifact && (artifact.status === "WRITING" || artifact.status === "READY")) {
    await transitionDataExportArtifact(artifact.id, "PENDING_DELETE", { tx });
  }

  let currentStatus = request.status;

  if (currentStatus === "REQUESTED") {
    await transitionPrivacyRequest(request.id, "IN_PROGRESS", undefined, tx);
    currentStatus = "IN_PROGRESS";
  }

  if (currentStatus === "IN_PROGRESS") {
    await transitionPrivacyRequest(request.id, "REJECTED", { reasonCode }, tx);
  }
}

/** erasure-wins 的 reasonCode（erased 与 inactive 分离，§23）。 */
async function ownerInactiveReasonCode(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { erasedAt: true, deletedAt: true },
  });

  if (user?.erasedAt || user?.deletedAt) {
    return DATA_EXPORT_REJECT_REASON.OWNER_ERASED;
  }

  return DATA_EXPORT_REJECT_REASON.OWNER_INACTIVE;
}

export type DataExportJobOptions = {
  /** 仅测试注入（erasure-race barrier 等）；生产路径不传。 */
  activeAccountSeams?: ActiveAccountMutationSeams;
  /** 仅测试注入的 DTO builder seam；生产路径 = buildUserExport（§42）。 */
  builder?: (userId: string) => Promise<UserExportPayload>;
  now?: Date;
};

/**
 * DATA_EXPORT_GENERATE@1 canonical handler（Step A/B，§13）。
 *
 * 由 job-registry 注册；RB01 execution fence（runner 保证 handler 与
 * execution ownership 同事务）之后进入本函数。
 */
export async function processDataExportGenerateJob(
  tx: Prisma.TransactionClient,
  job: ClaimedAsyncJob,
  options: DataExportJobOptions = {},
): Promise<JobExecutionOutcome> {
  const now = options.now ?? new Date();

  // 执行边界 payload 复核（写边界已 strict 校验；此处防御 legacy
  // corruption / 手工改库——损坏 = PERMANENT → DEAD_LETTER → scoped
  // reconciler 收敛 request，§21）
  const parsed = dataExportGeneratePayloadSchema.safeParse(job.payload);

  if (!parsed.success) {
    throw new PermanentJobFailure(
      "DATA_EXPORT_JOB_PAYLOAD_INVALID",
      "DATA_EXPORT_GENERATE payload 未通过 strict 契约校验",
    );
  }

  const requestId = parsed.data.requestId;

  const request = await tx.privacyRequest.findUnique({ where: { id: requestId } });

  if (!request || request.type !== "DATA_EXPORT") {
    // request 行缺失 / 类型漂移：无 request 可收敛 → PERMANENT
    //（reconciler 的 EXISTS 谓词天然不匹配，不留悬挂面）
    throw new PermanentJobFailure(
      "DATA_EXPORT_REQUEST_MISSING",
      "导出请求不存在或类型漂移",
    );
  }

  // domain terminal → 重放幂等 no-op（EXPORT-CRASH-02：domain COMPLETED
  // commit 先于 job marker crash → replay 到这里收敛）
  if (
    request.status === "COMPLETED" ||
    request.status === "REJECTED" ||
    request.status === "CANCELLED"
  ) {
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  if (request.status === "BLOCKED") {
    // DATA_EXPORT 无 BLOCKED 路径：结构性损坏
    throw new PermanentJobFailure(
      "DATA_EXPORT_REQUEST_STATE_INVALID",
      "导出请求状态非法（BLOCKED）",
    );
  }

  // ---------------- Step A：prepare（durable recovery anchor，§13）----------------
  if (request.status === "REQUESTED") {
    try {
      await prepareActiveAccountMutation(tx, request.userId, options.activeAccountSeams);
    } catch (error) {
      if (isRbacError(error) && error.code === "AUTH_ACCOUNT_INACTIVE") {
        // erasure wins（§23）：绝不 READY/COMPLETED 可下载 artifact
        const reasonCode = await ownerInactiveReasonCode(tx, request.userId);
        await convergeDataExportRejectedTx(tx, request, reasonCode);
        logger.warn("privacy_export_converged_owner_inactive", "privacy", {
          event: "data_export_owner_inactive_converged",
          requestId: request.id,
          reasonCode,
        });
        return { kind: "COMPLETED" };
      }
      throw error;
    }

    await transitionPrivacyRequest(request.id, "IN_PROGRESS", undefined, tx);

    const existingArtifact = await findArtifactByRequestIdTx(tx, request.id);

    if (!existingArtifact) {
      await tx.dataExportArtifact.create({
        data: {
          requestId: request.id,
          userId: request.userId,
          status: "WRITING",
          bucket: dataExportArtifactBucket(),
          objectKey: buildDataExportObjectKey(request.userId, request.id),
        },
      });
    }

    // §13：anchor 已提交 → 立即 RESCHEDULE（RESCHEDULE 不计失败、不消耗
    // retry——durable anchor 与生成分离，crash at PUT boundary 时
    // WRITING 行已 durable，object key 始终可追踪）
    return { kind: "RESCHEDULE", runAt: now };
  }

  // ---------------- Step B：generate（request IN_PROGRESS）----------------
  const artifact = await findArtifactByRequestIdTx(tx, request.id);

  if (!artifact) {
    throw new PermanentJobFailure(
      "DATA_EXPORT_ARTIFACT_MISSING",
      "IN_PROGRESS 导出请求缺少 WRITING artifact anchor",
    );
  }

  try {
    await prepareActiveAccountMutation(tx, request.userId, options.activeAccountSeams);
  } catch (error) {
    if (isRbacError(error) && error.code === "AUTH_ACCOUNT_INACTIVE") {
      // erasure wins：WRITING/READY artifact → PENDING_DELETE + REJECTED
      const reasonCode = await ownerInactiveReasonCode(tx, request.userId);
      await convergeDataExportRejectedTx(tx, request, reasonCode);
      logger.warn("privacy_export_converged_owner_inactive", "privacy", {
        event: "data_export_owner_inactive_converged",
        requestId: request.id,
        reasonCode,
      });
      return { kind: "COMPLETED" };
    }
    throw error;
  }

  // 锁内 fresh 复核 artifact（erasure 可能在取锁前排队的时序里标记过）
  const freshArtifact = await findArtifactByRequestIdTx(tx, request.id);

  if (!freshArtifact || freshArtifact.status !== "WRITING") {
    // active user + 非 WRITING anchor = 结构性损坏（WRITING 只能由
    // finalization → READY 或收敛/注销 → PENDING_DELETE 离开，
    // 两者都不与"本次锁内 active 复核通过"共存）
    throw new PermanentJobFailure(
      "DATA_EXPORT_ARTIFACT_STATE_INVALID",
      "导出 artifact 状态非法（期望 WRITING）",
    );
  }

  // §42：buildUserExport 是唯一 user-data selection authority（普通 DB 读，
  // best-effort point-in-time snapshot）
  const build = options.builder ?? buildUserExport;

  // RB02：安全/隐私验证在执行边界强制——无论 builder（含未来扩展点）
  // 返回什么，载荷都必须通过禁止键扫描；违反 = 确定性结构/安全失败 =
  // PERMANENT fail closed（绝不 RETRY 调度）。keyPath 只存在于进程内异常
  // 本行被映射为受控 generic message——绝不写入 durable job 行或结构化
  // 日志。
  let payload: UserExportPayload;
  try {
    payload = await build(request.userId);
    assertNoForbiddenExportFields(payload);
  } catch (error) {
    if (error instanceof DataExportSecurityValidationError) {
      throw new PermanentJobFailure(
        "DATA_EXPORT_SECURITY_VALIDATION_FAILED",
        "导出载荷未通过安全验证",
      );
    }
    throw error;
  }

  // §17：compact JSON（不 pretty print）；v3 format 不变
  const serialized = Buffer.from(JSON.stringify(payload), "utf8");
  const sizeBytes = serialized.byteLength;

  // §15：async 资源上界——超限明确 REJECTED，不静默截断。此检查在 PUT
  // 之前（too-large 路径零外部副作用）。
  if (sizeBytes > dataExportArtifactMaxBytes()) {
    await convergeDataExportRejectedTx(tx, request, DATA_EXPORT_REJECT_REASON.TOO_LARGE);
    logger.warn("privacy_export_artifact_too_large", "privacy", {
      event: "data_export_artifact_too_large",
      requestId: request.id,
      sizeBytes,
      maxBytes: dataExportArtifactMaxBytes(),
    });
    return { kind: "COMPLETED" };
  }

  // §12：PUT deterministic object。任何此前 attempt 的 ambiguous PUT 都
  // 指向同一 key——重试覆盖写（S3 PUT 幂等），绝不产生第二个 random key。
  await getStorage().putObject({
    bucket: freshArtifact.bucket,
    objectKey: freshArtifact.objectKey,
    body: serialized,
    contentType: DATA_EXPORT_ARTIFACT_MIME_TYPE,
    cacheControl: DATA_EXPORT_ARTIFACT_CACHE_CONTROL,
    operationTimeoutMs: DATA_EXPORT_S3_PUT_OPERATION_TIMEOUT_MS,
  });

  // §26：TTL 从 artifact READY / request COMPLETED 起算
  const readyAt = new Date();
  await transitionDataExportArtifact(freshArtifact.id, "READY", {
    tx,
    finalize: {
      sizeBytes,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      expiresAt: dataExportArtifactExpiresAt(readyAt),
    },
  });
  const completed = await transitionPrivacyRequest(request.id, "COMPLETED", undefined, tx);

  logger.info("privacy_request_completed", "privacy", {
    requestId: completed.id,
    requestType: completed.type,
  });

  return { kind: "COMPLETED" };
}

export type DataExportDeadLetterReconciliationSummary = {
  scannedJobs: number;
  convergedRequests: number;
  artifactsMarkedForDeletion: number;
};

/**
 * §21 scoped dead-letter reconciler：只扫描
 *
 *   kind = DATA_EXPORT_GENERATE AND status = DEAD_LETTER
 *   AND EXISTS 非 terminal DATA_EXPORT request
 *
 * 收敛 request → REJECTED（stable reasonCode）+ WRITING/READY artifact →
 * PENDING_DELETE。幂等（收敛后不再匹配扫描谓词）、bounded batch、
 * 不触碰 COMPLETED/CANCELLED request、不扫描/修改其它 job kind。
 *
 * 覆盖的残余风险面：job DB 行被手工/外力损坏（写边界保证生产路径
 * payload 恒合法）或 executor 级不可恢复错误导致的 DEAD_LETTER——
 * generic runner 的 commit/failure 边界之外，request 仍可非 terminal，
 * 本 reconciler 保证 INV-9C03-07（Job retry/dead-letter 不会留下永久
 * IN_PROGRESS PrivacyRequest）。
 *
 * 生产 topology：async-worker 每周期与 errand deadline scheduler 同位
 * 执行（bounded batch），亦可经 ops 单独触发。
 */
export async function reconcileDataExportDeadLetters(
  options: { batchLimit?: number; now?: Date } = {},
): Promise<DataExportDeadLetterReconciliationSummary> {
  const batchLimit = options.batchLimit ?? RECONCILE_BATCH_LIMIT;

  // 定位依据 = dedupeKey（写边界 enqueueAsyncJobTx 契约强制的唯一绑定），
  // 绝不是 payload——payload 损坏正是 DEAD_LETTER 的成因之一（执行边界
  // fail closed），损坏 payload 的 job 恰恰最需要收敛，不能因解析失败被
  // 跳过、让 request 永久非终态。dedupeKey = DATA_EXPORT_GENERATE:<requestId>。
  const deadLetterJobs = await prisma.$queryRaw<Array<{ id: string; dedupeKey: string }>>`
    SELECT j.id, j."dedupeKey"
    FROM "AsyncJob" j
    JOIN "PrivacyRequest" r
      ON j."dedupeKey" = ${`${DATA_EXPORT_GENERATE_JOB_KIND}:`} || r.id
    WHERE j."kind" = ${DATA_EXPORT_GENERATE_JOB_KIND}
      AND j."status" = 'DEAD_LETTER'
      AND r."type" = 'DATA_EXPORT'
      AND r."status" IN ('REQUESTED', 'IN_PROGRESS')
    ORDER BY j."deadLetteredAt" ASC NULLS LAST, j.id ASC
    LIMIT ${batchLimit}
  `;

  const summary: DataExportDeadLetterReconciliationSummary = {
    scannedJobs: deadLetterJobs.length,
    convergedRequests: 0,
    artifactsMarkedForDeletion: 0,
  };

  for (const job of deadLetterJobs) {
    const requestId = job.dedupeKey.slice(DATA_EXPORT_GENERATE_JOB_KIND.length + 1);

    if (!requestId) {
      logger.warn("data_export_dead_letter_dedupe_key_invalid", "privacy", {
        event: "data_export_dead_letter_dedupe_key_invalid",
        jobId: job.id,
      });
      continue;
    }

    try {
      const outcome = await withTransaction(async (tx) => {
        // 锁内 fresh 复核（扫描与收敛之间的竞态防御）+ 与 erasure 同锁域
        // 线性化（artifact PENDING_DELETE 标记不与之交错）
        const request = await tx.privacyRequest.findUnique({
          where: { id: requestId },
        });

        if (!request || request.type !== "DATA_EXPORT") {
          return { converged: false as const, artifactsMarked: 0 };
        }

        if (request.status !== "REQUESTED" && request.status !== "IN_PROGRESS") {
          // 已被并发收敛/用户取消：幂等 no-op
          return { converged: false as const, artifactsMarked: 0 };
        }

        await acquireGovernanceSubjectLock(tx, "USER", request.userId);

        const artifact = await findArtifactByRequestIdTx(tx, request.id);

        let artifactsMarked = 0;

        if (artifact && (artifact.status === "WRITING" || artifact.status === "READY")) {
          await transitionDataExportArtifact(artifact.id, "PENDING_DELETE", { tx });
          artifactsMarked = 1;
        }

        let currentStatus = request.status;

        if (currentStatus === "REQUESTED") {
          await transitionPrivacyRequest(request.id, "IN_PROGRESS", undefined, tx);
          currentStatus = "IN_PROGRESS";
        }

        if (currentStatus === "IN_PROGRESS") {
          await transitionPrivacyRequest(
            request.id,
            "REJECTED",
            { reasonCode: DATA_EXPORT_REJECT_REASON.GENERATION_FAILED },
            tx,
          );
        }

        return { converged: true as const, artifactsMarked };
      });

      summary.convergedRequests += outcome.converged ? 1 : 0;
      summary.artifactsMarkedForDeletion += outcome.artifactsMarked;

      if (outcome.converged) {
        logger.warn("data_export_dead_letter_reconciled", "privacy", {
          event: "data_export_dead_letter_reconciled",
          jobId: job.id,
        });
      }
    } catch (error) {
      // 单条失败只影响自身：下个周期重新扫描（收敛幂等）
      logger.warn("data_export_dead_letter_reconcile_failed", "privacy", {
        event: "data_export_dead_letter_reconcile_failed",
        jobId: job.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (summary.scannedJobs > 0) {
    logger.info("data_export_dead_letter_reconcile_cycle", "privacy", {
      event: "data_export_dead_letter_reconcile_cycle",
      ...summary,
    });
  }

  return summary;
}

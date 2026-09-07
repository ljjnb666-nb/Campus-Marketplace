import { Prisma, type ReportStatus, type ReportTargetType } from "@prisma/client";

import { withTransaction } from "@/lib/prisma";

/**
 * Phase 6B Repair 1 Blocker D：Report ↔ RiskFlag 确定性投影 / 对账。
 *
 * canonical = Report 行；RiskFlag 是其归一化风险信号投影。
 * 所有举报相关的 flag 状态变更必须经本服务收敛——禁止 action 内手写
 * 增量 if/else（那是 RESOLVED→REJECTED 矛盾与 legacy 缺投影的根源）。
 *
 * 最终状态合同：
 *   Report OPEN / IN_REVIEW → REPORT_SUBMITTED = ACTIVE；REPORT_CONFIRMED = absent/RESOLVED
 *   Report RESOLVED          → REPORT_SUBMITTED = RESOLVED；REPORT_CONFIRMED = ACTIVE
 *   Report REJECTED          → REPORT_SUBMITTED = RESOLVED；REPORT_CONFIRMED = absent/RESOLVED
 *
 * 支持：
 * - legacy report（无任何 flag）：reconciliation 创建缺失投影
 * - 幂等：同一 canonical 状态重复对账 → 相同逻辑行，零重复
 * - reopen（Option B）：RESOLVED/REJECTED → IN_REVIEW 时重激活
 *   REPORT_SUBMITTED 并闭环 REPORT_CONFIRMED（当前后台已支持任意改状态，
 *   因此采用 Option B + 中央 transition assertion 收敛，而不是假设 terminal）
 *
 * 目标 user/campus 解析：resolveReportTargetContext 对全部 targetType 解析
 * （USER 直读；PRODUCT/ERRAND_TASK/SERVICE_LISTING/MESSAGE 经业务对象），
 * createReport / reviewReport / reconcile 三处共用本 helper。
 */

export const REPORT_STATUS_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  OPEN: ["IN_REVIEW", "RESOLVED", "REJECTED"],
  IN_REVIEW: ["RESOLVED", "REJECTED"],
  RESOLVED: ["IN_REVIEW"],
  REJECTED: ["IN_REVIEW"],
};

/** 中央 transition assertion（同状态 = 幂等合法；任意跳转拒绝）。 */
export function assertReportStatusTransition(
  from: ReportStatus,
  to: ReportStatus,
): void {
  if (from === to) {
    return; // 幂等重提交（如补充处理说明）合法
  }
  if (!REPORT_STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`REPORT_STATUS_INVALID_TRANSITION:${from}->${to}`);
  }
}

export type ReportTargetRef = {
  targetType: ReportTargetType;
  productId?: string | null;
  errandTaskId?: string | null;
  serviceListingId?: string | null;
  targetUserId?: string | null;
  messageId?: string | null;
};

export type ReportTargetContext = {
  /** 被举报方归属用户；匿名消息等无归属场景为 null */
  ownerUserId: string | null;
  /**
   * 举报的 campus provenance：PRODUCT/ERRAND_TASK/SERVICE_LISTING 按业务对象
   * 所在校区解析；USER/MESSAGE 当前 Report 无 campus 语境，如实返回 null
   * （GLOBAL/unscoped），禁止用 User.campusId 之类猜测绑定。
   */
  campusId: string | null;
  /** 目标业务对象是否存在（用于 createReport 的存在性校验） */
  targetExists: boolean;
};

/**
 * 解析举报的归属用户与 campus provenance（唯一实现）。
 * createReport / reviewReport / reconcileReportRiskProjection 共用，
 * 仓库内不得再出现重复的 target owner switch（Repair 2 Blocker E）。
 */
export async function resolveReportTargetContext(
  tx: Prisma.TransactionClient,
  ref: ReportTargetRef,
): Promise<ReportTargetContext> {
  switch (ref.targetType) {
    case "USER": {
      if (!ref.targetUserId) {
        return { ownerUserId: null, campusId: null, targetExists: false };
      }
      const row = await tx.user.findUnique({
        where: { id: ref.targetUserId },
        select: { id: true },
      });
      // USER 举报无 campus 语境（Report 无 campusId 字段，不编造）
      return {
        ownerUserId: row ? ref.targetUserId : null,
        campusId: null,
        targetExists: Boolean(row),
      };
    }
    case "PRODUCT": {
      if (!ref.productId) {
        return { ownerUserId: null, campusId: null, targetExists: false };
      }
      const row = await tx.product.findUnique({
        where: { id: ref.productId },
        select: { sellerId: true, campusId: true },
      });
      return {
        ownerUserId: row?.sellerId ?? null,
        campusId: row?.campusId ?? null,
        targetExists: Boolean(row),
      };
    }
    case "ERRAND_TASK": {
      if (!ref.errandTaskId) {
        return { ownerUserId: null, campusId: null, targetExists: false };
      }
      const row = await tx.errandTask.findUnique({
        where: { id: ref.errandTaskId },
        select: { publisherId: true, campusId: true },
      });
      return {
        ownerUserId: row?.publisherId ?? null,
        campusId: row?.campusId ?? null,
        targetExists: Boolean(row),
      };
    }
    case "SERVICE_LISTING": {
      if (!ref.serviceListingId) {
        return { ownerUserId: null, campusId: null, targetExists: false };
      }
      const row = await tx.serviceListing.findUnique({
        where: { id: ref.serviceListingId },
        select: { providerId: true, campusId: true },
      });
      return {
        ownerUserId: row?.providerId ?? null,
        campusId: row?.campusId ?? null,
        targetExists: Boolean(row),
      };
    }
    case "MESSAGE": {
      if (!ref.messageId) {
        return { ownerUserId: null, campusId: null, targetExists: false };
      }
      const row = await tx.message.findUnique({
        where: { id: ref.messageId },
        select: { senderId: true },
      });
      // MESSAGE 无法可靠推导 campus（conversation 语境不绑定单校区）：
      // 如实返回 null，禁止用 sender 的 User.campusId 猜测绑定
      return {
        ownerUserId: row?.senderId ?? null,
        campusId: null,
        targetExists: Boolean(row),
      };
    }
    default:
      return { ownerUserId: null, campusId: null, targetExists: false };
  }
}

const REPORT_FLAG_SOURCE_TYPE = "REPORT";

async function upsertReportFlag(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    campusId: string | null;
    kind: "REPORT_SUBMITTED" | "REPORT_CONFIRMED";
    reportId: string;
    active: boolean;
    severity?: "INFO" | "LOW" | "MEDIUM" | "HIGH";
    actorId?: string;
  },
): Promise<void> {
  const existing = await tx.riskFlag.findUnique({
    where: {
      kind_sourceType_sourceId: {
        kind: input.kind,
        sourceType: REPORT_FLAG_SOURCE_TYPE,
        sourceId: input.reportId,
      },
    },
    select: { id: true, status: true, userId: true, campusId: true },
  });

  // Repair 2 Blocker B：projection 必须与 canonical target context 收敛——
  // 既有行的 userId/campusId 与解析结果不一致时同步修正（ownership 可变）。
  const needsContextSync =
    existing && (existing.userId !== input.userId || existing.campusId !== input.campusId);

  if (input.active) {
    if (existing) {
      if (needsContextSync || existing.status !== "ACTIVE") {
        await tx.riskFlag.update({
          where: { id: existing.id },
          data: {
            status: "ACTIVE",
            userId: input.userId,
            campusId: input.campusId,
            resolvedById: null,
            resolvedAt: null,
          },
        });
      }
      return;
    }
    // legacy 缺投影：创建
    try {
      await tx.riskFlag.create({
        data: {
          userId: input.userId,
          campusId: input.campusId,
          kind: input.kind,
          severity: input.severity ?? "INFO",
          sourceType: REPORT_FLAG_SOURCE_TYPE,
          sourceId: input.reportId,
          createdById: input.actorId ?? null,
        },
      });
    } catch (error) {
      // 并发对账：唯一约束兜底幂等
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return;
      }
      throw error;
    }
    return;
  }

  // 期望非 ACTIVE：absent 或 RESOLVED 皆满足；ACTIVE 才需要闭环。
  // legacy 缺投影（RESOLVED/REJECTED 报告从未有过 SUBMITTED flag）时
  // 直接以 RESOLVED 状态补建——保证投影总是完整存在。
  if (existing) {
    if (needsContextSync || existing.status === "ACTIVE") {
      await tx.riskFlag.update({
        where: { id: existing.id },
        data: {
          status: "RESOLVED",
          userId: input.userId,
          campusId: input.campusId,
          resolvedById: input.actorId ?? null,
          resolvedAt: new Date(),
        },
      });
    }
    return;
  }

  try {
    await tx.riskFlag.create({
      data: {
        userId: input.userId,
        campusId: input.campusId,
        kind: input.kind,
        severity: input.severity ?? "INFO",
        sourceType: REPORT_FLAG_SOURCE_TYPE,
        sourceId: input.reportId,
        status: "RESOLVED",
        createdById: input.actorId ?? null,
        resolvedById: input.actorId ?? null,
        resolvedAt: new Date(),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return;
    }
    throw error;
  }
}

export type ReconcileReportProjectionInput = {
  reportId: string;
  /** 审计归属（管理员触发的对账；系统重放可缺省） */
  actorId?: string;
};

export type ReconcileReportProjectionResult = {
  ownerUserId: string | null;
  reportStatus: ReportStatus;
  submittedFlagStatus: "ACTIVE" | "RESOLVED" | "ABSENT";
  confirmedFlagStatus: "ACTIVE" | "RESOLVED" | "ABSENT";
};

/**
 * 读取 canonical Report 并把 RiskFlag 投影确定性收敛到合同状态。
 * 幂等：重复对账同一状态产生相同逻辑行，零重复。
 * 无归属用户（如匿名消息举报）时为 no-op（返回 ownerUserId=null）。
 */
export async function reconcileReportRiskProjection(
  input: ReconcileReportProjectionInput,
  tx?: Prisma.TransactionClient,
): Promise<ReconcileReportProjectionResult | null> {
  const run = async (client: Prisma.TransactionClient): Promise<ReconcileReportProjectionResult | null> => {
    const report = await client.report.findUnique({
      where: { id: input.reportId },
      select: {
        id: true,
        status: true,
        targetType: true,
        productId: true,
        errandTaskId: true,
        serviceListingId: true,
        targetUserId: true,
        messageId: true,
      },
    });

    if (!report) {
      return null;
    }

    const targetContext = await resolveReportTargetContext(client, report);
    if (!targetContext.ownerUserId) {
      return {
        ownerUserId: null,
        reportStatus: report.status,
        submittedFlagStatus: "ABSENT",
        confirmedFlagStatus: "ABSENT",
      };
    }

    const reportActive = report.status === "OPEN" || report.status === "IN_REVIEW";
    const confirmedActive = report.status === "RESOLVED";

    await upsertReportFlag(client, {
      userId: targetContext.ownerUserId,
      campusId: targetContext.campusId,
      kind: "REPORT_SUBMITTED",
      reportId: report.id,
      active: reportActive,
      actorId: input.actorId,
    });

    await upsertReportFlag(client, {
      userId: targetContext.ownerUserId,
      campusId: targetContext.campusId,
      kind: "REPORT_CONFIRMED",
      reportId: report.id,
      active: confirmedActive,
      severity: "MEDIUM",
      actorId: input.actorId,
    });

    const [submitted, confirmed] = await Promise.all([
      client.riskFlag.findUnique({
        where: {
          kind_sourceType_sourceId: {
            kind: "REPORT_SUBMITTED",
            sourceType: REPORT_FLAG_SOURCE_TYPE,
            sourceId: report.id,
          },
        },
        select: { status: true },
      }),
      client.riskFlag.findUnique({
        where: {
          kind_sourceType_sourceId: {
            kind: "REPORT_CONFIRMED",
            sourceType: REPORT_FLAG_SOURCE_TYPE,
            sourceId: report.id,
          },
        },
        select: { status: true },
      }),
    ]);

    return {
      ownerUserId: targetContext.ownerUserId,
      reportStatus: report.status,
      submittedFlagStatus: (submitted?.status ?? "ABSENT") as "ACTIVE" | "RESOLVED" | "ABSENT",
      confirmedFlagStatus: (confirmed?.status ?? "ABSENT") as "ACTIVE" | "RESOLVED" | "ABSENT",
    };
  };

  if (tx) {
    return run(tx);
  }
  return withTransaction(run);
}

/**
 * Repair 2 Blocker D：举报审核的事务级入口（serialization boundary）。
 *
 * 顺序（Report row 是 domain lock；本路径不引入 USER subject locks，
 * 因此不存在 "row lock → USER advisory" 反序）：
 *   SELECT ... FOR UPDATE（锁定同一 Report 行）
 *   → locked status 读取（不信任 pre-lock 读数）
 *   → assertReportStatusTransition
 *   → canonical Report update（status/handledBy/handledNote/handledAt）
 *   → reconcileReportRiskProjection（同一 locked transaction）
 *   → AdminLog + reporter notification（举报提交/处理确认属既有事务性合同，
 *     见 §35/§36——不与 enforcement notification 的 post-commit 规则混淆）
 *
 * racePoint 为测试 seam（行锁取得之后、transition 断言之前），生产路径不传。
 */
export type ApplyReportReviewInput = {
  reportId: string;
  actorId: string;
  status: ReportStatus;
  handledNote?: string | null;
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export async function applyReportReviewTx(
  tx: Prisma.TransactionClient,
  input: ApplyReportReviewInput,
): Promise<{ reportId: string; status: ReportStatus; reporterId: string }> {
  // ---- 步骤 1：行锁下读取 canonical status（TOCTOU 关闭点） ----
  const locked = await tx.$queryRaw<{ id: string; status: ReportStatus; reporterId: string }[]>`
    SELECT id, status, "reporterId"
    FROM "Report"
    WHERE id = ${input.reportId}
    FOR UPDATE`;

  const report = locked[0];
  if (!report) {
    throw new Error(`REPORT_NOT_FOUND:${input.reportId}`);
  }

  // ---- 步骤 2：测试 seam（winner 已持行锁） ----
  if (input.racePoint) {
    await input.racePoint(tx);
  }

  // ---- 步骤 3：锁定状态上的 transition 断言 ----
  assertReportStatusTransition(report.status, input.status);

  const handled = input.status === "RESOLVED" || input.status === "REJECTED";

  // ---- 步骤 4：canonical update + projection + AdminLog + notification ----
  const updated = await tx.report.update({
    where: { id: report.id },
    data: {
      status: input.status,
      handledById: input.actorId,
      handledNote: input.handledNote || null,
      handledAt: handled ? new Date() : null,
    },
    select: { reporterId: true },
  });

  await reconcileReportRiskProjection(
    { reportId: report.id, actorId: input.actorId },
    tx,
  );

  await tx.adminLog.create({
    data: {
      adminId: input.actorId,
      action: `REPORT_${input.status}`,
      targetType: "REPORT",
      targetId: report.id,
      detail: input.handledNote || null,
    },
  });

  return { reportId: report.id, status: input.status, reporterId: updated.reporterId };
}

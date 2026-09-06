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
 * 目标 user 解析：resolveReportTargetOwner 对全部 targetType 解析归属
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

export type ReportOwnerRef = {
  reportId?: string;
  targetType: ReportTargetType;
  productId?: string | null;
  errandTaskId?: string | null;
  serviceListingId?: string | null;
  targetUserId?: string | null;
  messageId?: string | null;
};

/**
 * 解析举报的归属用户（被举报方）。
 * createReport / reviewReport / reconcileReportRiskProjection 共用，
 * 避免三处各写一套 ownership 逻辑。解析不到（如匿名消息）返回 null。
 */
export async function resolveReportTargetOwner(
  tx: Prisma.TransactionClient,
  ref: ReportOwnerRef,
): Promise<string | null> {
  switch (ref.targetType) {
    case "USER":
      return ref.targetUserId ?? null;
    case "PRODUCT": {
      if (!ref.productId) return null;
      const row = await tx.product.findUnique({
        where: { id: ref.productId },
        select: { sellerId: true },
      });
      return row?.sellerId ?? null;
    }
    case "ERRAND_TASK": {
      if (!ref.errandTaskId) return null;
      const row = await tx.errandTask.findUnique({
        where: { id: ref.errandTaskId },
        select: { publisherId: true },
      });
      return row?.publisherId ?? null;
    }
    case "SERVICE_LISTING": {
      if (!ref.serviceListingId) return null;
      const row = await tx.serviceListing.findUnique({
        where: { id: ref.serviceListingId },
        select: { providerId: true },
      });
      return row?.providerId ?? null;
    }
    case "MESSAGE": {
      if (!ref.messageId) return null;
      const row = await tx.message.findUnique({
        where: { id: ref.messageId },
        select: { senderId: true },
      });
      return row?.senderId ?? null;
    }
    default:
      return null;
  }
}

const REPORT_FLAG_SOURCE_TYPE = "REPORT";

async function upsertReportFlag(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
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
    select: { id: true, status: true },
  });

  if (input.active) {
    if (existing) {
      if (existing.status !== "ACTIVE") {
        await tx.riskFlag.update({
          where: { id: existing.id },
          data: { status: "ACTIVE", resolvedById: null, resolvedAt: null },
        });
      }
      return;
    }
    // legacy 缺投影：创建
    try {
      await tx.riskFlag.create({
        data: {
          userId: input.userId,
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

  // 期望非 ACTIVE：absent 或 RESOLVED 皆满足；ACTIVE 才需要闭环
  if (existing && existing.status === "ACTIVE") {
    await tx.riskFlag.update({
      where: { id: existing.id },
      data: { status: "RESOLVED", resolvedById: input.actorId ?? null, resolvedAt: new Date() },
    });
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

    const ownerUserId = await resolveReportTargetOwner(client, report);
    if (!ownerUserId) {
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
      userId: ownerUserId,
      kind: "REPORT_SUBMITTED",
      reportId: report.id,
      active: reportActive,
      actorId: input.actorId,
    });

    await upsertReportFlag(client, {
      userId: ownerUserId,
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
      ownerUserId,
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

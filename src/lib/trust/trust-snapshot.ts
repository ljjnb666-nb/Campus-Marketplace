import type { CampusMembershipStatus, Prisma, VerificationStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { rbacError } from "@/lib/rbac/errors";
import { hasPermission, loadAuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 6B：中央 trust snapshot（只读汇聚既有事实，不发明新评分）。
 *
 * TRUST SIGNAL != RISK STATE != ENFORCEMENT：
 * - 本快照只读取已存在的事实信号（认证/成员/交易/评价/租赁统计）
 * - creditScore 仅作 legacy display signal 透出（CREDIT_SCORE =
 *   LEGACY_DISPLAY_SIGNAL：在其拥有 policy/version/provenance/appeal
 *   语义之前，绝不作为 enforcement source）
 * - NO_OPAQUE_SCORING：结构不含任何综合分数或自动判定结论
 *
 * Repair 1 Blocker B：public / internal 两个 API 严格分离——
 * - getPublicTrustSnapshot：可公开的安全信号（与今日公开 profile 一致）；
 *   绝不包含 RiskState/RiskFlag/举报计数/reasonCode/enforcement 数据
 * - getInternalTrustSnapshot：server-side authorization（actorId +
 *   loadAuthorizationContext + audit.read permission 判定；GLOBAL 快照
 *   要求 GLOBAL audit.read，campus 快照要求该校区 audit.read）；
 *   举报相关数据以 RiskFlag 归一化信号为准（覆盖全部 targetType，
 *   不依赖 Report.targetUserId 猜测归属），并区分 submitted
 *   （SIGNAL_NOT_ADIJUDICATED_FACT）与 confirmed（CONFIRMED_AFTER_REVIEW）
 */

export type PublicTrustSnapshot = {
  userId: string;
  identity: { userId: string };
  membership: { activeCampusCount: number };
  verification: { status: VerificationStatus };
  transactionHistory: { completedOrdersCount: number };
  reviewSignals: { positiveReviewRate: number; receivedReviewsCount: number };
  rentalSignals: {
    rentalOwnerCount: number;
    rentalRenterCount: number;
    onTimeReturnRate: number;
    rentalPositiveRate: number;
    rentalDisputeCount: number;
  };
  legacyCreditScore: { value: number; policy: "LEGACY_DISPLAY_SIGNAL" };
};

export type InternalTrustSnapshot = PublicTrustSnapshot & {
  membership: { activeCampusCount: number; activeCampusIds: string[]; statuses: CampusMembershipStatus[] };
  /** 信号，非裁决事实（来自 RiskFlag 归一化投影，覆盖全部举报 targetType） */
  reportSignals: {
    /** 未裁决举报信号（ACTIVE REPORT_SUBMITTED） */
    submittedReportSignals: number;
    /** 经人工核查成立的举报信号（ACTIVE REPORT_CONFIRMED） */
    confirmedReportSignals: number;
    submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT";
    confirmedSignalNote: "CONFIRMED_AFTER_REVIEW";
  };
  risk: {
    states: Array<{ scopeKey: string; campusId: string | null; state: string; reasonCode: string | null }>;
    activeRestrictions: string[];
  };
};

const trustUserSelect = {
  id: true,
  verificationStatus: true,
  creditScore: true,
  completedOrdersCount: true,
  positiveReviewRate: true,
  rentalOwnerCount: true,
  rentalRenterCount: true,
  onTimeReturnRate: true,
  rentalPositiveRate: true,
  rentalDisputeCount: true,
  memberships: {
    select: { campusId: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }] as const,
  },
  _count: { select: { receivedReviews: true } },
} satisfies Prisma.UserSelect;

async function loadUserSnapshot(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<Omit<InternalTrustSnapshot, "reportSignals" | "risk"> | null> {
  const user = tx
    ? await tx.user.findUnique({ where: { id: userId }, select: trustUserSelect })
    : await prisma.user.findUnique({ where: { id: userId }, select: trustUserSelect });

  if (!user) {
    return null;
  }

  const activeMemberships = user.memberships.filter((m) => m.status === "ACTIVE");

  return {
    userId: user.id,
    identity: { userId: user.id },
    membership: {
      activeCampusCount: activeMemberships.length,
      activeCampusIds: activeMemberships.map((m) => m.campusId),
      statuses: user.memberships.map((m) => m.status),
    },
    verification: { status: user.verificationStatus },
    transactionHistory: { completedOrdersCount: user.completedOrdersCount },
    reviewSignals: {
      positiveReviewRate: user.positiveReviewRate,
      receivedReviewsCount: user._count.receivedReviews,
    },
    rentalSignals: {
      rentalOwnerCount: user.rentalOwnerCount,
      rentalRenterCount: user.rentalRenterCount,
      onTimeReturnRate: user.onTimeReturnRate,
      rentalPositiveRate: user.rentalPositiveRate,
      rentalDisputeCount: user.rentalDisputeCount,
    },
    legacyCreditScore: { value: user.creditScore, policy: "LEGACY_DISPLAY_SIGNAL" },
  };
}

/**
 * 公开 trust 快照：仅含今日公开 profile 已展示的安全信号。
 * 绝不返回 RiskState / activeRestrictions / RiskFlag 计数 / 举报计数 /
 * enforcement reasons / notes / internal reasonCode / risk scope（Repair 1 #39/#40）。
 */
export async function getPublicTrustSnapshot(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<PublicTrustSnapshot | null> {
  const base = await loadUserSnapshot(userId, tx);
  if (!base) {
    return null;
  }

  const { membership, ...rest } = base;
  return {
    ...rest,
    membership: { activeCampusCount: membership.activeCampusCount },
  };
}

/**
 * 内部 trust 快照（admin 风控视图）：server-side authorization。
 * GLOBAL 快照要求 GLOBAL audit.read；campus 快照要求该校区 audit.read
 * （campus-scoped actor 自动要求其 ACTIVE membership 命中——6A 语义）。
 * 绝不依赖调用方自报的 includeRisk 布尔。
 */
export async function getInternalTrustSnapshot(input: {
  actorId: string;
  targetUserId: string;
  /** 提供时限定 campus 视角（campus-scoped 授权路径） */
  campusId?: string | null;
  tx?: Prisma.TransactionClient;
}): Promise<InternalTrustSnapshot | null> {
  return withInternalAuthorization(input, async (tx) => {
    const client = (tx ?? prisma) as Prisma.TransactionClient;
    const base = await loadUserSnapshot(input.targetUserId, client);
    if (!base) {
      return null;
    }

    const riskWhere = {
      userId: input.targetUserId,
      ...(input.campusId != null ? { scopeKey: { in: ["GLOBAL", `CAMPUS:${input.campusId}`] } } : {}),
    };

    const [riskRows, submittedFlags, confirmedFlags] = await Promise.all([
      client.riskState.findMany({
        where: riskWhere,
        select: { scopeKey: true, campusId: true, state: true, reasonCode: true },
        orderBy: [{ scopeKey: "asc" }],
      }),
      client.riskFlag.count({
        where: { userId: input.targetUserId, kind: "REPORT_SUBMITTED", status: "ACTIVE" },
      }),
      client.riskFlag.count({
        where: { userId: input.targetUserId, kind: "REPORT_CONFIRMED", status: "ACTIVE" },
      }),
    ]);

    return {
      ...base,
      reportSignals: {
        submittedReportSignals: submittedFlags,
        confirmedReportSignals: confirmedFlags,
        submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT",
        confirmedSignalNote: "CONFIRMED_AFTER_REVIEW",
      },
      risk: {
        states: riskRows.map((row) => ({
          scopeKey: row.scopeKey,
          campusId: row.campusId,
          state: row.state,
          reasonCode: row.reasonCode,
        })),
        activeRestrictions: riskRows
          .filter((row) => row.state === "RESTRICTED")
          .map((row) => row.scopeKey),
      },
    };
  });
}

async function withInternalAuthorization<T>(
  input: { actorId: string; campusId?: string | null },
  run: (tx?: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const actorContext = await loadAuthorizationContext(input.actorId);
  if (!actorContext || !actorContext.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (!hasPermission(actorContext, "audit.read", input.campusId ?? null)) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  return run();
}

import type { CampusMembershipStatus, Prisma, VerificationStatus } from "@prisma/client";

import { getRiskStateRows } from "@/lib/enforcement/risk-service";
import { prisma } from "@/lib/prisma";

/**
 * Phase 6B：中央 trust snapshot（只读汇聚既有事实，不发明新评分）。
 *
 * TRUST SIGNAL != RISK STATE != ENFORCEMENT：
 * - 本快照只读取已存在的事实信号（认证/成员/交易/评价/租赁统计）
 * - report 汇总显式标注为"signal, not adjudicated fact"
 * - creditScore 仅作 legacy display signal 透出（CREDIT_SCORE =
 *   LEGACY_DISPLAY_SIGNAL：在其拥有 policy/version/provenance/appeal
 *   语义之前，绝不作为 enforcement source）
 * - riskState / activeRestrictions 属 admin-only 数据：仅 includeRisk=true
 *   时返回；公开 profile 不得透出（#39/#40：无"社交信用"式公开标签）
 *
 * NO_OPAQUE_SCORING：本结构不含任何综合分数或自动判定结论。
 */

export type TrustSnapshot = {
  userId: string;
  identity: { userId: string };
  membership: {
    activeCampusIds: string[];
    statuses: CampusMembershipStatus[];
  };
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
  /** 信号，非裁决事实（signal, not adjudicated fact） */
  reportSignals: {
    openReportCount: number;
    resolvedReportCount: number;
    signalNote: "SIGNAL_NOT_ADIJUDICATED_FACT";
  };
  legacyCreditScore: { value: number; policy: "LEGACY_DISPLAY_SIGNAL" };
  /** 仅 includeRisk 时返回（admin-only） */
  risk?: {
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

export async function getTrustSnapshot(
  userId: string,
  options: { includeRisk?: boolean; tx?: Prisma.TransactionClient } = {},
): Promise<TrustSnapshot | null> {
  // 扩展客户端与事务客户端的联合类型会触发 Prisma excessive stack depth
  // （见 legal-document-service.ts 同注），prisma / tx 两条路径显式分开。
  const user = options.tx
    ? await options.tx.user.findUnique({ where: { id: userId }, select: trustUserSelect })
    : await prisma.user.findUnique({ where: { id: userId }, select: trustUserSelect });

  if (!user) {
    return null;
  }

  // 举报信号聚合（对目标人的举报；OPEN/IN_REVIEW = 未裁决，RESOLVED = 已处理）
  const openReportCount = await prisma.report.count({
    where: { targetUserId: userId, status: { in: ["OPEN", "IN_REVIEW"] } },
  });
  const resolvedReportCount = await prisma.report.count({
    where: { targetUserId: userId, status: { in: ["RESOLVED", "REJECTED"] } },
  });

  const snapshot: TrustSnapshot = {
    userId: user.id,
    identity: { userId: user.id },
    membership: {
      activeCampusIds: user.memberships.filter((m) => m.status === "ACTIVE").map((m) => m.campusId),
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
    reportSignals: {
      openReportCount,
      resolvedReportCount,
      signalNote: "SIGNAL_NOT_ADIJUDICATED_FACT",
    },
    legacyCreditScore: { value: user.creditScore, policy: "LEGACY_DISPLAY_SIGNAL" },
  };

  if (options.includeRisk) {
    const states = await getRiskStateRows(userId, options.tx);
    snapshot.risk = {
      states: states.map((row) => ({
        scopeKey: row.scopeKey,
        campusId: row.campusId,
        state: row.state,
        reasonCode: row.reasonCode,
      })),
      activeRestrictions: states
        .filter((row) => row.state === "RESTRICTED")
        .map((row) => row.scopeKey),
    };
  }

  return snapshot;
}

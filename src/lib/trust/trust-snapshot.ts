import type {
  CampusMembershipStatus,
  Prisma,
  RiskStateLevel,
  VerificationStatus,
} from "@prisma/client";

import { enforcementError } from "@/lib/enforcement/errors";
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
 * Repair 1 Blocker B：public / internal 严格分离——
 * - getPublicTrustSnapshot：可公开的安全信号（与今日公开 profile 一致）；
 *   绝不包含 RiskState/RiskFlag/举报计数/reasonCode/enforcement 数据
 *
 * Repair 2 Blocker A：internal 视图按 campus 真正隔离（discriminated union）：
 * - GLOBAL 视图（campusId=null，要求 GLOBAL audit.read）：全部 membership、
 *   全部 risk states、全平台 RiskFlag 举报信号
 * - CAMPUS 视图（campusId=A，要求 audit.read@A 且 target 与 A 有合法领域
 *   关联：membership 存在且 ∈ {ACTIVE, SUSPENDED}）：仅 Campus A membership
 *   status、Campus A 风险态、Campus A 本地举报信号；绝不返回其他 campus /
 *   GLOBAL / 全平台聚合数据。GLOBAL admin 请求 campusId=A 同样受 target
 *   relationship 约束。
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

export type GlobalInternalTrustSnapshot = {
  view: "GLOBAL";
  userId: string;
  identity: { userId: string };
  membership: { activeCampusIds: string[]; statuses: CampusMembershipStatus[] };
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
  /** 信号，非裁决事实（来自 RiskFlag 归一化投影，全平台） */
  reportSignals: {
    submittedReportSignals: number;
    confirmedReportSignals: number;
    submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT";
    confirmedSignalNote: "CONFIRMED_AFTER_REVIEW";
  };
  risk: {
    states: Array<{ scopeKey: string; campusId: string | null; state: string; reasonCode: string | null }>;
    activeRestrictions: string[];
  };
};

export type CampusInternalTrustSnapshot = {
  view: "CAMPUS";
  campusId: string;
  userId: string;
  identity: { userId: string };
  /** 目标在本校区的 membership status（本视图唯一可见的成员信息） */
  membership: { status: CampusMembershipStatus };
  verification: { status: VerificationStatus };
  /** 仅本校区的举报信号（RiskFlag.campusId = campusId） */
  reportSignals: {
    submittedReportSignals: number;
    confirmedReportSignals: number;
    submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT";
    confirmedSignalNote: "CONFIRMED_AFTER_REVIEW";
  };
  /** 仅本校区（CAMPUS:<id>）的风险态；GLOBAL 行不属于 campus 视图 */
  risk: {
    state: RiskStateLevel;
    reasonCode: string | null;
  };
};

export type InternalTrustSnapshot =
  | GlobalInternalTrustSnapshot
  | CampusInternalTrustSnapshot;

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

type UserTrustBase = {
  userId: string;
  verificationStatus: VerificationStatus;
  creditScore: number;
  completedOrdersCount: number;
  positiveReviewRate: number;
  rentalOwnerCount: number;
  rentalRenterCount: number;
  onTimeReturnRate: number;
  rentalPositiveRate: number;
  rentalDisputeCount: number;
  memberships: Array<{ campusId: string; status: CampusMembershipStatus }>;
  receivedReviewsCount: number;
};

async function loadUserTrustBase(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<UserTrustBase | null> {
  const user = tx
    ? await tx.user.findUnique({ where: { id: userId }, select: trustUserSelect })
    : await prisma.user.findUnique({ where: { id: userId }, select: trustUserSelect });

  if (!user) {
    return null;
  }

  return {
    userId: user.id,
    verificationStatus: user.verificationStatus,
    creditScore: user.creditScore,
    completedOrdersCount: user.completedOrdersCount,
    positiveReviewRate: user.positiveReviewRate,
    rentalOwnerCount: user.rentalOwnerCount,
    rentalRenterCount: user.rentalRenterCount,
    onTimeReturnRate: user.onTimeReturnRate,
    rentalPositiveRate: user.rentalPositiveRate,
    rentalDisputeCount: user.rentalDisputeCount,
    memberships: user.memberships,
    receivedReviewsCount: user._count.receivedReviews,
  };
}

function toPublicTrustSignals(base: UserTrustBase) {
  return {
    transactionHistory: { completedOrdersCount: base.completedOrdersCount },
    reviewSignals: {
      positiveReviewRate: base.positiveReviewRate,
      receivedReviewsCount: base.receivedReviewsCount,
    },
    rentalSignals: {
      rentalOwnerCount: base.rentalOwnerCount,
      rentalRenterCount: base.rentalRenterCount,
      onTimeReturnRate: base.onTimeReturnRate,
      rentalPositiveRate: base.rentalPositiveRate,
      rentalDisputeCount: base.rentalDisputeCount,
    },
    legacyCreditScore: { value: base.creditScore, policy: "LEGACY_DISPLAY_SIGNAL" as const },
  };
}

/**
 * 公开 trust 快照：仅含今日公开 profile 已展示的安全信号。
 * 绝不返回 RiskState / activeRestrictions / RiskFlag 计数 / 举报计数 /
 * enforcement reasons / notes / internal reasonCode / risk scope（#39/#40）。
 */
export async function getPublicTrustSnapshot(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<PublicTrustSnapshot | null> {
  const base = await loadUserTrustBase(userId, tx);
  if (!base) {
    return null;
  }

  return {
    userId: base.userId,
    identity: { userId: base.userId },
    membership: {
      activeCampusCount: base.memberships.filter((m) => m.status === "ACTIVE").length,
    },
    verification: { status: base.verificationStatus },
    ...toPublicTrustSignals(base),
  };
}

/**
 * 内部 trust 快照（admin 风控视图）：server-side authorization + campus 隔离。
 *
 * - GLOBAL 视图（campusId 缺省）：要求 GLOBAL audit.read；返回全部
 *   membership / 全部 risk states / 全平台 RiskFlag 举报信号
 * - CAMPUS 视图（campusId=A）：要求 audit.read@A 且 target 与 A 有合法
 *   领域关联（membership 存在且 ∈ {ACTIVE, SUSPENDED}，与 setRiskState
 *   同一规则）；只返回 Campus A membership status / A 风险态 / A 本地
 *   举报信号（RiskFlag.campusId = A，不含 null 与其他 campus）
 */
export async function getInternalTrustSnapshot(input: {
  actorId: string;
  targetUserId: string;
  campusId?: string | null;
  tx?: Prisma.TransactionClient;
}): Promise<InternalTrustSnapshot | null> {
  const actorContext = await loadAuthorizationContext(input.actorId);
  if (!actorContext || !actorContext.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (!hasPermission(actorContext, "audit.read", input.campusId ?? null)) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }

  if (input.campusId != null) {
    return getCampusInternalTrustSnapshot(input.actorId, input.targetUserId, input.campusId, input.tx);
  }
  return getGlobalInternalTrustSnapshot(input.targetUserId, input.tx);
}

async function getGlobalInternalTrustSnapshot(
  targetUserId: string,
  tx?: Prisma.TransactionClient,
): Promise<GlobalInternalTrustSnapshot | null> {
  const client = (tx ?? prisma) as Prisma.TransactionClient;
  const base = await loadUserTrustBase(targetUserId, client);
  if (!base) {
    return null;
  }

  const [riskRows, submittedFlags, confirmedFlags] = await Promise.all([
    client.riskState.findMany({
      where: { userId: targetUserId },
      select: { scopeKey: true, campusId: true, state: true, reasonCode: true },
      orderBy: [{ scopeKey: "asc" }],
    }),
    client.riskFlag.count({
      where: { userId: targetUserId, kind: "REPORT_SUBMITTED", status: "ACTIVE" },
    }),
    client.riskFlag.count({
      where: { userId: targetUserId, kind: "REPORT_CONFIRMED", status: "ACTIVE" },
    }),
  ]);

  return {
    view: "GLOBAL",
    userId: base.userId,
    identity: { userId: base.userId },
    membership: {
      activeCampusIds: base.memberships.filter((m) => m.status === "ACTIVE").map((m) => m.campusId),
      statuses: base.memberships.map((m) => m.status),
    },
    verification: { status: base.verificationStatus },
    ...toPublicTrustSignals(base),
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
}

async function getCampusInternalTrustSnapshot(
  actorId: string,
  targetUserId: string,
  campusId: string,
  tx?: Prisma.TransactionClient,
): Promise<CampusInternalTrustSnapshot | null> {
  const client = (tx ?? prisma) as Prisma.TransactionClient;

  // Repair 2 Blocker A：target-campus relationship（与 setRiskState 同一规则，
  // GLOBAL admin 请求 campus 视图同样受约束）
  const targetMembership = await client.campusMembership.findUnique({
    where: { userId_campusId: { userId: targetUserId, campusId } },
    select: { status: true },
  });

  if (
    !targetMembership ||
    (targetMembership.status !== "ACTIVE" && targetMembership.status !== "SUSPENDED")
  ) {
    throw enforcementError("ENFORCEMENT_TARGET_SCOPE_MISMATCH");
  }

  const base = await loadUserTrustBase(targetUserId, client);
  if (!base) {
    return null;
  }

  // Repair 2 Blocker B/§8：campus 视图只看本校区本地信号
  //（campusId=null 与其他 campus 的信号不在本视图）
  const [riskRows, submittedFlags, confirmedFlags] = await Promise.all([
    client.riskState.findMany({
      where: { userId: targetUserId, scopeKey: `CAMPUS:${campusId}` },
      select: { state: true, reasonCode: true },
      orderBy: [{ scopeKey: "asc" }],
    }),
    client.riskFlag.count({
      where: { userId: targetUserId, campusId, kind: "REPORT_SUBMITTED", status: "ACTIVE" },
    }),
    client.riskFlag.count({
      where: { userId: targetUserId, campusId, kind: "REPORT_CONFIRMED", status: "ACTIVE" },
    }),
  ]);

  const campusRisk = riskRows[0];

  return {
    view: "CAMPUS",
    campusId,
    userId: base.userId,
    identity: { userId: base.userId },
    membership: { status: targetMembership.status },
    verification: { status: base.verificationStatus },
    reportSignals: {
      submittedReportSignals: submittedFlags,
      confirmedReportSignals: confirmedFlags,
      submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT",
      confirmedSignalNote: "CONFIRMED_AFTER_REVIEW",
    },
    risk: {
      state: (campusRisk?.state ?? "NORMAL") as RiskStateLevel,
      reasonCode: campusRisk?.reasonCode ?? null,
    },
  };
}

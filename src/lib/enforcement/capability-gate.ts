import type { Prisma } from "@prisma/client";

import { enforcementError } from "@/lib/enforcement/errors";
import {
  GLOBAL_SCOPE_KEY,
  riskScopeKey,
} from "@/lib/enforcement/risk-scope";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { incrementCounter } from "@/lib/metrics";
import { rbacError } from "@/lib/rbac/errors";

/**
 * Phase 6B/6C-3：marketplace 能力门（中央 capability gate）。
 *
 * 能力（Phase 6C-3 冻结 taxonomy，每个值都有真实调用方）：
 * - START_NEW_MARKETPLACE_ACTIVITY：开始新的交易/发布活动——4 类 listing
 *   创建、商品/服务订单、接跑腿、租赁下单、listing 型会话新建、以及
 *   "重新上架"类状态转换（product→ACTIVE / service→ACTIVE /
 *   rental→AVAILABLE / errand→OPEN）。
 * - MODIFY_PUBLIC_LISTING_CONTENT：编辑自己已发布 listing 的公开内容
 *   （product/errand/service/rental 四类编辑 action）。
 *
 * 判定（全部 fail closed，在调用方已持 subject 锁的事务内执行）：
 *   account ACTIVE（status/deletedAt/erasedAt）
 *   AND applicable campus membership ACTIVE
 *   AND risk state != RESTRICTED（GLOBAL 或该校区任一 RESTRICTED 即拒绝）
 *
 * 语义边界：
 * - 仅约束"新的活动/暴露"；既有订单/义务/消息/隐私操作不在本门范围内
 *   （既有义务必须能在软限制下继续履行）
 * - 绝不接入 requireUser()/getVerifiedSession()（软限制不得把用户踢出系统）
 * - WATCH 不阻断任何能力（观察态）
 * - #44（Phase 6B DEFER_TO_6C）已由 Phase 6C-3 关闭：新义务的**任一经济
 *   参与方** effective RESTRICTED 即不得创建——见
 *   requireParticipantsMarketplaceEligible / marketplaceObligationValidator。
 *   对外统一呈现 MARKETPLACE_COUNTERPARTY_UNAVAILABLE，不区分哪一方/哪一维。
 * - 受限用户的既有 listing 保持公开可读；lifecycle/visibility 策略留待
 *   后续阶段，本门不做 bulk unpublish。
 */

export type MarketplaceCapability =
  | "START_NEW_MARKETPLACE_ACTIVITY"
  | "MODIFY_PUBLIC_LISTING_CONTENT";

/** capability 默认值（当前全部接线点均为"新活动"能力）。 */
const DEFAULT_CAPABILITY: MarketplaceCapability = "START_NEW_MARKETPLACE_ACTIVITY";

export type MarketplaceCapabilityResult = {
  allowed: boolean;
  /** 拒绝时的机器可读原因（不直接暴露给客户端） */
  denialReason?:
    | "ACCOUNT_INACTIVE"
    | "MEMBERSHIP_NOT_ACTIVE"
    | "RISK_RESTRICTED";
  /** RISK_RESTRICTED 拒绝时命中的限制 scope（仅用于低基数 metrics） */
  matchedScopeKind?: "GLOBAL" | "CAMPUS";
};

/** 拒绝指标：labels 仅允许低基数 machine values（capability / scope_kind）。 */
const CAPABILITY_DENIED_METRIC = "marketplace_capability_denied_total";

function incrementCapabilityDenied(
  capability: MarketplaceCapability,
  scopeKind: "GLOBAL" | "CAMPUS" | "NONE",
): void {
  incrementCounter(CAPABILITY_DENIED_METRIC, { capability, scope_kind: scopeKind });
}

/**
 * 事务内读取 effective 限制（GLOBAL 行优先于 CAMPUS 行仅影响指标标签，
 * 不影响 deny 判定：任一命中即受限）。无行 = NORMAL（真实默认态）。
 */
async function findMarketplaceRestrictionScope(
  tx: Prisma.TransactionClient,
  userId: string,
  campusId: string,
): Promise<"GLOBAL" | "CAMPUS" | null> {
  const restrictedRows = await tx.riskState.findMany({
    where: {
      userId,
      scopeKey: { in: [GLOBAL_SCOPE_KEY, riskScopeKey(campusId)] },
      state: "RESTRICTED",
    },
    select: { scopeKey: true },
  });

  if (restrictedRows.length === 0) {
    return null;
  }
  return restrictedRows.some((row) => row.scopeKey === GLOBAL_SCOPE_KEY)
    ? "GLOBAL"
    : "CAMPUS";
}

/** 事务内复核（调用方必须已持有目标用户（及参与方）的 subject 治理锁）。 */
export async function evaluateMarketplaceCapability(
  tx: Prisma.TransactionClient,
  userId: string,
  campusId: string,
  capability: MarketplaceCapability = DEFAULT_CAPABILITY,
): Promise<MarketplaceCapabilityResult> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, deletedAt: true, erasedAt: true },
  });

  if (!user || user.status !== "ACTIVE" || user.deletedAt !== null || user.erasedAt !== null) {
    return { allowed: false, denialReason: "ACCOUNT_INACTIVE" };
  }

  const membership = await tx.campusMembership.findFirst({
    where: { userId, campusId, status: "ACTIVE" },
    select: { id: true },
  });

  if (!membership) {
    return { allowed: false, denialReason: "MEMBERSHIP_NOT_ACTIVE" };
  }

  const restrictionScope = await findMarketplaceRestrictionScope(tx, userId, campusId);
  if (restrictionScope !== null) {
    return {
      allowed: false,
      denialReason: "RISK_RESTRICTED",
      matchedScopeKind: restrictionScope,
    };
  }

  return { allowed: true };
}

/**
 * 事务内强制门（checks-only 版本；锁由调用方持有）。
 * 拒绝统一抛 MARKETPLACE_RESTRICTED 之外的具体码：
 * account inactive → AUTH_ACCOUNT_INACTIVE；membership → MEMBERSHIP_NOT_ACTIVE；
 * risk → MARKETPLACE_RESTRICTED。
 */
export async function requireMarketplaceCapability(
  tx: Prisma.TransactionClient,
  userId: string,
  campusId: string,
  capability: MarketplaceCapability = DEFAULT_CAPABILITY,
): Promise<void> {
  const result = await evaluateMarketplaceCapability(tx, userId, campusId, capability);
  if (result.allowed) {
    return;
  }
  if (result.denialReason === "ACCOUNT_INACTIVE") {
    incrementCapabilityDenied(capability, "NONE");
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (result.denialReason === "MEMBERSHIP_NOT_ACTIVE") {
    incrementCapabilityDenied(capability, "NONE");
    throw rbacError("MEMBERSHIP_NOT_ACTIVE");
  }
  incrementCapabilityDenied(capability, result.matchedScopeKind ?? "NONE");
  throw enforcementError("MARKETPLACE_RESTRICTED");
}

/**
 * Phase 6C-3：新义务/新会话的**全参与方**资格门（checks-only；锁由调用方
 * 持有——义务路径由 withObligationGuard 持全参与方锁，会话路径在事务内
 * 自取参与方锁后调用）。
 *
 * 任一参与方在 authoritative campus 上 account / membership / risk 任一维
 * 失效 → 统一抛 MARKETPLACE_COUNTERPARTY_UNAVAILABLE(409)。刻意不区分
 * 是哪一方、哪一维（no-oracle：对外完全同形，杜绝状态探测）。
 * actor 已由 requireMarketplaceCapability 先行校验并通过（专用 403 族），
 * 因此本门失败必然可归因于对手方。
 *
 * 批量查询（与参与方人数无关，无 N+1）；无 risk 行 = NORMAL（真实默认态），
 * WATCH 不阻断。
 */
export async function requireParticipantsMarketplaceEligible(
  tx: Prisma.TransactionClient,
  participantUserIds: string[],
  campusId: string,
  capability: MarketplaceCapability = DEFAULT_CAPABILITY,
): Promise<void> {
  const uniqueIds = [...new Set(participantUserIds)];
  if (uniqueIds.length === 0) {
    return;
  }

  const users = await tx.user.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, status: true, deletedAt: true, erasedAt: true },
  });

  const activeById = new Map(
    users
      .filter(
        (user) =>
          user.status === "ACTIVE" && user.deletedAt === null && user.erasedAt === null,
      )
      .map((user) => [user.id, true]),
  );

  const memberships = await tx.campusMembership.findMany({
    where: { userId: { in: uniqueIds }, campusId, status: "ACTIVE" },
    select: { userId: true },
  });
  const activeMembershipIds = new Set(memberships.map((m) => m.userId));

  const restrictionRows = await tx.riskState.findMany({
    where: {
      userId: { in: uniqueIds },
      scopeKey: { in: [GLOBAL_SCOPE_KEY, riskScopeKey(campusId)] },
      state: "RESTRICTED",
    },
    select: { scopeKey: true },
  });

  if (
    activeById.size !== uniqueIds.length ||
    activeMembershipIds.size !== uniqueIds.length ||
    !uniqueIds.every((id) => activeMembershipIds.has(id)) ||
    restrictionRows.length > 0
  ) {
    const scopeKind =
      restrictionRows.length > 0
        ? restrictionRows.some((row) => row.scopeKey === GLOBAL_SCOPE_KEY)
          ? "GLOBAL"
          : "CAMPUS"
        : "NONE";
    incrementCapabilityDenied(capability, scopeKind);
    throw enforcementError("MARKETPLACE_COUNTERPARTY_UNAVAILABLE");
  }
}

/**
 * listing/内容创建（capability gate 的统一 choke point：
 * 自 subject 治理锁（actor == target，去重单锁）→ 能力门。
 * 必须在写事务的首条语句调用本函数——锁 + 门 + 创建在同一事务内，
 * 使"membership 停用/restrict vs listing 创建"严格先后线性化。
 */
export async function enforceMarketplaceCapability(
  tx: Prisma.TransactionClient,
  userId: string,
  campusId: string,
  capability: MarketplaceCapability = DEFAULT_CAPABILITY,
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: userId },
  ]);
  await requireMarketplaceCapability(tx, userId, campusId, capability);
  if (racePoint) {
    await racePoint(tx);
  }
}

/**
 * Phase 6C-3 Repair 2：新义务创建的锁内校验回调工厂（唯一组装点）。
 * withObligationGuard 取得全参与方锁后、racePoint 前调用返回的回调：
 *   STEP 1: actor 三门（专用 403 族错误）
 *   STEP 2: 全参与方资格（统一 409，对手方归因）
 * 禁止各调用点自行复制该序列。
 */
export function marketplaceObligationValidator(input: {
  initiatorId: string;
  participantUserIds: string[];
  campusId: string;
}): (tx: Prisma.TransactionClient) => Promise<void> {
  return async (tx: Prisma.TransactionClient) => {
    await requireMarketplaceCapability(
      tx,
      input.initiatorId,
      input.campusId,
      "START_NEW_MARKETPLACE_ACTIVITY",
    );
    await requireParticipantsMarketplaceEligible(
      tx,
      input.participantUserIds,
      input.campusId,
      "START_NEW_MARKETPLACE_ACTIVITY",
    );
  };
}

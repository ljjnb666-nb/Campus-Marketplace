import type { Prisma } from "@prisma/client";

import { enforcementError } from "@/lib/enforcement/errors";
import { isMarketplaceRestricted } from "@/lib/enforcement/risk-service";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { rbacError } from "@/lib/rbac/errors";

/**
 * Phase 6B：marketplace 能力门（中央 capability gate）。
 *
 * 能力：START_NEW_MARKETPLACE_ACTIVITY——开始**新的**交易/发布活动。
 *
 * 判定（全部 fail closed，在调用方已持 subject 锁的事务内执行）：
 *   account ACTIVE（status/deletedAt/erasedAt）
 *   AND applicable campus membership ACTIVE
 *   AND risk state != RESTRICTED（GLOBAL 或该校区任一 RESTRICTED 即拒绝）
 *
 * 语义边界（Phase 6B 产品不变量）：
 * - 仅约束"新的活动"；既有订单/义务/消息/隐私操作不在本门范围内
 *   （#16/#19：既有义务必须能在软限制下继续履行）
 * - 绝不接入 requireUser()/getVerifiedSession()（#16：否则软限制会把
 *   用户彻底踢出系统，阻断既有义务与退出权）
 * - WATCH 不阻断任何能力（观察态）
 * - 面向 actor：受限卖家的既有 listing 是否可被他人下单属 lifecycle
 *   策略（#44 DEFER_TO_6C_OR_PHASE_8），本门不做
 */

export type MarketplaceCapability = "START_NEW_MARKETPLACE_ACTIVITY";

export type MarketplaceCapabilityResult = {
  allowed: boolean;
  /** 拒绝时的机器可读原因（不直接暴露给客户端） */
  denialReason?:
    | "ACCOUNT_INACTIVE"
    | "MEMBERSHIP_NOT_ACTIVE"
    | "RISK_RESTRICTED";
};

/** 事务内复核（调用方必须已持有目标用户（及参与方）的 subject 治理锁）。 */
export async function evaluateMarketplaceCapability(
  tx: Prisma.TransactionClient,
  userId: string,
  campusId: string,
  capability: MarketplaceCapability = "START_NEW_MARKETPLACE_ACTIVITY",
): Promise<MarketplaceCapabilityResult> {
  void capability;

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

  if (await isMarketplaceRestricted(userId, campusId, tx)) {
    return { allowed: false, denialReason: "RISK_RESTRICTED" };
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
  capability: MarketplaceCapability = "START_NEW_MARKETPLACE_ACTIVITY",
): Promise<void> {
  const result = await evaluateMarketplaceCapability(tx, userId, campusId, capability);
  if (result.allowed) {
    return;
  }
  if (result.denialReason === "ACCOUNT_INACTIVE") {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (result.denialReason === "MEMBERSHIP_NOT_ACTIVE") {
    throw rbacError("MEMBERSHIP_NOT_ACTIVE");
  }
  throw enforcementError("MARKETPLACE_RESTRICTED");
}

/**
 * listing/内容创建路径的统一 choke point：
 * 自 subject 治理锁（actor == target，去重单锁）→ 能力门。
 * 四类创建入口（product/errand/service/rental listing）必须在其写事务的
 * 首条语句调用本函数——锁 + 门 + 创建在同一事务内，使"membership 停用
 * vs listing 创建"严格先后线性化（Phase 6B #43 竞态合同）。
 */
export async function enforceMarketplaceCreationGate(
  tx: Prisma.TransactionClient,
  userId: string,
  campusId: string,
): Promise<void> {
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: userId },
  ]);
  await requireMarketplaceCapability(tx, userId, campusId);
}

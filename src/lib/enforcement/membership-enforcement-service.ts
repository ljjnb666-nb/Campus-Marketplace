import type { CampusMembershipStatus, Prisma } from "@prisma/client";

import { enforcementError } from "@/lib/enforcement/errors";
import { resultStateFor, riskScopeKey } from "@/lib/enforcement/risk-scope";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { withTransaction } from "@/lib/prisma";
import { rbacError } from "@/lib/rbac/errors";
import {
  hasPermission,
  isPrivilegedTarget,
  loadAuthorizationContext,
} from "@/lib/rbac/service";

/**
 * Phase 6B：校园成员身份的停用 / 恢复服务。
 *
 * operational state = CampusMembership.status；本服务是其唯一管理入口
 * （erasure 路径的 →LEFT 仍属 Phase 5 注销合同）。
 *
 * 状态机（#26 fail closed）：
 *   ACTIVE    ↔ SUSPENDED   （唯一一对合法管理流转）
 *   LEFT / REJECTED / PENDING → 不允许恢复为 ACTIVE
 *   （LEFT→ACTIVE 语义是"重新加入"而非"解除处罚"，属于未来的加入流程；
 *     REJECTED/PENDING→ACTIVE 无执法语义。全部 DENY。）
 *
 * 权限（#25）：actor 须持有目标校区 campus.manage——
 * campus-scoped grant 自动要求其 ACTIVE membership 命中（6A 语义），
 * GLOBAL admin 可跨 campus。SELF_ENFORCEMENT = DENY。
 *
 * 认证互动（#27）：membership SUSPENDED 不触碰 UserVerification 历史证据——
 * 6A 授权已因 inactive membership fail closed，无需篡改证据。
 *
 * 锁序：sorted {USER:actor, USER:target} subject locks → actor 复核 →
 * target/membership 状态复核 → 行写 → EnforcementAction + 审计。
 */

const MEMBERSHIP_TRANSITIONS: Record<CampusMembershipStatus, CampusMembershipStatus[]> = {
  ACTIVE: ["SUSPENDED"],
  SUSPENDED: ["ACTIVE"],
  PENDING: [],
  REJECTED: [],
  LEFT: [],
};

export type MembershipEnforcementInput = {
  actorId: string;
  targetUserId: string;
  campusId: string;
  reasonCode: string;
  note?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type MembershipEnforcementResult = {
  status: CampusMembershipStatus;
  /** true = 目标本已处于目标状态（幂等 no-op） */
  alreadyInState: boolean;
};

async function lockAndCheck(
  tx: Prisma.TransactionClient,
  input: MembershipEnforcementInput,
): Promise<void> {
  if (input.actorId === input.targetUserId) {
    throw enforcementError("ENFORCEMENT_SELF_DENIED");
  }

  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
    { subjectType: "USER", subjectId: input.targetUserId },
  ]);

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  const actorContext = await loadAuthorizationContext(input.actorId, tx);
  if (!actorContext || !actorContext.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (!hasPermission(actorContext, "campus.manage", input.campusId)) {
    // 跨校区 / 无权限统一拒绝（不泄露目标存在性差异）
    throw rbacError("AUTH_CAMPUS_SCOPE_MISMATCH");
  }
}

/** 停用校园成员身份（ACTIVE → SUSPENDED）。幂等：已停用为 no-op。 */
export async function suspendCampusMembership(
  input: MembershipEnforcementInput,
): Promise<MembershipEnforcementResult> {
  return withTransaction(async (tx) => {
    await lockAndCheck(tx, input);

    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true, deletedAt: true, erasedAt: true },
    });
    if (!target || target.deletedAt || target.erasedAt) {
      throw enforcementError("ENFORCEMENT_TARGET_NOT_FOUND");
    }

    // Repair 1 Blocker F：privileged target 保护（full-admin 等价，
    // RBAC-derived——campus 经理不能停用 PLATFORM_ADMIN 的成员关系）
    if (await isPrivilegedTarget(input.targetUserId, tx)) {
      throw enforcementError("ENFORCEMENT_PRIVILEGED_TARGET");
    }

    const membership = await tx.campusMembership.findUnique({
      where: { userId_campusId: { userId: input.targetUserId, campusId: input.campusId } },
      select: { id: true, status: true },
    });
    if (!membership) {
      throw enforcementError("ENFORCEMENT_TARGET_NOT_FOUND");
    }

    if (membership.status === "SUSPENDED") {
      return { status: "SUSPENDED", alreadyInState: true };
    }
    if (!MEMBERSHIP_TRANSITIONS[membership.status].includes("SUSPENDED")) {
      throw enforcementError("ENFORCEMENT_INVALID_TRANSITION");
    }

    await tx.campusMembership.update({
      where: { id: membership.id },
      data: { status: "SUSPENDED" },
    });

    await tx.enforcementAction.create({
      data: {
        type: "MEMBERSHIP_SUSPEND",
        actorId: input.actorId,
        targetId: input.targetUserId,
        campusId: input.campusId,
        scopeKey: riskScopeKey(input.campusId),
        reasonCode: input.reasonCode as never,
        note: input.note || null,
        sourceType: input.sourceType || null,
        sourceId: input.sourceId || null,
        resultState: resultStateFor("CAMPUS_MEMBERSHIP", "SUSPENDED"),
      },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "SUSPEND_CAMPUS_MEMBERSHIP",
        targetType: "CAMPUS_MEMBERSHIP",
        targetId: membership.id,
        campusId: input.campusId,
        detail: input.note || null,
        metadata: {
          reasonCode: input.reasonCode,
          resultState: resultStateFor("CAMPUS_MEMBERSHIP", "SUSPENDED"),
          sourceType: input.sourceType || null,
          sourceId: input.sourceId || null,
        },
      },
      tx,
    );

    return { status: "SUSPENDED", alreadyInState: false };
  });
}

/** 恢复校园成员身份（SUSPENDED → ACTIVE）。幂等：已 ACTIVE 为 no-op。 */
export async function reinstateCampusMembership(
  input: MembershipEnforcementInput,
): Promise<MembershipEnforcementResult> {
  return withTransaction(async (tx) => {
    await lockAndCheck(tx, input);

    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true, deletedAt: true, erasedAt: true },
    });
    if (!target || target.deletedAt || target.erasedAt) {
      throw enforcementError("ENFORCEMENT_TARGET_NOT_FOUND");
    }

    // Repair 1 Blocker F：privileged target 保护
    if (await isPrivilegedTarget(input.targetUserId, tx)) {
      throw enforcementError("ENFORCEMENT_PRIVILEGED_TARGET");
    }

    const membership = await tx.campusMembership.findUnique({
      where: { userId_campusId: { userId: input.targetUserId, campusId: input.campusId } },
      select: { id: true, status: true },
    });
    if (!membership) {
      throw enforcementError("ENFORCEMENT_TARGET_NOT_FOUND");
    }

    if (membership.status === "ACTIVE") {
      return { status: "ACTIVE", alreadyInState: true };
    }
    if (!MEMBERSHIP_TRANSITIONS[membership.status].includes("ACTIVE")) {
      // LEFT/REJECTED/PENDING → 恢复 = fail closed（#26/#52）
      throw enforcementError("ENFORCEMENT_INVALID_TRANSITION");
    }

    await tx.campusMembership.update({
      where: { id: membership.id },
      data: { status: "ACTIVE" },
    });

    await tx.enforcementAction.create({
      data: {
        type: "MEMBERSHIP_REINSTATE",
        actorId: input.actorId,
        targetId: input.targetUserId,
        campusId: input.campusId,
        scopeKey: riskScopeKey(input.campusId),
        reasonCode: input.reasonCode as never,
        note: input.note || null,
        sourceType: input.sourceType || null,
        sourceId: input.sourceId || null,
        resultState: resultStateFor("CAMPUS_MEMBERSHIP", "ACTIVE"),
      },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "RESTORE_CAMPUS_MEMBERSHIP",
        targetType: "CAMPUS_MEMBERSHIP",
        targetId: membership.id,
        campusId: input.campusId,
        detail: input.note || null,
        metadata: {
          reasonCode: input.reasonCode,
          resultState: resultStateFor("CAMPUS_MEMBERSHIP", "ACTIVE"),
          sourceType: input.sourceType || null,
          sourceId: input.sourceId || null,
        },
      },
      tx,
    );

    return { status: "ACTIVE", alreadyInState: false };
  });
}

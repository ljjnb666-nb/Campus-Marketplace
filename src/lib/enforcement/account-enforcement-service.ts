import type { Prisma } from "@prisma/client";

import { enforcementError } from "@/lib/enforcement/errors";
import { resultStateFor, riskScopeKey } from "@/lib/enforcement/risk-scope";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { prisma, withTransaction } from "@/lib/prisma";
import { createNotification } from "@/repositories/notification-repository";
import { rbacError } from "@/lib/rbac/errors";
import {
  hasPermission,
  isPrivilegedTarget,
  loadAuthorizationContext,
} from "@/lib/rbac/service";

/**
 * Phase 6B：账号硬停用 / 恢复服务（operational state = User.status 的唯一变更入口）。
 *
 * 不变量：
 * - 所有 suspension/reinstatement 必须经本服务；admin action 只是薄 adapter
 * - sorted {USER:actor, USER:target} subject 治理锁（与 role grant/revoke、
 *   erasure、verification decision 共享同一序列化边界——正式关闭
 *   Phase 6A KNOWN_NON_BLOCKING `USER_STATUS_ROLE_ASSIGNMENT_RACE`）
 * - actor 权限：user.suspend（GLOBAL grant；账号停用是平台级动作）
 * - privileged target（full-admin 等价）保护：DENY（RBAC-derived，
 *   绝不读 User.role）
 * - SELF_ENFORCEMENT = DENY
 * - 幂等：已停用再停用 / 已 ACTIVE 再恢复 = no-op（deterministic）
 * - 每次**实际**状态变更写入 EnforcementAction（provenance，非第二授权源）
 *   + AdminAudit
 *
 * Repair 1 Blocker C（command/notification 原子性）：
 * 站内通知在**同一事务内**随 enforcement 写入——通知失败 → 整个命令回滚，
 * 不存在"已提交但报错"或"已成功但无声"的歧义中间态。
 *
 * 锁序：subject locks → actor 复核 → target 状态/特权复核 → 行写 → 审计+通知。
 */

export type AccountEnforcementInput = {
  actorId: string;
  targetUserId: string;
  reasonCode: string;
  note?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** 测试 seam：subject 锁取得之后、复核之前的受控暂停点 */
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type AccountEnforcementResult = {
  status: "SUSPENDED" | "ACTIVE";
  /** true = 目标本已处于目标状态（幂等 no-op，未产生执法记录） */
  alreadyInState: boolean;
};

async function lockAndValidateActor(
  tx: Prisma.TransactionClient,
  input: AccountEnforcementInput,
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
  // 账号停用是平台级动作：仅 GLOBAL user.suspend 授权（campus-scoped 不放行）
  if (!hasPermission(actorContext, "user.suspend")) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
}

async function lockAndValidateTarget(
  tx: Prisma.TransactionClient,
  input: AccountEnforcementInput,
): Promise<{ id: string; status: string }> {
  const target = await tx.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, status: true, deletedAt: true, erasedAt: true },
  });

  if (!target || target.deletedAt || target.erasedAt) {
    throw enforcementError("ENFORCEMENT_TARGET_NOT_FOUND");
  }

  // privileged target 保护（RBAC-derived；不读 User.role）
  if (await isPrivilegedTarget(input.targetUserId, tx)) {
    throw enforcementError("ENFORCEMENT_PRIVILEGED_TARGET");
  }

  return { id: target.id, status: target.status };
}

/** 停用账号（User.status ACTIVE → SUSPENDED）。幂等：已停用为 no-op。 */
export async function suspendAccount(
  input: AccountEnforcementInput,
): Promise<AccountEnforcementResult> {
  return withTransaction(async (tx) => {
    await lockAndValidateActor(tx, input);
    const target = await lockAndValidateTarget(tx, input);

    if (target.status === "SUSPENDED") {
      return { status: "SUSPENDED", alreadyInState: true };
    }

    await tx.user.update({
      where: { id: target.id },
      data: { status: "SUSPENDED" },
    });

    await tx.enforcementAction.create({
      data: {
        type: "ACCOUNT_SUSPEND",
        actorId: input.actorId,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        reasonCode: input.reasonCode as never,
        note: input.note || null,
        sourceType: input.sourceType || null,
        sourceId: input.sourceId || null,
        resultState: resultStateFor("USER", "SUSPENDED"),
      },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "SUSPEND_USER",
        targetType: "USER",
        targetId: target.id,
        detail: input.note || null,
        metadata: {
          reasonCode: input.reasonCode,
          resultState: resultStateFor("USER", "SUSPENDED"),
          sourceType: input.sourceType || null,
          sourceId: input.sourceId || null,
        },
      },
      tx,
    );

    // Repair 1 Blocker C：通知随命令同事务提交（失败整体回滚，无歧义中间态）
    await createNotification(tx, {
      userId: target.id,
      type: "SYSTEM",
      title: "账号已被停用",
      content: "你的账号当前已被管理员暂停使用，如有疑问请联系平台管理员。",
    });

    return { status: "SUSPENDED", alreadyInState: false };
  });
}

/** 恢复账号（User.status SUSPENDED → ACTIVE）。幂等：已 ACTIVE 为 no-op。 */
export async function reinstateAccount(
  input: AccountEnforcementInput,
): Promise<AccountEnforcementResult> {
  return withTransaction(async (tx) => {
    await lockAndValidateActor(tx, input);
    const target = await lockAndValidateTarget(tx, input);

    if (target.status === "ACTIVE") {
      return { status: "ACTIVE", alreadyInState: true };
    }

    await tx.user.update({
      where: { id: target.id },
      data: { status: "ACTIVE" },
    });

    await tx.enforcementAction.create({
      data: {
        type: "ACCOUNT_REINSTATE",
        actorId: input.actorId,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        reasonCode: input.reasonCode as never,
        note: input.note || null,
        sourceType: input.sourceType || null,
        sourceId: input.sourceId || null,
        resultState: resultStateFor("USER", "ACTIVE"),
      },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "RESTORE_USER",
        targetType: "USER",
        targetId: target.id,
        detail: input.note || null,
        metadata: {
          reasonCode: input.reasonCode,
          resultState: resultStateFor("USER", "ACTIVE"),
          sourceType: input.sourceType || null,
          sourceId: input.sourceId || null,
        },
      },
      tx,
    );

    // Repair 1 Blocker C：通知随命令同事务提交
    await createNotification(tx, {
      userId: target.id,
      type: "SYSTEM",
      title: "账号已恢复正常",
      content: "你的账号已恢复正常使用。",
    });

    return { status: "ACTIVE", alreadyInState: false };
  });
}

/** 供审计读取（Phase 7 之前无 UI）：目标的执法历史（append-only）。 */
export async function listEnforcementActionsForTarget(
  targetUserId: string,
  tx?: Prisma.TransactionClient,
) {
  if (tx) {
    return tx.enforcementAction.findMany({
      where: { targetId: targetUserId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  }

  return prisma.enforcementAction.findMany({
    where: { targetId: targetUserId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

export { riskScopeKey };

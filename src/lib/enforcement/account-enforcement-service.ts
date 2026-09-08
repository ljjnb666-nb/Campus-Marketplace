import type { Prisma } from "@prisma/client";

import { enforcementError } from "@/lib/enforcement/errors";
import { resultStateFor, riskScopeKey } from "@/lib/enforcement/risk-scope";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
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
 * Repair 2 Blocker C（command/notification 语义修正）：
 * authoritative transaction 只包含 subject 锁 + 授权/校验 + User.status
 * mutation + EnforcementAction + AdminAudit；站内通知为 **post-commit
 * best effort**——通知失败只记结构化日志（ENFORCEMENT_NOTIFICATION_FAILED），
 * 绝不回滚 enforcement、绝不伪装成 enforcement 失败。ACCOUNT_SUSPEND 的
 * SUCCESS 仅由 authoritative state transaction 决定。
 *
 * 锁序：subject locks → actor 复核 → target 状态/特权复核 → 行写 → 审计
 * → commit → best-effort notification。
 *
 * Phase 6C-1A TxLocked seam：*TxLocked seam 承载完整 authoritative 核
 * （self-deny / 授权复核 / target 存在与特权保护 / 幂等转移 / operational
 * mutation / previousState 捕获 / EnforcementAction / AdminAudit），但本身
 * 绝不取得治理 subject 锁——调用方（公共 wrapper 或未来 Appeal 调用方）
 * 必须先取得完整 sorted 锁集。previousState 记录锁内读取的动作前精确状态；
 * enforcementSeq 由 DB sequence 分配（因果序），createdAt 仅展示。
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

export type AccountAuthoritativeResult = {
  status: "SUSPENDED" | "ACTIVE";
  /** true = 目标本已处于目标状态（幂等 no-op，未产生执法记录） */
  alreadyInState: boolean;
};

export type AccountEnforcementResult = AccountAuthoritativeResult & {
  /**
   * Repair 2 Blocker C：通知为 post-commit best effort——
   * true = 已投递；false = 投递失败（仅日志/运营观察，不影响 command success）
   */
  notificationDelivered: boolean;
};

type NotificationPayloadSpec = {
  title: string;
  content: string;
};

/**
 * post-commit best-effort 通知：失败仅记结构化日志，不回滚、不上抛。
 * 日志载荷仅含 event/action/targetUserId/error class——不含 reason note
 * 原文、私密举报详情、凭据（Repair 2 §15）。
 */
async function bestEffortEnforcementNotification(
  action: "ACCOUNT_SUSPEND" | "ACCOUNT_REINSTATE",
  targetUserId: string,
  payload: NotificationPayloadSpec,
): Promise<boolean> {
  try {
    await withTransaction((tx) =>
      createNotification(tx, {
        userId: targetUserId,
        type: "SYSTEM",
        title: payload.title,
        content: payload.content,
      }),
    );
    return true;
  } catch (error) {
    logger.warn("账号执法通知投递失败（enforcement 不受影响）", "enforcement", {
      event: "ENFORCEMENT_NOTIFICATION_FAILED",
      action,
      targetUserId,
      error,
    });
    return false;
  }
}

/**
 * TxLocked seam：调用方必须已取得完整 sorted {USER:actor, USER:target}
 * subject 锁集（本函数不取任何治理锁）。停用前的精确 pre-state 在锁内读取。
 */
async function validateTargetLocked(
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

/**
 * Phase 6C-1A TxLocked seam：停用账号的 authoritative 核。
 *
 * 前置条件：调用方已取得完整 sorted {USER:actor, USER:target} subject 锁集。
 * 本 seam 不取治理锁；保留完整安全链（self-deny → 授权复核 → target 复核 →
 * 幂等 → mutation → previousState → EnforcementAction → AdminAudit）。
 */
export async function suspendAccountTxLocked(
  tx: Prisma.TransactionClient,
  input: AccountEnforcementInput,
): Promise<AccountAuthoritativeResult> {
  if (input.actorId === input.targetUserId) {
    throw enforcementError("ENFORCEMENT_SELF_DENIED");
  }

  const actorContext = await loadAuthorizationContext(input.actorId, tx);
  if (!actorContext || !actorContext.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  // 账号停用是平台级动作：仅 GLOBAL user.suspend 授权（campus-scoped 不放行）
  if (!hasPermission(actorContext, "user.suspend")) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }

  const target = await validateTargetLocked(tx, input);

  if (target.status === "SUSPENDED") {
    return { status: "SUSPENDED", alreadyInState: true };
  }

  // previousState：锁内读取的动作前精确状态（ACTIVE → SUSPENDED）
  const previousState = resultStateFor("USER", target.status);

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
      previousState,
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
        previousState,
        resultState: resultStateFor("USER", "SUSPENDED"),
        sourceType: input.sourceType || null,
        sourceId: input.sourceId || null,
      },
    },
    tx,
  );

  return { status: "SUSPENDED", alreadyInState: false };
}

/**
 * Phase 6C-1A TxLocked seam：恢复账号的 authoritative 核。
 *
 * 前置条件：调用方已取得完整 sorted {USER:actor, USER:target} subject 锁集。
 */
export async function reinstateAccountTxLocked(
  tx: Prisma.TransactionClient,
  input: AccountEnforcementInput,
): Promise<AccountAuthoritativeResult> {
  if (input.actorId === input.targetUserId) {
    throw enforcementError("ENFORCEMENT_SELF_DENIED");
  }

  const actorContext = await loadAuthorizationContext(input.actorId, tx);
  if (!actorContext || !actorContext.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (!hasPermission(actorContext, "user.suspend")) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }

  const target = await validateTargetLocked(tx, input);

  if (target.status === "ACTIVE") {
    return { status: "ACTIVE", alreadyInState: true };
  }

  // previousState：锁内读取的动作前精确状态（SUSPENDED → ACTIVE）
  const previousState = resultStateFor("USER", target.status);

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
      previousState,
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
        previousState,
        resultState: resultStateFor("USER", "ACTIVE"),
        sourceType: input.sourceType || null,
        sourceId: input.sourceId || null,
      },
    },
    tx,
  );

  return { status: "ACTIVE", alreadyInState: false };
}

/** 停用账号（User.status ACTIVE → SUSPENDED）。幂等：已停用为 no-op。 */
export async function suspendAccount(
  input: AccountEnforcementInput,
): Promise<AccountEnforcementResult> {
  const authoritative = await withTransaction(async (tx) => {
    // ONE COMPLETE SORTED SET：actor+target 一次性取得（禁止部分取锁）
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
      { subjectType: "USER", subjectId: input.targetUserId },
    ]);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    return suspendAccountTxLocked(tx, input);
  });

  // Repair 2 Blocker C：post-commit best-effort 通知（失败不影响 command success）
  const notificationDelivered = authoritative.alreadyInState
    ? false
    : await bestEffortEnforcementNotification("ACCOUNT_SUSPEND", input.targetUserId, {
        title: "账号已被停用",
        content: "你的账号当前已被管理员暂停使用，如有疑问请联系平台管理员。",
      });

  return { ...authoritative, notificationDelivered };
}

/** 恢复账号（User.status SUSPENDED → ACTIVE）。幂等：已 ACTIVE 为 no-op。 */
export async function reinstateAccount(
  input: AccountEnforcementInput,
): Promise<AccountEnforcementResult> {
  const authoritative = await withTransaction(async (tx) => {
    // ONE COMPLETE SORTED SET：actor+target 一次性取得（禁止部分取锁）
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
      { subjectType: "USER", subjectId: input.targetUserId },
    ]);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    return reinstateAccountTxLocked(tx, input);
  });

  const notificationDelivered = authoritative.alreadyInState
    ? false
    : await bestEffortEnforcementNotification("ACCOUNT_REINSTATE", input.targetUserId, {
        title: "账号已恢复正常",
        content: "你的账号已恢复正常使用。",
      });

  return { ...authoritative, notificationDelivered };
}

/**
 * 供审计读取（Phase 7 之前无 UI）：目标的执法历史（append-only）。
 *
 * createdAt 排序仅为展示序（wall-clock 审计视图）——绝不可用于授权、
 * stale check、latest enforcement 或任何因果比较（因果序 = enforcementSeq，
 * 见 enforcement-sequence.ts）。
 */
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

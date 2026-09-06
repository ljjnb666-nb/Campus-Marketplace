import { Prisma, type RiskStateLevel } from "@prisma/client";

import { enforcementError } from "@/lib/enforcement/errors";
import {
  riskScopeKey,
  assertRiskStateTransition,
  resultStateFor,
} from "@/lib/enforcement/risk-scope";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { prisma, withTransaction } from "@/lib/prisma";
import {
  hasFullAdminSurfaceAccess,
  hasPermission,
  loadAuthorizationContext,
} from "@/lib/rbac/service";
import { rbacError } from "@/lib/rbac/errors";

/**
 * Phase 6B：风险状态服务（显式 / 可解释 / 可逆 / 可审计）。
 *
 * 设计原则（NO_OPAQUE_SCORING）：
 * - 不存在 riskScore/trustScore 数值；状态只有 NORMAL/WATCH/RESTRICTED
 * - 每次变更必须携带 machine-readable reasonCode + actor + 来源（可选）
 * - RiskState 是可变操作态 projection：更新必须持 sorted
 *   {USER:actor, USER:target} subject 锁（无锁读→写 = lost update）
 * - 进入/离开 RESTRICTED 记录 EnforcementAction（MARKETPLACE_RESTRICT/RESTORE）；
 *   WATCH 变更仅记录 AdminAudit（不在六类执法动作枚举内）
 * - 无行 = NORMAL（真实默认，不做推断式回填）
 *
 * 权限映射（复用既有 10 个 permission，不新增）：
 * - GLOBAL 作用域 restrict/restore：user.suspend（GLOBAL grant）
 * - CAMPUS 作用域 restrict/restore：campus.manage（该校区；
 *   campus-scoped actor 自动要求其 ACTIVE membership 命中——6A 语义）
 *
 * SELF_ENFORCEMENT = DENY；privileged target（full-admin 等价）保护 = DENY。
 */

export type RiskScopeState = {
  scopeKey: string;
  campusId: string | null;
  state: RiskStateLevel;
  reasonCode: string | null;
};

export async function getRiskStateRows(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<RiskScopeState[]> {
  // 扩展客户端与事务客户端的联合类型会触发 Prisma excessive stack depth
  // （见 legal-document-service.ts 同注），prisma / tx 两条路径显式分开。
  if (tx) {
    const rows = await tx.riskState.findMany({
      where: { userId },
      select: { scopeKey: true, campusId: true, state: true, reasonCode: true },
      orderBy: [{ scopeKey: "asc" }],
    });
    return rows;
  }

  const rows = await prisma.riskState.findMany({
    where: { userId },
    select: { scopeKey: true, campusId: true, state: true, reasonCode: true },
    orderBy: [{ scopeKey: "asc" }],
  });
  return rows;
}

/**
 * marketplace 限制判定（纯读；调用方如需 serialization 必须已持 subject 锁）。
 * GLOBAL RESTRICTED 或目标校区 CAMPUS RESTRICTED 任一命中即受限。
 */
export async function isMarketplaceRestricted(
  userId: string,
  campusId: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const where = {
    userId,
    scopeKey: { in: [riskScopeKey(null), riskScopeKey(campusId)] },
    state: "RESTRICTED" as const,
  };
  const select = { scopeKey: true };

  if (tx) {
    const rows = await tx.riskState.findMany({ where, select });
    return rows.length > 0;
  }

  const rows = await prisma.riskState.findMany({ where, select });
  return rows.length > 0;
}

export type SetRiskStateInput = {
  actorId: string;
  targetUserId: string;
  /** null = GLOBAL 作用域 */
  campusId: string | null;
  state: "NORMAL" | "WATCH" | "RESTRICTED";
  reasonCode: string;
  note?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** 测试 seam：subject 锁取得之后、复核之前的受控暂停点 */
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type SetRiskStateResult = {
  scopeKey: string;
  state: RiskStateLevel;
  previousState: RiskStateLevel | null;
  /** true = 本次产生实际变更；false = 同状态幂等 no-op */
  changed: boolean;
};

export async function setRiskState(input: SetRiskStateInput): Promise<SetRiskStateResult> {
  return withTransaction(async (tx) => {
    // SELF_ENFORCEMENT = DENY（锁前 fail closed）
    if (input.actorId === input.targetUserId) {
      throw enforcementError("ENFORCEMENT_SELF_DENIED");
    }

    // actor serialization（Phase 6B #36：禁止无锁读→写）
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
      { subjectType: "USER", subjectId: input.targetUserId },
    ]);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    // target 存在性 + 未注销（已注销账号不进入风险态管理——其能力已被账号门关闭）
    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true, status: true, deletedAt: true, erasedAt: true },
    });
    if (!target || target.deletedAt || target.erasedAt) {
      throw enforcementError("ENFORCEMENT_TARGET_NOT_FOUND");
    }

    // privileged target 保护：full-admin 等价账号不接受风险态变更
    if (await hasFullAdminSurfaceAccess(await loadAuthorizationContext(input.targetUserId, tx))) {
      throw enforcementError("ENFORCEMENT_PRIVILEGED_TARGET");
    }

    const scopeKey = riskScopeKey(input.campusId);

    // actor 权限（subject 锁之后复核；TOCTOU 关闭）
    const actorContext = await loadAuthorizationContext(input.actorId, tx);
    if (!actorContext || !actorContext.accountActive) {
      throw rbacError("AUTH_ACCOUNT_INACTIVE");
    }
    const allowed =
      input.campusId == null
        ? hasPermission(actorContext, "user.suspend")
        : hasPermission(actorContext, "campus.manage", input.campusId);
    if (!allowed) {
      throw rbacError("AUTH_PERMISSION_DENIED");
    }

    const existing = await tx.riskState.findUnique({
      where: { userId_scopeKey: { userId: input.targetUserId, scopeKey } },
    });

    const previousState = existing?.state ?? null;

    // 幂等：同状态重复设置为 no-op（不产生执法记录）
    if ((previousState ?? "NORMAL") === input.state) {
      return { scopeKey, state: input.state as RiskStateLevel, previousState, changed: false };
    }

    assertRiskStateTransition(previousState, input.state);

    const row = await tx.riskState.upsert({
      where: { userId_scopeKey: { userId: input.targetUserId, scopeKey } },
      update: { state: input.state, reasonCode: input.reasonCode, updatedById: input.actorId, campusId: input.campusId },
      create: {
        userId: input.targetUserId,
        campusId: input.campusId,
        scopeKey,
        state: input.state,
        reasonCode: input.reasonCode,
        updatedById: input.actorId,
      },
    });

    // EnforcementAction 仅记录进入/离开 RESTRICTED 的执法决策（历史/溯源表）；
    // WATCH 变更仅记录管理审计
    const enteredRestriction = input.state === "RESTRICTED";
    const leftRestriction = previousState === "RESTRICTED" && input.state !== "RESTRICTED";

    if (enteredRestriction || leftRestriction) {
      await tx.enforcementAction.create({
        data: {
          type: enteredRestriction ? "MARKETPLACE_RESTRICT" : "MARKETPLACE_RESTORE",
          actorId: input.actorId,
          targetId: input.targetUserId,
          campusId: input.campusId,
          scopeKey,
          reasonCode: input.reasonCode as never,
          note: input.note || null,
          sourceType: input.sourceType || null,
          sourceId: input.sourceId || null,
          resultState: resultStateFor("RISK_STATE", input.state, input.campusId),
        },
      });
    }

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: enteredRestriction
          ? "MARKETPLACE_RESTRICTED"
          : leftRestriction
            ? "MARKETPLACE_RESTORED"
            : input.state === "WATCH"
              ? "RISK_WATCH_SET"
              : "RISK_WATCH_CLEARED",
        targetType: "USER",
        targetId: input.targetUserId,
        campusId: input.campusId,
        detail: input.note || null,
        metadata: {
          riskState: input.state,
          scopeKey,
          reasonCode: input.reasonCode,
          sourceType: input.sourceType || null,
          sourceId: input.sourceId || null,
        },
      },
      tx,
    );

    return {
      scopeKey,
      state: row.state as RiskStateLevel,
      previousState,
      changed: true,
    };
  });
}

/**
 * 记录风险信号（source-linked + deduplicated）。信号 != 裁决事实；
 * 本函数绝不产生任何处罚（REPORT_SUBMITTED 等仅为可审计信号）。
 * 系统来源（举报创建）无 actor；管理员手动标记传 createdById。
 */
export async function recordRiskFlag(
  input: {
    userId: string;
    campusId?: string | null;
    kind: "REPORT_SUBMITTED" | "REPORT_CONFIRMED" | "RENTAL_DISPUTE_OPENED" | "MANUAL_FLAG";
    severity?: "INFO" | "LOW" | "MEDIUM" | "HIGH";
    sourceType: string;
    sourceId: string;
    reasonCode?: string | null;
    note?: string | null;
    createdById?: string | null;
  },
  tx?: Prisma.TransactionClient,
): Promise<{ created: boolean }> {
  const run = async (client: Prisma.TransactionClient): Promise<{ created: boolean }> => {
    try {
      await client.riskFlag.create({
        data: {
          userId: input.userId,
          campusId: input.campusId ?? null,
          kind: input.kind,
          severity: input.severity ?? "INFO",
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          reasonCode: input.reasonCode || null,
          note: input.note || null,
          createdById: input.createdById ?? null,
        },
      });
      return { created: true };
    } catch (error) {
      // 同 (kind, sourceType, sourceId) 重复信号：幂等忽略
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { created: false };
      }
      throw error;
    }
  };

  if (tx) {
    return run(tx);
  }
  return withTransaction(run);
}

/** 解析风险信号（如举报被驳回时将其未裁决信号闭环）。 */
export async function resolveRiskFlag(
  input: {
    kind: "REPORT_SUBMITTED" | "REPORT_CONFIRMED" | "RENTAL_DISPUTE_OPENED" | "MANUAL_FLAG";
    sourceType: string;
    sourceId: string;
    resolvedById: string;
  },
  tx?: Prisma.TransactionClient,
): Promise<{ resolved: boolean }> {
  const run = async (client: Prisma.TransactionClient): Promise<{ resolved: boolean }> => {
    const flag = await client.riskFlag.findUnique({
      where: {
        kind_sourceType_sourceId: {
          kind: input.kind,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
      },
      select: { id: true, status: true },
    });
    if (!flag || flag.status === "RESOLVED") {
      return { resolved: false };
    }
    await client.riskFlag.update({
      where: { id: flag.id },
      data: { status: "RESOLVED", resolvedById: input.resolvedById, resolvedAt: new Date() },
    });
    return { resolved: true };
  };

  if (tx) {
    return run(tx);
  }
  return withTransaction(run);
}

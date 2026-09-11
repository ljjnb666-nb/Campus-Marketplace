import type { AppealDecisionReasonCode, AppealStatus, EnforcementActionType, Prisma } from "@prisma/client";

import {
  resolveRestorationTarget,
  restoreFromAppealTxLocked,
  type AppealRestorationTarget,
} from "@/lib/appeals/appeal-restore";
import { APPEAL_DECISION_NOTE_MAX_LENGTH } from "@/lib/appeals/appeal-service";
import { appealError } from "@/lib/appeals/errors";
import {
  hasCompleteReversalProvenance,
  isCausallyOrdered,
  isRestorative,
  latestSameFamilyAction,
} from "@/lib/enforcement/enforcement-sequence";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
import { withTransaction } from "@/lib/prisma";
import { hasPermission, loadAuthorizationContext, type AuthorizationContext } from "@/lib/rbac/service";
import { createNotification } from "@/repositories/notification-repository";

/**
 * Phase 6C-1B：申诉审核服务（begin review + terminal decision）。
 *
 * 锁纪律（hard invariant，Planning Repair 1–4 冻结）：
 *   BEGIN
 *   1. SELECT Appeal FOR UPDATE（行锁；全仓唯一触碰 Appeal 行的路径族，
 *      行锁是全局锁序中的叶节点 → 行锁在前不构成死锁环）
 *   2. load immutable EnforcementAction（解析 reviewer/target/scope）
 *   3. acquireGovernanceSubjectLocks：一次完整 sorted {USER:reviewer, USER:target}
 *      （与 erasure / enforcement / role assignment 共享同一 serialization
 *      boundary；禁止分批取锁或反序）
 *   4. AFTER locks：重读 reviewer AuthorizationContext（accountActive +
 *      appeal.review 正确 scope）——角色撤销/账号停用竞态在此关闭
 *   5. reviewer != appellant/target（零例外）
 *   6. 状态机校验（行锁持续持有，status 不可能被并发改变）
 *   7. effectiveness/provenance 校验（复用 6C-1A latestSameFamilyAction，
 *      仅 enforcementSeq DESC；程序性结局 → DISMISSED 提交，绝不 throw）
 *   8. merits：GRANTED → canonical TxLocked seam（note=null）；
 *      UPHELD → 零 operational mutation
 *   9. terminal Appeal 写入（reviewedById = 实际决策者）
 *  10. AdminAudit（机器字段，detail=null；selfReview 强制显式）
 *  11. commit → post-commit best-effort notification
 *
 * IN_REVIEW 仅是 workflow 状态（无 claimant 语义）：begin review 不写
 * reviewedById/reviewedAt，任一后续 authorized reviewer 可作 terminal decision。
 *
 * Self-review policy（冻结）：reviewer == appealed.actorId = ALLOWED，
 * 但 AdminAudit.metadata.selfReview = true 强制显式，绝不静默。
 * reviewer == appellant（EA.targetId）= APPEAL_REVIEWER_IS_APPELLANT，零例外。
 */

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "GRANTED",
  "UPHELD",
  "DISMISSED",
  "WITHDRAWN",
]);

type ProceduralReasonCode = Extract<
  AppealDecisionReasonCode,
  "STALE_ENFORCEMENT" | "ENFORCEMENT_ALREADY_REVERSED" | "LEGACY_PROVENANCE_INSUFFICIENT" | "APPELLANT_ERASED"
>;

export type AppealReviewOutcome = "GRANTED" | "UPHELD" | "DISMISSED";

export type AppealReviewResult = {
  appeal: {
    id: string;
    enforcementActionId: string;
    status: AppealStatus;
    decisionReasonCode: AppealDecisionReasonCode | null;
    reviewedById: string | null;
    reviewedAt: Date | null;
  };
  outcome: AppealReviewOutcome;
  reasonCode: AppealDecisionReasonCode | null;
};

type AppealReviewInput = {
  reviewerId: string;
  appealId: string;
  /** 测试 seam：subject 锁取得之后、授权复核之前的受控暂停点 */
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

type LockedAppeal = {
  id: string;
  status: AppealStatus;
  enforcementActionId: string;
  enforcementAction: {
    id: string;
    type: EnforcementActionType;
    actorId: string;
    targetId: string;
    campusId: string | null;
    scopeKey: string;
    previousState: string | null;
    enforcementSeq: bigint;
  };
};

/** canonical review scope（由 immutable EA 的 type/campusId/scopeKey 解析）。 */
type AppealReviewScope = { kind: "GLOBAL" } | { kind: "CAMPUS"; campusId: string };

/**
 * 从 EnforcementAction 解析并校验 canonical review scope（Repair 1 A4，fail closed）：
 * - ACCOUNT_SUSPEND：campusId=null + scopeKey=GLOBAL → GLOBAL；
 * - MEMBERSHIP_SUSPEND：campusId 非空 + scopeKey=CAMPUS:<campusId> → CAMPUS(campusId)；
 * - MARKETPLACE_RESTRICT：GLOBAL 形状（campusId=null + GLOBAL）或 CAMPUS 形状
 *   （campusId 非空 + CAMPUS:<campusId>）。
 * type/campusId/scopeKey 三者不一致（malformed 行）→ null：无法确立审核 scope，
 * 一律 APPEAL_REVIEW_FORBIDDEN——绝不允许 campus reviewer 借 malformed campusId
 * 审核 GLOBAL appeal，也不允许审核 scope 与恢复 scope 分叉。
 */
function resolveAppealReviewScope(action: {
  type: EnforcementActionType;
  campusId: string | null;
  scopeKey: string;
}): AppealReviewScope | null {
  switch (action.type) {
    case "ACCOUNT_SUSPEND":
      return action.campusId === null && action.scopeKey === "GLOBAL"
        ? { kind: "GLOBAL" }
        : null;
    case "MEMBERSHIP_SUSPEND":
      return action.campusId !== null && action.scopeKey === `CAMPUS:${action.campusId}`
        ? { kind: "CAMPUS", campusId: action.campusId }
        : null;
    case "MARKETPLACE_RESTRICT":
      if (action.campusId === null && action.scopeKey === "GLOBAL") {
        return { kind: "GLOBAL" };
      }
      if (action.campusId !== null && action.scopeKey === `CAMPUS:${action.campusId}`) {
        return { kind: "CAMPUS", campusId: action.campusId };
      }
      return null;
    default:
      return null;
  }
}

/** Appeal 行锁（全局 Appeal-row 锁序第一步，参数化 raw SQL）+ 锁内全读。 */
async function lockAppealRow(
  tx: Prisma.TransactionClient,
  appealId: string,
): Promise<LockedAppeal | null> {
  await tx.$queryRaw`SELECT "id" FROM "Appeal" WHERE "id" = ${appealId} FOR UPDATE`;
  return tx.appeal.findUnique({
    where: { id: appealId },
    select: {
      id: true,
      status: true,
      enforcementActionId: true,
      enforcementAction: {
        select: {
          id: true,
          type: true,
          actorId: true,
          targetId: true,
          campusId: true,
          scopeKey: true,
          previousState: true,
          // 6C-1A 两维分类（isCausallyOrdered 等）的最小行形状
          enforcementSeq: true,
        },
      },
    },
  });
}

/**
 * review 授权复核（必须 AFTER governance locks 调用）：
 * - GLOBAL enforcement（ACCOUNT / GLOBAL RISK）→ appeal.review GLOBAL；
 * - campus enforcement（MEMBERSHIP / CAMPUS RISK）→ appeal.review exact campus
 *   或 GLOBAL（hasPermission 内含 campus-scoped grant 的 ACTIVE membership 命中）。
 * 持有 appeal.review 但 scope 不符 → APPEAL_SCOPE_MISMATCH；
 * 完全不持有 → APPEAL_REVIEW_FORBIDDEN（均不泄露目标存在性差异）。
 */
function requireAppealReviewAuthorization(
  context: AuthorizationContext | null,
  campusId: string | null,
): void {
  if (!context || !context.accountActive) {
    throw appealError("APPEAL_REVIEW_FORBIDDEN");
  }
  const scopeOk =
    campusId == null
      ? hasPermission(context, "appeal.review")
      : hasPermission(context, "appeal.review", campusId);
  if (scopeOk) {
    return;
  }
  const holdsPermissionSomewhere = context.grants.some((grant) =>
    grant.permissionKeys.includes("appeal.review"),
  );
  throw holdsPermissionSomewhere
    ? appealError("APPEAL_SCOPE_MISMATCH")
    : appealError("APPEAL_REVIEW_FORBIDDEN");
}

/**
 * operational-state 二次核对（§22）：sequence provenance 不替代当前 state。
 * ACCOUNT → User.status == SUSPENDED；MEMBERSHIP → status == SUSPENDED（同 campus）；
 * RISK → RiskState == RESTRICTED（exact scopeKey）。
 */
async function operationalStateMatches(
  tx: Prisma.TransactionClient,
  action: LockedAppeal["enforcementAction"],
): Promise<boolean> {
  switch (action.type) {
    case "ACCOUNT_SUSPEND": {
      const user = await tx.user.findUnique({
        where: { id: action.targetId },
        select: { status: true },
      });
      return user?.status === "SUSPENDED";
    }
    case "MEMBERSHIP_SUSPEND": {
      if (action.campusId === null) {
        return false;
      }
      const membership = await tx.campusMembership.findUnique({
        where: {
          userId_campusId: { userId: action.targetId, campusId: action.campusId },
        },
        select: { status: true },
      });
      return membership?.status === "SUSPENDED";
    }
    case "MARKETPLACE_RESTRICT": {
      const risk = await tx.riskState.findUnique({
        where: { userId_scopeKey: { userId: action.targetId, scopeKey: action.scopeKey } },
        select: { state: true },
      });
      return risk?.state === "RESTRICTED";
    }
    default:
      // restorative 类型不可申诉（submission 已拒绝）；防御分支 fail closed
      return false;
  }
}

/** 程序性 DISMISSED：成功提交的 workflow 结局——持久化 + 审计 + 正常返回，绝不 throw。 */
async function persistProceduralDismissal(
  tx: Prisma.TransactionClient,
  args: {
    appealId: string;
    enforcementActionId: string;
    reviewerId: string;
    reason: ProceduralReasonCode;
    selfReview: boolean;
    decisionNote: string | null;
    targetUserId: string;
  },
): Promise<AppealReviewResult & { targetUserId: string }> {
  const reviewedAt = new Date();
  const updated = await tx.appeal.update({
    where: { id: args.appealId },
    data: {
      status: "DISMISSED",
      reviewedById: args.reviewerId,
      reviewedAt,
      decisionReasonCode: args.reason,
      decisionNote: args.decisionNote,
    },
  });

  await recordAdminAudit(
    {
      actorId: args.reviewerId,
      action: "APPEAL_DISMISSED",
      targetType: "APPEAL",
      targetId: args.appealId,
      detail: null,
      metadata: {
        appealId: args.appealId,
        appealStatus: "DISMISSED",
        decisionReasonCode: args.reason,
        selfReview: args.selfReview,
        enforcementActionId: args.enforcementActionId,
      },
    },
    tx,
  );

  return {
    appeal: {
      id: updated.id,
      enforcementActionId: updated.enforcementActionId,
      status: updated.status,
      decisionReasonCode: updated.decisionReasonCode,
      reviewedById: updated.reviewedById,
      reviewedAt: updated.reviewedAt,
    },
    outcome: "DISMISSED",
    reasonCode: args.reason,
    targetUserId: args.targetUserId,
  };
}

/**
 * 开始实质审核（SUBMITTED → IN_REVIEW）。IN_REVIEW 是 workflow-only 状态：
 * 不写 reviewedById / reviewedAt，不建立 reviewer ownership——WITHDRAW 窗口
 * 由此关闭（IN_REVIEW 起不可撤回），但任一 authorized reviewer 仍可决策。
 */
export async function beginAppealReview(input: AppealReviewInput): Promise<void> {
  await withTransaction(async (tx) => {
    // 1. 行锁 + 2. immutable EA
    const appeal = await lockAppealRow(tx, input.appealId);
    if (!appeal) {
      throw appealError("APPEAL_NOT_FOUND");
    }
    const action = appeal.enforcementAction;

    // 3. 完整 sorted subject 锁（一次取齐）
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.reviewerId },
      { subjectType: "USER", subjectId: action.targetId },
    ]);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    // 4. AFTER locks：重读授权上下文（角色撤销/账号停用竞态关闭点）
    const reviewScope = resolveAppealReviewScope(action);
    if (!reviewScope) {
      throw appealError("APPEAL_REVIEW_FORBIDDEN");
    }
    const context = await loadAuthorizationContext(input.reviewerId, tx);
    requireAppealReviewAuthorization(
      context,
      reviewScope.kind === "CAMPUS" ? reviewScope.campusId : null,
    );

    // 5. reviewer != appellant（零例外）
    if (input.reviewerId === action.targetId) {
      throw appealError("APPEAL_REVIEWER_IS_APPELLANT");
    }

    // 6. 状态机（行锁持有中，状态不可能被并发改变；belt-and-braces 重读语义
    //    已由步骤 1 的锁内 findUnique 覆盖）
    if (appeal.status !== "SUBMITTED") {
      throw appealError("APPEAL_INVALID_TRANSITION");
    }

    // 9（workflow-only）：不写 reviewedById / reviewedAt
    await tx.appeal.update({
      where: { id: appeal.id },
      data: { status: "IN_REVIEW" },
    });

    // 10. AdminAudit：机器字段，detail 恒 null
    await recordAdminAudit(
      {
        actorId: input.reviewerId,
        action: "APPEAL_REVIEW_STARTED",
        targetType: "APPEAL",
        targetId: appeal.id,
        detail: null,
        metadata: {
          appealId: appeal.id,
          appealStatus: "IN_REVIEW",
          enforcementActionId: action.id,
        },
      },
      tx,
    );
  });
}

export type DecideAppealInput = {
  reviewerId: string;
  appealId: string;
  decision: "GRANTED" | "UPHELD";
  decisionNote?: string | null;
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

const MERIT_REASON_CODE: Record<"GRANTED" | "UPHELD", AppealDecisionReasonCode> = {
  GRANTED: "MERIT_APPEAL_JUSTIFIED",
  UPHELD: "MERIT_VIOLATION_CONFIRMED",
};

/**
 * Terminal decision（merits）。程序性条件在锁内确定性计算并作为
 * 成功 workflow 结局 COMMIT（DISMISSED + decisionReasonCode），绝不 throw。
 * reviewedById 记录实际 terminal 决策者（与 begin review 的 reviewer 无关）。
 */
export async function decideAppeal(input: DecideAppealInput): Promise<AppealReviewResult> {
  const decisionNote = (input.decisionNote ?? "").trim();
  if (decisionNote.length > APPEAL_DECISION_NOTE_MAX_LENGTH) {
    throw appealError("APPEAL_NOT_ALLOWED", {
      userMessage: `审核备注不能超过 ${APPEAL_DECISION_NOTE_MAX_LENGTH} 字`,
    });
  }
  const note = decisionNote.length > 0 ? decisionNote : null;

  const result = await withTransaction(async (tx) => {
    // 1. 行锁 + 2. immutable EA（owner/target/scope 全部由此解析）
    const appeal = await lockAppealRow(tx, input.appealId);
    if (!appeal) {
      throw appealError("APPEAL_NOT_FOUND");
    }
    const action = appeal.enforcementAction;
    const targetId = action.targetId;

    // 3. 完整 sorted subject 锁
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.reviewerId },
      { subjectType: "USER", subjectId: targetId },
    ]);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    // 4. AFTER locks：授权重读（scope 由 immutable EA 严格解析，malformed → FORBIDDEN）
    const reviewScope = resolveAppealReviewScope(action);
    if (!reviewScope) {
      throw appealError("APPEAL_REVIEW_FORBIDDEN");
    }
    const context = await loadAuthorizationContext(input.reviewerId, tx);
    requireAppealReviewAuthorization(
      context,
      reviewScope.kind === "CAMPUS" ? reviewScope.campusId : null,
    );

    // reviewer != appellant（零例外）
    if (input.reviewerId === targetId) {
      throw appealError("APPEAL_REVIEWER_IS_APPELLANT");
    }

    // 5. 非 terminal 才可决策（double-review loser 在此收敛）
    if (TERMINAL_STATUSES.has(appeal.status)) {
      throw appealError("APPEAL_INVALID_TRANSITION");
    }

    const selfReview = input.reviewerId === action.actorId;

    const dismissalArgs = {
      appealId: appeal.id,
      enforcementActionId: action.id,
      reviewerId: input.reviewerId,
      selfReview,
      decisionNote: note,
      targetUserId: targetId,
    };

    // 6a. appellant erased/deleted → 程序性终结（committed outcome，不 throw）
    const targetUser = await tx.user.findUnique({
      where: { id: targetId },
      select: { deletedAt: true, erasedAt: true },
    });
    if (!targetUser || targetUser.deletedAt || targetUser.erasedAt) {
      return persistProceduralDismissal(tx, { ...dismissalArgs, reason: "APPELLANT_ERASED" });
    }

    // 6b. causal + reversal provenance（6C-1A 两维正交分类；禁止猜测恢复目标）
    if (!isCausallyOrdered(action) || !hasCompleteReversalProvenance(action)) {
      return persistProceduralDismissal(tx, {
        ...dismissalArgs,
        reason: "LEGACY_PROVENANCE_INSUFFICIENT",
      });
    }

    // 6c. latest same-family（复用 6C-1A 算法，enforcementSeq DESC；跨 scope 不 supersede）
    const latest = await latestSameFamilyAction(tx, {
      targetId,
      scopeKey: action.scopeKey,
      type: action.type,
    });
    if (!latest || latest.id !== action.id) {
      return persistProceduralDismissal(tx, {
        ...dismissalArgs,
        reason:
          latest && isRestorative(latest.type)
            ? "ENFORCEMENT_ALREADY_REVERSED"
            : "STALE_ENFORCEMENT",
      });
    }

    // 6d. operational-state 二次核对
    if (!(await operationalStateMatches(tx, action))) {
      return persistProceduralDismissal(tx, {
        ...dismissalArgs,
        reason: "ENFORCEMENT_ALREADY_REVERSED",
      });
    }

    // 8. merits
    let restorationTarget: AppealRestorationTarget | null = null;
    if (input.decision === "GRANTED") {
      // 恢复目标必须从 appealed.previousState 精确解析（WATCH 回 WATCH，
      // NORMAL 回 NORMAL；解析失败 = LEGACY_PROVENANCE_INSUFFICIENT，绝不硬编码）
      restorationTarget = resolveRestorationTarget({
        type: action.type,
        campusId: action.campusId,
        scopeKey: action.scopeKey,
        previousState: action.previousState,
      });
      if (!restorationTarget) {
        return persistProceduralDismissal(tx, {
          ...dismissalArgs,
          reason: "LEGACY_PROVENANCE_INSUFFICIENT",
        });
      }
      // canonical TxLocked seam（零治理锁；seam 自身的授权/privileged 复核
      // 原样生效——canonical 拒绝的 Appeal 不绕过，错误原样上抛回滚）
      await restoreFromAppealTxLocked(tx, {
        appealId: appeal.id,
        reviewerId: input.reviewerId,
        targetUserId: targetId,
        target: restorationTarget,
      });
    }

    // 9. terminal Appeal 写入（reviewedById = 实际决策者）
    const reasonCode = MERIT_REASON_CODE[input.decision];
    const reviewedAt = new Date();
    const updated = await tx.appeal.update({
      where: { id: appeal.id },
      data: {
        status: input.decision,
        reviewedById: input.reviewerId,
        reviewedAt,
        decisionReasonCode: reasonCode,
        decisionNote: note,
      },
    });

    // 10. AdminAudit（机器字段；selfReview 强制显式；detail 恒 null）
    await recordAdminAudit(
      {
        actorId: input.reviewerId,
        action: `APPEAL_${input.decision}`,
        targetType: "APPEAL",
        targetId: appeal.id,
        detail: null,
        metadata: {
          appealId: appeal.id,
          appealStatus: input.decision,
          decisionReasonCode: reasonCode,
          selfReview,
          enforcementActionId: action.id,
        },
      },
      tx,
    );

  return {
    appeal: {
      id: updated.id,
      enforcementActionId: updated.enforcementActionId,
      status: updated.status,
      decisionReasonCode: updated.decisionReasonCode,
      reviewedById: updated.reviewedById,
      reviewedAt: updated.reviewedAt,
    },
    outcome: input.decision,
    reasonCode,
    targetUserId: targetId,
  };
});

// 11. post-commit best-effort 通知（固定文案，不含 decisionNote/statement；
// 失败仅日志，绝不回滚决策 / restoration；通知目标 = appellant）
await notifyDecision(result.appeal.id, result.targetUserId, result.outcome);

return {
  appeal: result.appeal,
  outcome: result.outcome,
  reasonCode: result.reasonCode,
};
}

async function notifyDecision(appealId: string, userId: string, outcome: AppealReviewOutcome): Promise<void> {
  const copy: Record<AppealReviewOutcome, { title: string; content: string }> = {
    GRANTED: {
      title: "你的申诉已通过",
      content: "你提交的申诉已审核通过，相关处罚已被解除。",
    },
    UPHELD: {
      title: "你的申诉已审核",
      content: "你提交的申诉已审核完毕，原处罚维持不变。",
    },
    DISMISSED: {
      title: "你的申诉已处理",
      content: "你提交的申诉已按平台流程处理完毕。",
    },
  };
  const { title, content } = copy[outcome];
  try {
    await withTransaction((tx) =>
      createNotification(tx, {
        userId,
        type: "SYSTEM",
        title,
        content,
      }),
    );
  } catch (error) {
    logger.warn("申诉通知投递失败（不影响申诉流程）", "appeals", {
      event: "APPEAL_NOTIFICATION_FAILED",
      action: "APPEAL_DECIDED",
      appealId,
      userId,
      error,
    });
  }
}

import type { EnforcementActionType, Prisma } from "@prisma/client";

import { reinstateAccountTxLocked } from "@/lib/enforcement/account-enforcement-service";
import { reinstateCampusMembershipTxLocked } from "@/lib/enforcement/membership-enforcement-service";
import { setRiskStateTxLocked } from "@/lib/enforcement/risk-service";

/**
 * Phase 6C-1B：Appeal GRANT → canonical restoration 的唯一适配层。
 *
 * 硬合同（Planning 冻结）：
 * - 本模块绝不直接 tx.user.update / tx.campusMembership.update /
 *   tx.riskState.update 执行恢复——一律复用 6C-1A 的 canonical TxLocked
 *   seam（seam 内嵌 self-deny / 授权复核 / privileged target 保护，
 *   canonical 拒绝的 Appeal 同样拒绝，无 appeal-special bypass）；
 * - seam 输入恒为：reasonCode = APPEAL_GRANTED（与 AppealDecisionReasonCode
 *   域分离，禁止 cast）、sourceType = APPEAL、sourceId = appeal.id、
 *   note = null（decisionNote/statement 绝不进入 EnforcementAction.note
 *   与 AdminAudit.detail）；
 * - 本函数只在 appeal review 事务内部（已持 Appeal 行锁 + 完整 sorted
 *   {USER:reviewer, USER:target} subject 锁）调用——seam 自身零取锁。
 */

/** seam 共享输入（note 恒 null：decisionNote 唯一来源是 Appeal.decisionNote）。 */
export const APPEAL_RESTORATIVE_REASON_CODE = "APPEAL_GRANTED" as const;

export type AppealRestorationTarget =
  | { kind: "ACCOUNT" }
  | { kind: "MEMBERSHIP"; campusId: string }
  | { kind: "RISK"; state: "NORMAL" | "WATCH"; campusId: string | null };

/**
 * 从 appealed EnforcementAction 精确解析恢复目标。
 *
 * 返回 null = 溯源不足以安全恢复（调用方按程序性
 * DISMISSED(LEGACY_PROVENANCE_INSUFFICIENT) 处理，禁止猜测）：
 * - previousState 为空 / 编码不可解析；
 * - RISK 恢复目标解析出 RESTRICTED（把限制恢复成限制 = 无意义）；
 * - previousState 编码的 scope 与 appealed.scopeKey 不一致；
 * - MEMBERSHIP 动作缺 campusId 或 scopeKey 编码与 campusId 不一致。
 */
export function resolveRestorationTarget(appealed: {
  type: EnforcementActionType;
  campusId: string | null;
  scopeKey: string;
  previousState: string | null;
}): AppealRestorationTarget | null {
  if (appealed.previousState === null) {
    return null;
  }

  switch (appealed.type) {
    case "ACCOUNT_SUSPEND":
      // canonical reinstate 的恢复目标固定 ACTIVE（seam 状态机决定），无需解析
      return { kind: "ACCOUNT" };
    case "MEMBERSHIP_SUSPEND": {
      // 同一 campus 才能恢复：campusId 缺失或与 scopeKey 编码不一致 = fail closed
      if (
        appealed.campusId === null ||
        appealed.scopeKey !== `CAMPUS:${appealed.campusId}`
      ) {
        return null;
      }
      return { kind: "MEMBERSHIP", campusId: appealed.campusId };
    }
    case "MARKETPLACE_RESTRICT": {
      // 精确解析 previousState 编码（RISK_STATE:<LEVEL>@<scopeKey>），
      // WATCH → RESTRICTED 的申诉必须恢复回 WATCH，绝不硬编码 NORMAL
      const match = /^RISK_STATE:(NORMAL|WATCH|RESTRICTED)@(.+)$/.exec(appealed.previousState);
      if (!match) {
        return null;
      }
      const level = match[1] as "NORMAL" | "WATCH" | "RESTRICTED";
      const scope = match[2] as string;
      if (level === "RESTRICTED" || scope !== appealed.scopeKey) {
        return null;
      }
      if (scope === "GLOBAL") {
        return { kind: "RISK", state: level, campusId: null };
      }
      if (scope.startsWith("CAMPUS:")) {
        return { kind: "RISK", state: level, campusId: scope.slice("CAMPUS:".length) };
      }
      return null;
    }
    default:
      // restorative 类型在 submission 已被拒绝；防御分支 fail closed
      return null;
  }
}

export type AppealRestorationInput = {
  appealId: string;
  reviewerId: string;
  targetUserId: string;
  target: AppealRestorationTarget;
};

/**
 * 执行 canonical restoration。前置条件：调用方已取得 Appeal 行锁 +
 * 完整 sorted {USER:reviewer, USER:target} subject 锁（本函数不取治理锁）。
 * canonical seam 的授权复核失败会原样抛出（整个 review 事务回滚，
 * Appeal 保持非 terminal）——canonical 拒绝的 Appeal 不绕过。
 */
export async function restoreFromAppealTxLocked(
  tx: Prisma.TransactionClient,
  input: AppealRestorationInput,
): Promise<void> {
  const seamInput = {
    actorId: input.reviewerId,
    targetUserId: input.targetUserId,
    reasonCode: APPEAL_RESTORATIVE_REASON_CODE,
    sourceType: "APPEAL",
    sourceId: input.appealId,
    note: null,
  };

  switch (input.target.kind) {
    case "ACCOUNT":
      await reinstateAccountTxLocked(tx, seamInput);
      return;
    case "MEMBERSHIP":
      await reinstateCampusMembershipTxLocked(tx, { ...seamInput, campusId: input.target.campusId });
      return;
    case "RISK":
      await setRiskStateTxLocked(tx, {
        ...seamInput,
        campusId: input.target.campusId,
        state: input.target.state,
      });
      return;
  }
}

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
 * 自动恢复资格要求 previousState 不但非空、还必须**完整解析为该动作族的
 * 唯一合法 pre-state 形状**（Repair 1 Blocker A：fail closed）：
 * - ACCOUNT_SUSPEND：campusId=null + scopeKey=GLOBAL + previousState=USER:ACTIVE；
 * - MEMBERSHIP_SUSPEND：campusId 非空 + scopeKey=CAMPUS:<campusId> +
 *   previousState=CAMPUS_MEMBERSHIP:ACTIVE；
 * - MARKETPLACE_RESTRICT：RISK_STATE:NORMAL|WATCH@<scope>，且 scope 与
 *   campusId/scopeKey 双向一致（GLOBAL ↔ campusId=null@GLOBAL；
 *   CAMPUS:<id> ↔ campusId=<id>@CAMPUS:<id>）。
 *
 * 返回 null = 溯源不足以安全恢复（调用方按程序性
 * DISMISSED(LEGACY_PROVENANCE_INSUFFICIENT) 处理，禁止猜测）：
 * previousState 为空 / 值不属于该族的合法 pre-state / 编码不可解析 /
 * campusId 与 scopeKey 不一致 / RISK 恢复目标为 RESTRICTED。
 * canonical 产生方只会写出合法形状；任何偏离都意味着数据损坏或
 * 非 canonical 写入——绝不猜恢复目标。
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
    case "ACCOUNT_SUSPEND": {
      if (appealed.campusId !== null || appealed.scopeKey !== "GLOBAL") {
        return null;
      }
      if (appealed.previousState !== "USER:ACTIVE") {
        return null;
      }
      return { kind: "ACCOUNT" };
    }
    case "MEMBERSHIP_SUSPEND": {
      if (appealed.campusId === null) {
        return null;
      }
      if (appealed.scopeKey !== `CAMPUS:${appealed.campusId}`) {
        return null;
      }
      if (appealed.previousState !== "CAMPUS_MEMBERSHIP:ACTIVE") {
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
      if (level === "RESTRICTED") {
        return null;
      }
      if (scope === "GLOBAL") {
        if (appealed.campusId !== null || appealed.scopeKey !== "GLOBAL") {
          return null;
        }
        return { kind: "RISK", state: level, campusId: null };
      }
      if (scope.startsWith("CAMPUS:")) {
        const campusId = scope.slice("CAMPUS:".length);
        if (
          appealed.campusId === null ||
          appealed.scopeKey !== `CAMPUS:${appealed.campusId}` ||
          campusId !== appealed.campusId
        ) {
          return null;
        }
        return { kind: "RISK", state: level, campusId };
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

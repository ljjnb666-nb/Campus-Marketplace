import type { Prisma } from "@prisma/client";

import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { REPORT_REVIEW_PERMISSION } from "@/lib/reports/report-access";
import { reportCaseError } from "@/lib/reports/errors";
import { resolveReportReviewScope } from "@/lib/reports/report-scope";
import { withTransaction } from "@/lib/prisma";
import { rbacError } from "@/lib/rbac/errors";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";

/**
 * Phase 7E：case claim/release canonical 服务（v1：仅 self claim/release，
 * 无任意 assign-other UI）。
 *
 * 冻结合同：
 * - 锁序（与 applyReportReviewTx 同一全序，禁止反序）：
 *     USER:actor subject lock（序列化 role revoke / 账号停用/注销 /
 *     membership 停用 vs 治理写，7C R2-01 同源）
 *   → REPORT 行 FOR UPDATE
 *   → MODERATION_CASE 行 FOR UPDATE（claim/review 全部在 case 行上串行）
 *   → 授权重读（loadAuthorizationContext + report.review exact-campus，
 *     UNSCOPED 仅 GLOBAL——requirePermissionInContext(campusId=null) 天然
 *     拒绝一切 CAMPUS grant）
 *   → 状态判定 → 写 assignedToId / lastActivityAt。
 * - claim：未领用 → assignedToId=actor；已是自己 → 幂等 no-op；
 *   已被他人领用 → REPORT_CASE_ALREADY_CLAIMED fail closed（恰好一个
 *   canonical winner 由 case 行锁保证）。
 * - release：本人领用 → assignedToId=null；未领用 → 幂等 no-op；
 *   他人领用 → REPORT_CASE_FORBIDDEN fail closed（CL03）。
 * - case 已关闭（closedAt 非 null）→ 不可 claim/release（REPORT_CASE_CLOSED）。
 * - malformed scope pair → fail closed（DB CHECK 下结构不可能，纵深防御）。
 */

export type ModerationCaseRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

export type ClaimModerationCaseInput = {
  actorId: string;
  /** 队列/详情面向调用方暴露的是 reportId；case 由 reportId 唯一定位 */
  reportId: string;
  racePoint?: ModerationCaseRacePoint;
};

export type ClaimModerationCaseResult = {
  caseId: string;
  assignedToId: string | null;
  outcome: "CLAIMED" | "ALREADY_YOURS" | "RELEASED" | "ALREADY_RELEASED";
};

type LockedCaseRow = {
  id: string;
  campusId: string | null;
  scopeKey: string;
  assignedToId: string | null;
  closedAt: Date | null;
};

/**
 * 冻结锁序的共享前段：USER subject lock → REPORT 行锁 → CASE 行锁 →
 * racePoint → 授权重读（exact scope）。返回锁内 case 现势。
 */
async function withCaseAuthority(
  tx: Prisma.TransactionClient,
  input: ClaimModerationCaseInput,
): Promise<LockedCaseRow> {
  // 1. actor 序列化（role revoke / 账号停用/注销 / membership 停用 同锁）
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
  ]);

  // 2. REPORT 行锁（全仓 canonical 锁序：report 先于 case）
  const reportRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM "Report"
    WHERE id = ${input.reportId}
    FOR UPDATE`;
  if (!reportRows[0]) {
    // 反 oracle：missing 与越权统一安全文案（action 层不区分）
    throw reportCaseError("REPORT_CASE_NOT_FOUND");
  }

  // 3. MODERATION_CASE 行锁（claim 与 review 在同一 case 行上串行）
  const caseRows = await tx.$queryRaw<
    { id: string; campusId: string | null; scopeKey: string; assignedToId: string | null; closedAt: Date | null }[]
  >`
    SELECT id, "campusId", "scopeKey", "assignedToId", "closedAt"
    FROM "ModerationCase"
    WHERE "reportId" = ${input.reportId}
    FOR UPDATE`;
  const lockedCase = caseRows[0];
  if (!lockedCase) {
    throw reportCaseError("REPORT_CASE_NOT_FOUND");
  }

  // 4. 测试 seam（CL01/CL04 waiter 注入点；生产路径不传）
  if (input.racePoint) {
    await input.racePoint(tx);
  }

  // 5. AFTER locks：授权重读（must await——吞错即 fail-open，7C 同注）
  const scope = resolveReportReviewScope({
    campusId: lockedCase.campusId,
    scopeKey: lockedCase.scopeKey,
  });
  // UNSCOPED → campusId=null → requirePermissionInContext 仅放行 GLOBAL grant
  const targetCampusId = scope?.kind === "CAMPUS" ? scope.campusId : null;
  if (scope === null) {
    // malformed cross pair：fail closed（结构上不可达，纵深防御）
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  const context = await loadAuthorizationContext(input.actorId, tx);
  if (!context || !context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  await requirePermissionInContext(context, REPORT_REVIEW_PERMISSION, targetCampusId);

  return lockedCase;
}

/** case 领用（self claim）。并发竞争：case 行锁下恰好一个 canonical winner。 */
export async function claimModerationCase(
  input: ClaimModerationCaseInput,
): Promise<ClaimModerationCaseResult> {
  return withTransaction(async (tx) => {
    const lockedCase = await withCaseAuthority(tx, input);

    if (lockedCase.closedAt !== null) {
      throw reportCaseError("REPORT_CASE_CLOSED");
    }
    if (lockedCase.assignedToId === input.actorId) {
      return {
        caseId: lockedCase.id,
        assignedToId: lockedCase.assignedToId,
        outcome: "ALREADY_YOURS",
      };
    }
    if (lockedCase.assignedToId !== null) {
      throw reportCaseError("REPORT_CASE_ALREADY_CLAIMED");
    }

    await tx.moderationCase.update({
      where: { id: lockedCase.id },
      data: { assignedToId: input.actorId, lastActivityAt: new Date() },
      select: { id: true },
    });

    return { caseId: lockedCase.id, assignedToId: input.actorId, outcome: "CLAIMED" };
  });
}

/** case 释放（self release）。非领用人释放 fail closed（CL03）。 */
export async function releaseModerationCase(
  input: ClaimModerationCaseInput,
): Promise<ClaimModerationCaseResult> {
  return withTransaction(async (tx) => {
    const lockedCase = await withCaseAuthority(tx, input);

    if (lockedCase.closedAt !== null) {
      throw reportCaseError("REPORT_CASE_CLOSED");
    }
    if (lockedCase.assignedToId === null) {
      return {
        caseId: lockedCase.id,
        assignedToId: null,
        outcome: "ALREADY_RELEASED",
      };
    }
    if (lockedCase.assignedToId !== input.actorId) {
      throw reportCaseError("REPORT_CASE_FORBIDDEN");
    }

    await tx.moderationCase.update({
      where: { id: lockedCase.id },
      data: { assignedToId: null, lastActivityAt: new Date() },
      select: { id: true },
    });

    return { caseId: lockedCase.id, assignedToId: null, outcome: "RELEASED" };
  });
}

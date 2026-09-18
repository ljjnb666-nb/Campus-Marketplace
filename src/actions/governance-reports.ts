"use server";

import { revalidatePath } from "next/cache";

import { isReportCaseError } from "@/lib/reports/errors";
import { claimModerationCase, releaseModerationCase } from "@/lib/reports/moderation-case-service";
import { deriveReportReviewAccess } from "@/lib/reports/report-access";
import { reviewReportInGovernance } from "@/lib/reports/report-review-service";
import { actionErrorMessage } from "@/lib/error-handler";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  governanceReportCaseSchema,
  governanceReportReviewSchema,
} from "@/validators/governance-report";

/**
 * Phase 7E：举报运营治理面的薄 Server Action 适配层（7A 同款冻结约定）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()（session → DB ACTIVE 复查 → consent），
 *   绝不信 FormData/query/client props 的任何身份字段；
 * - 仅做：validate → 服务端身份 → 有效 access fail-fast → canonical 域服务
 *   （claim/release/review 自己拥有全部锁/锁后授权重读/状态机/审计/通知）→
 *   revalidate。零域逻辑复制；
 * - 授权结构不可暴露：missing/越权统一文案（canonical error machine code
 *   仅在服务端内部判别）；领用冲突/case 已关闭等域状态保留域内安全文案。
 */

export type GovernanceReportActionState = {
  success: boolean;
  outcome?: "CLAIMED" | "ALREADY_YOURS" | "RELEASED" | "ALREADY_RELEASED";
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限处理该举报";

function uniformDeny(): GovernanceReportActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

function governanceReportActionError(
  error: unknown,
  context: string,
): GovernanceReportActionState {
  if (isReportCaseError(error)) {
    // deny 家族统一文案（missing/越权不可区分，反 oracle）；
    // 领用冲突 / case 已关闭保留域内用户安全文案。
    if (
      error.code === "REPORT_CASE_NOT_FOUND" ||
      error.code === "REPORT_CASE_FORBIDDEN"
    ) {
      return uniformDeny();
    }
    return { success: false, error: error.message };
  }
  if (error instanceof Error && error.message.startsWith("REPORT_STATUS_INVALID_TRANSITION:")) {
    return { success: false, error: "举报当前状态不允许此操作" };
  }
  if (error instanceof Error && error.message.startsWith("REPORT_NOT_FOUND:")) {
    return uniformDeny();
  }
  return { success: false, error: actionErrorMessage(error, context) };
}

async function loadOperatorAccess() {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveReportReviewAccess(context);
  return { user, access };
}

/** case 领用（self claim；并发由 case 行锁串行，恰好一个 canonical winner）。 */
export async function claimGovernanceReportCase(
  formData: FormData,
): Promise<GovernanceReportActionState> {
  try {
    const parsed = governanceReportCaseSchema.safeParse({
      reportId: formData.get("reportId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    const result = await claimModerationCase({
      actorId: user.id,
      reportId: parsed.data.reportId,
    });

    revalidatePath("/governance/reports");
    revalidatePath(`/governance/reports/${parsed.data.reportId}`);
    return { success: true, outcome: result.outcome };
  } catch (error) {
    return governanceReportActionError(error, "claimGovernanceReportCase");
  }
}

/** case 释放（self release；非领用人释放由域 fail closed）。 */
export async function releaseGovernanceReportCase(
  formData: FormData,
): Promise<GovernanceReportActionState> {
  try {
    const parsed = governanceReportCaseSchema.safeParse({
      reportId: formData.get("reportId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    const result = await releaseModerationCase({
      actorId: user.id,
      reportId: parsed.data.reportId,
    });

    revalidatePath("/governance/reports");
    revalidatePath(`/governance/reports/${parsed.data.reportId}`);
    return { success: true, outcome: result.outcome };
  } catch (error) {
    return governanceReportActionError(error, "releaseGovernanceReportCase");
  }
}

/** canonical 审核（IN_REVIEW / RESOLVED / REJECTED；流转合法性由域锁内断言）。 */
export async function reviewGovernanceReport(
  formData: FormData,
): Promise<GovernanceReportActionState> {
  try {
    const noteRaw = formData.get("handledNote");
    const parsed = governanceReportReviewSchema.safeParse({
      reportId: formData.get("reportId"),
      status: formData.get("status"),
      handledNote: typeof noteRaw === "string" ? noteRaw : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    await reviewReportInGovernance({
      actorId: user.id,
      reportId: parsed.data.reportId,
      status: parsed.data.status,
      handledNote: parsed.data.handledNote || null,
    });

    revalidatePath("/governance/reports");
    revalidatePath(`/governance/reports/${parsed.data.reportId}`);
    revalidatePath("/notifications");
    return { success: true };
  } catch (error) {
    return governanceReportActionError(error, "reviewGovernanceReport");
  }
}

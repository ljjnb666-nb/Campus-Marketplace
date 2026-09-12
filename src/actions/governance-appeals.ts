"use server";

import { revalidatePath } from "next/cache";

import { beginAppealReview, decideAppeal } from "@/lib/appeals/appeal-review-service";
import { isAppealError } from "@/lib/appeals/errors";
import { deriveAppealReviewAccess } from "@/lib/appeals/reviewer-access";
import { actionErrorMessage } from "@/lib/error-handler";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  governanceAppealBeginSchema,
  governanceAppealDecisionSchema,
} from "@/validators/governance-appeal";

/**
 * Phase 7A：申诉审核治理面的薄 Server Action 适配层（Planning §26 冻结）。
 *
 * 硬合同：
 * - reviewerId 一律来自 requireUser()（session → DB ACTIVE 复查 → consent），
 *   绝不信 FormData/query/client props 的任何身份字段；
 * - 仅做：validate → 服务端身份 → 有效 access fail-fast → canonical 域服务
 *   （beginAppealReview / decideAppeal 自己拥有全部锁/锁后授权重读/状态机/
 *   恢复/审计/通知）→ revalidate 治理路由。零域逻辑复制；
 * - 授权结构不可暴露（§29）：missing/malformed/越权/appellant-self 统一文案，
 *   canonical AppealError machine code 仅在服务端内部判别；
 * - 程序性 DISMISSED 是 decideAppeal 的成功 committed 结局，原样回传 outcome
 *   （§28），绝不作为异常；
 * - 零第二份 AdminAudit/Notification/日志写入（§31）；decisionNote 永不进
 *   日志/审计/通知（域已结构性隔离，本层不接触）。
 */

export type GovernanceAppealActionState = {
  success: boolean;
  /** 成功提交的 workflow 结局（UPHELD/GRANTED 为人工输入；DISMISSED 为域计算） */
  outcome?: "GRANTED" | "UPHELD" | "DISMISSED";
  reasonCode?: string | null;
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限审核该申诉";

function uniformDeny(): GovernanceAppealActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

function governanceActionError(error: unknown, context: string): GovernanceAppealActionState {
  if (isAppealError(error)) {
    // deny 家族统一文案（missing/越权/appellant-self 不可区分，GOV-02/A-02）；
    // INVALID_TRANSITION（UI 过期/双决定败者）等保留域内用户安全文案。
    if (
      error.code === "APPEAL_NOT_FOUND" ||
      error.code === "APPEAL_NOT_OWNED" ||
      error.code === "APPEAL_SCOPE_MISMATCH" ||
      error.code === "APPEAL_REVIEW_FORBIDDEN" ||
      error.code === "APPEAL_REVIEWER_IS_APPELLANT"
    ) {
      return uniformDeny();
    }
    return { success: false, error: error.message };
  }
  return { success: false, error: actionErrorMessage(error, context) };
}

async function loadOperatorAccess() {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveAppealReviewAccess(context);
  return { user, access };
}

/** SUBMITTED → IN_REVIEW（workflow-only；不建立 ownership，任一授权审核员可终局）。 */
export async function beginGovernanceAppealReview(
  formData: FormData,
): Promise<GovernanceAppealActionState> {
  try {
    const parsed = governanceAppealBeginSchema.safeParse({
      appealId: formData.get("appealId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    await beginAppealReview({
      reviewerId: user.id,
      appealId: parsed.data.appealId,
    });

    revalidatePath("/governance/appeals");
    revalidatePath(`/governance/appeals/${parsed.data.appealId}`);
    return { success: true };
  } catch (error) {
    return governanceActionError(error, "beginGovernanceAppealReview");
  }
}

/**
 * 终局决定（人工输入仅 GRANTED | UPHELD）。canonical 域服务可能把
 * GRANTED 请求收敛为程序性 DISMISSED（stale/reversed/provenance/erased）——
 * 这是成功结局，outcome 原样回传给 UI 呈现。
 */
export async function decideGovernanceAppeal(
  formData: FormData,
): Promise<GovernanceAppealActionState> {
  try {
    const noteRaw = formData.get("decisionNote");
    const parsed = governanceAppealDecisionSchema.safeParse({
      appealId: formData.get("appealId"),
      decision: formData.get("decision"),
      decisionNote: typeof noteRaw === "string" && noteRaw.length > 0 ? noteRaw : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    const result = await decideAppeal({
      reviewerId: user.id,
      appealId: parsed.data.appealId,
      decision: parsed.data.decision,
      decisionNote: parsed.data.decisionNote ?? null,
    });

    revalidatePath("/governance/appeals");
    revalidatePath(`/governance/appeals/${parsed.data.appealId}`);
    return { success: true, outcome: result.outcome, reasonCode: result.reasonCode };
  } catch (error) {
    return governanceActionError(error, "decideGovernanceAppeal");
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { isRbacError } from "@/lib/rbac/errors";
import { logger } from "@/lib/logger";
import { getVerifiedSession } from "@/lib/server-auth";
import { recordReconsentAcceptances } from "@/lib/legal/policy-service";

export type LegalAcceptanceState = {
  success: boolean;
  message: string;
  /** 版本冲突等需要重新拉取当前 required 集合时为 true */
  requiresReload?: boolean;
};

/**
 * 重新同意当前 required 政策集合（consent gate 的解除入口）。
 *
 * 身份校验：getVerifiedSession（requireConsent=false——re-consent 本身
 * 不能被 consent gate 阻断）只是 entry identity check，不是 mutation
 * authority。RB-03 REVIEW FIX：最终写权威 = recordReconsentAcceptances
 * （USER 治理锁 → 锁内 fresh ACTIVE 复核 → POLICY 锁 → 校验/写入），
 * 注销/停用账号的残留旧 JWT 或 entry 后竞态失效均无法提交同意。
 *
 * fail-closed：提交的集合与服务器解析的当前 required 集合不一致
 * （例如页面打开期间发布了新版本）时拒绝并要求重新加载。
 */
export async function acceptRequiredPolicies(
  _prevState: LegalAcceptanceState,
  formData: FormData,
): Promise<LegalAcceptanceState> {
  const verified = await getVerifiedSession({ requireConsent: false });

  if (!verified.ok) {
    return { success: false, message: "请先登录" };
  }

  // 显式勾选动作必须存在（防"无感知同意"）
  if (formData.get("agreeLegal") !== "on") {
    return { success: false, message: "请先勾选同意后再提交" };
  }

  const documentIds = formData
    .getAll("acceptedDocumentIds")
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);

  try {
    await recordReconsentAcceptances({
      userId: verified.user.id,
      documentIds,
    });
  } catch (error) {
    // RB-03 race-loss：entry 时 ACTIVE 但 USER 锁内 fresh 复核前
    // erase/suspend 先提交 → 与入口失效完全同形，不区分
    // erased/deleted/suspended/race-lost
    if (isRbacError(error) && error.code === "AUTH_ACCOUNT_INACTIVE") {
      return { success: false, message: "请先登录" };
    }

    if (isGovernanceError(error)) {
      return {
        success: false,
        message: error.message,
        requiresReload:
          error.code === "LEGAL_DOCUMENT_VERSION_CHANGED" ||
          error.code === "LEGAL_DOCUMENT_NOT_CURRENT" ||
          error.code === "LEGAL_DOCUMENT_NOT_FOUND",
      };
    }

    return { success: false, message: "提交失败，请稍后重试" };
  }

  logger.info("policy_acceptance_created", "legal", {
    userId: verified.user.id,
    source: "RECONSENT",
    documentCount: documentIds.length,
  });

  revalidatePath("/", "layout");

  return { success: true, message: "已同意最新协议" };
}

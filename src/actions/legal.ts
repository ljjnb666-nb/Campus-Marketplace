"use server";

import { revalidatePath } from "next/cache";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { logger } from "@/lib/logger";
import { recordAcceptances } from "@/lib/legal/policy-service";
import { auth } from "@/lib/auth";

export type LegalAcceptanceState = {
  success: boolean;
  message: string;
  /** 版本冲突等需要重新拉取当前 required 集合时为 true */
  requiresReload?: boolean;
};

/**
 * 重新同意当前 required 政策集合（consent gate 的解除入口）。
 *
 * fail-closed：提交的集合与服务器解析的当前 required 集合不一致
 * （例如页面打开期间发布了新版本）时拒绝并要求重新加载。
 */
export async function acceptRequiredPolicies(
  _prevState: LegalAcceptanceState,
  formData: FormData,
): Promise<LegalAcceptanceState> {
  const session = await auth();

  if (!session?.user?.id) {
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
    await recordAcceptances({
      userId: session.user.id,
      documentIds,
      source: "RECONSENT",
    });
  } catch (error) {
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
    userId: session.user.id,
    source: "RECONSENT",
    documentCount: documentIds.length,
  });

  revalidatePath("/", "layout");

  return { success: true, message: "已同意最新协议" };
}

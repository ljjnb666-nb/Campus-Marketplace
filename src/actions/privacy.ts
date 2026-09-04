"use server";

import { revalidatePath } from "next/cache";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { logger } from "@/lib/logger";
import { auth } from "@/lib/auth";
import {
  cancelOwnPendingRequest,
  createAccountDeletionRequest,
  createDataExportRequest,
  describeBlockedReason,
} from "@/lib/privacy/privacy-request-service";
import { isRateLimited } from "@/lib/rate-limit";

export type PrivacyActionState = {
  success: boolean;
  message: string;
  /** 注销成功后前端需要登出并跳转 */
  signedOut?: boolean;
};

/** 注销确认短语：显式 typed confirmation（destructive action） */
const DELETION_CONFIRMATION_PHRASE = "注销账号";

const DELETION_RATE_LIMIT = 3;
const DELETION_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * 申请注销账号（隐私自助操作，不受 consent gate 限制——退出权优先）。
 * 同步执行：成功即匿名化完成；被 hold/交易阻断时请求置 BLOCKED。
 */
export async function requestAccountDeletion(
  _prevState: PrivacyActionState,
  formData: FormData,
): Promise<PrivacyActionState> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, message: "请先登录" };
  }

  const confirmation = String(formData.get("confirmation") ?? "").trim();

  if (confirmation !== DELETION_CONFIRMATION_PHRASE) {
    return { success: false, message: `请输入“${DELETION_CONFIRMATION_PHRASE}”以确认` };
  }

  const { limited } = await isRateLimited({
    key: `privacy-deletion:${session.user.id}`,
    limit: DELETION_RATE_LIMIT,
    windowMs: DELETION_RATE_LIMIT_WINDOW_MS,
  });

  if (limited) {
    return { success: false, message: "操作过于频繁，请稍后再试" };
  }

  try {
    const outcome = await createAccountDeletionRequest(session.user.id);

    if (outcome.status === "COMPLETED") {
      // 注意：成功路径不做 revalidatePath —— 此时账号已注销，任何服务端
      // 重渲染都会被 requireVerifiedPageUser 重定向到 /login，与前端
      // "先展示成功消息、再 signOut"的流程竞争。登出由客户端完成。
      return {
        success: true,
        message: "账号已注销。你的个人身份信息已被匿名化，历史交易记录以匿名形式保留。",
        signedOut: true,
      };
    }

    revalidatePath("/my/privacy");

    return {
      success: false,
      message: describeBlockedReason(outcome.reasonCode),
    };
  } catch (error) {
    if (isGovernanceError(error)) {
      return { success: false, message: error.message };
    }

    logger.error("账号注销请求失败", "requestAccountDeletion", { error });
    return { success: false, message: "操作失败，请稍后重试" };
  }
}

/** 记录一次数据导出请求（导出内容本身由 GET /api/privacy/export 提供）。 */
export async function recordDataExportRequest(): Promise<PrivacyActionState> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, message: "请先登录" };
  }

  const { limited } = await isRateLimited({
    key: `privacy-export:${session.user.id}`,
    limit: 5,
    windowMs: 15 * 60 * 1000,
  });

  if (limited) {
    return { success: false, message: "导出过于频繁，请稍后再试" };
  }

  try {
    await createDataExportRequest(session.user.id);
    revalidatePath("/my/privacy");

    return { success: true, message: "已记录本次导出请求" };
  } catch (error) {
    logger.error("记录导出请求失败", "recordDataExportRequest", { error });
    return { success: false, message: "操作失败，请稍后重试" };
  }
}

/** 取消本人尚未执行的注销请求。 */
export async function cancelPrivacyRequest(
  _prevState: PrivacyActionState,
  formData: FormData,
): Promise<PrivacyActionState> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, message: "请先登录" };
  }

  const requestId = String(formData.get("requestId") ?? "").trim();

  if (!requestId) {
    return { success: false, message: "参数缺失" };
  }

  try {
    await cancelOwnPendingRequest(session.user.id, requestId);
    revalidatePath("/my/privacy");

    return { success: true, message: "已取消该请求" };
  } catch (error) {
    if (isGovernanceError(error)) {
      return { success: false, message: error.message };
    }

    return { success: false, message: "操作失败，请稍后重试" };
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedPageUser } from "@/lib/server-auth";
import { changeOwnPassword, revokeOwnSessions } from "@/lib/account-session-service";

export type AccountSecurityActionState = { success: boolean; message: string; signedOut?: boolean };

export async function changePasswordAction(_state: AccountSecurityActionState, form: FormData): Promise<AccountSecurityActionState> {
  const user = await requireVerifiedPageUser();
  if (!user.sessionId) return { success: false, message: "请重新登录" };
  const next = String(form.get("newPassword") ?? "");
  if (next !== form.get("confirmPassword")) return { success: false, message: "两次输入的新密码不一致" };
  try {
    await changeOwnPassword(user.id, user.sessionId, String(form.get("currentPassword") ?? ""), next);
    return { success: true, message: "密码已修改，所有设备已退出，请使用新密码登录。", signedOut: true };
  } catch (error) {
    const messages = ["当前密码不正确", "新密码不能与当前密码相同", "尝试过于频繁，请稍后重试", "请重新登录后操作", "凭据已变化，请重新登录"];
    return { success: false, message: error instanceof Error && messages.includes(error.message)
      ? error.message : "修改失败，请检查密码格式或稍后重试。" };
  }
}

export async function revokeSessionsAction(_state: AccountSecurityActionState, form: FormData): Promise<AccountSecurityActionState> {
  const user = await requireVerifiedPageUser();
  if (!user.sessionId) return { success: false, message: "请重新登录" };
  const mode = form.get("mode");
  if (mode !== "ONE" && mode !== "OTHERS" && mode !== "ALL") return { success: false, message: "请选择要退出的设备" };
  const target = String(form.get("sessionId") ?? "");
  try {
    await revokeOwnSessions(user.id, user.sessionId, mode, target);
    revalidatePath("/my/security");
    return { success: true, message: "所选登录会话已撤销。", signedOut: mode === "ALL" || mode === "ONE" && target === user.sessionId };
  } catch {
    return { success: false, message: "操作失败，请重新登录后重试。" };
  }
}

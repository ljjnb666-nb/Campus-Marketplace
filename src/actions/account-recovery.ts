"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireVerifiedPageUser } from "@/lib/server-auth";
import { resolveAuthClientSource } from "@/lib/login-rate-limit";
import { requestAccountChallenge, completeAccountChallenge } from "@/lib/account-challenge-service";
import { beginMfaSetup, confirmMfa } from "@/lib/account-mfa-service";

export type RecoveryState = { success: boolean; message: string; setupSecret?: string };
const generic = "如果账号符合条件，邮件将在稍后送达。请检查收件箱及垃圾邮件；已有邮件链接在 15 分钟内仍有效。";
async function source() { return resolveAuthClientSource(Object.fromEntries(await headers())); }

export async function requestPasswordResetAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  try { await requestAccountChallenge(String(form.get("email") ?? "").trim(), "RESET_PASSWORD", await source()); }
  catch {
    // The write/email path is only reached for existing accounts. Returning a
    // distinct failure here would make transient provider/DB errors an account
    // enumeration oracle. Keep the external outcome identical for absent,
    // rate-limited, successful and failed-to-enqueue addresses. Operations
    // must detect provider failures through monitoring, not this public form.
  }
  return { success: true, message: generic };
}
export async function requestEmailVerificationAction(): Promise<RecoveryState> {
  const user = await requireVerifiedPageUser();
  try { await requestAccountChallenge(user.email, "VERIFY_EMAIL", await source()); }
  catch { return { success: false, message: "服务暂时不可用，请稍后再试。" }; }
  return { success: true, message: generic };
}
export async function completeChallengeAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  const purpose = form.get("purpose");
  if (purpose !== "VERIFY_EMAIL" && purpose !== "RESET_PASSWORD") return { success: false, message: "链接无效，请重新申请。" };
  if (purpose === "RESET_PASSWORD" && form.get("newPassword") !== form.get("confirmPassword")) return { success: false, message: "两次输入的新密码不一致。" };
  try {
    await completeAccountChallenge({ id: String(form.get("id") ?? ""), token: String(form.get("token") ?? ""), purpose,
      newPassword: String(form.get("newPassword") ?? ""), mfaCode: String(form.get("mfaCode") ?? "") }, await source());
    revalidatePath("/my/security");
    return { success: true, message: purpose === "VERIFY_EMAIL" ? "邮箱已验证，可以返回继续使用。" : "密码已重置，所有设备已退出，请重新登录。" };
  } catch { return { success: false, message: "操作失败：链接可能已使用或过期，请检查新密码格式和动态验证码，或重新申请。" }; }
}
export async function beginMfaAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  const user = await requireVerifiedPageUser();
  try {
    if (!user.sessionId) throw new Error();
    const setupSecret = await beginMfaSetup(user.id, user.sessionId, String(form.get("password") ?? ""));
    return { success: true, message: "在验证器中手动添加此密钥，然后输入动态验证码完成绑定。密钥仅供你本人使用，10 分钟内完成。", setupSecret };
  } catch { return { success: false, message: "无法开始绑定，请先验证邮箱并确认当前密码正确。" }; }
}
export async function confirmMfaAction(_state: RecoveryState, form: FormData): Promise<RecoveryState> {
  const user = await requireVerifiedPageUser();
  const mode = form.get("mode");
  try {
    if (!user.sessionId || (mode !== "ENABLE" && mode !== "STEP_UP" && mode !== "DISABLE")) throw new Error();
    await confirmMfa(user.id, user.sessionId, String(form.get("code") ?? ""), mode);
    revalidatePath("/my/security");
    return { success: true, message: mode === "DISABLE" ? "双重验证已关闭，其他设备已退出。管理操作需重新启用。" : "验证成功。请等待验证码更新后再用于下一次操作。" };
  } catch { return { success: false, message: "验证码无效、已使用或操作过于频繁。请等待新验证码后重试。" }; }
}

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getUserAcceptanceStatus } from "@/lib/legal/policy-service";

/**
 * 中央 active-account resolver（Phase 5 REPAIR）。
 *
 * Auth.js 策略为 JWT（maxAge 7 天）：auth() 只解析令牌，不感知注销/停用。
 * 账号被注销（erasedAt）或停用后，注销前签发的 JWT 仍然"可解析"——因此
 * 每一个 authenticated 边界（页面、Server Action、API route）都必须经过
 * 本 resolver 对照数据库最新状态，旧 JWT 不能继续驱动任何身份操作。
 *
 * 合同（永远不可跳过）：
 *   1. 解析 auth session
 *   2. DB re-fetch User
 *   3. 要求 status == ACTIVE && deletedAt == null && erasedAt == null
 *   4. consent 是否要求由调用方决定（re-consent / 隐私自助允许 requireConsent=false，
 *      但第 3 步的账号 active 校验任何路径都不可跳过）
 */

/** DB 最新状态校验 + 会话合并。非 active 返回 null（不区分原因，避免向客户端泄漏状态）。 */
async function loadActiveUser(sessionUserId: string) {
  return prisma.user.findUnique({
    where: { id: sessionUserId },
    select: {
      id: true,
      role: true,
      email: true,
      name: true,
      avatarUrl: true,
      verificationStatus: true,
      status: true,
      deletedAt: true,
      erasedAt: true,
    },
  });
}

function isActiveUser(user: {
  status: string;
  deletedAt: Date | null;
  erasedAt: Date | null;
}): boolean {
  return user.status === "ACTIVE" && user.deletedAt === null && user.erasedAt === null;
}

/** 页面/Server Action 的统一身份入口（中央卡点）。 */
export async function requireUser() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const dbUser = await loadActiveUser(session.user.id);

  if (!dbUser || !isActiveUser(dbUser)) {
    // 账号被停用/删除/注销后立即失效旧会话（含旧 JWT）
    redirect("/login");
  }

  const acceptance = await getUserAcceptanceStatus(dbUser.id);

  if (!acceptance.compliant) {
    redirect("/legal/accept");
  }

  return {
    ...session.user,
    ...dbUser,
  };
}

export async function requireAdmin() {
  const user = await requireUser();

  if (user.role !== "ADMIN") {
    redirect("/");
  }

  return user;
}

/**
 * 页面级身份校验（不含 consent gate）。
 *
 * 专用于隐私自助页面（/my/privacy）：数据导出与账号注销是用户的
 * 基本权利，不得以"未同意新版协议"为由阻断（同意门不能堵死退出权）。
 * 其余业务页面一律使用 requireUser()。
 */
export async function requireVerifiedPageUser() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const dbUser = await loadActiveUser(session.user.id);

  if (!dbUser || !isActiveUser(dbUser)) {
    redirect("/login");
  }

  return {
    ...session.user,
    ...dbUser,
  };
}

export type VerifiedSessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: "STUDENT" | "ADMIN";
};

export type VerifiedSession =
  | { ok: true; user: VerifiedSessionUser }
  | { ok: false; reason: "UNAUTHENTICATED" | "ACCOUNT_INACTIVE" | "LEGAL_ACCEPTANCE_REQUIRED" };

/**
 * Server Action / API Route 的会话校验（带数据库复核 + 可选 consent gate）。
 *
 * 与 requireUser 的差异：action/route handler 中不能 throw redirect，
 * 这里返回可判别联合，由调用方映射为 401/403 JSON。
 *
 * @param requireConsent true 用于业务 mutation：required 政策未满足时
 *        返回 LEGAL_ACCEPTANCE_REQUIRED（403）。隐私自助与 re-consent
 *        入口传 false——但账号 active 校验（第 3 步）永远执行。
 */
export async function getVerifiedSession(
  options: { requireConsent?: boolean } = {},
): Promise<VerifiedSession> {
  const session = await auth();

  if (!session?.user?.id) {
    return { ok: false, reason: "UNAUTHENTICATED" };
  }

  const dbUser = await loadActiveUser(session.user.id);

  if (!dbUser || !isActiveUser(dbUser)) {
    return { ok: false, reason: "ACCOUNT_INACTIVE" };
  }

  if (options.requireConsent) {
    const acceptance = await getUserAcceptanceStatus(dbUser.id);

    if (!acceptance.compliant) {
      return { ok: false, reason: "LEGAL_ACCEPTANCE_REQUIRED" };
    }
  }

  return {
    ok: true,
    user: {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      role: dbUser.role,
    },
  };
}

export const VERIFIED_SESSION_HTTP_STATUS: Record<
  Exclude<VerifiedSession, { ok: true }>["reason"],
  number
> = {
  UNAUTHENTICATED: 401,
  ACCOUNT_INACTIVE: 401,
  LEGAL_ACCEPTANCE_REQUIRED: 403,
};

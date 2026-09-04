import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getUserAcceptanceStatus } from "@/lib/legal/policy-service";

/**
 * 页面/Server Action 的统一身份入口（中央卡点）。
 *
 * 每次请求都对照数据库最新状态：
 * 1. 账号被停用/删除/注销（erasedAt）→ 立即失效旧会话（跳登录页）
 * 2. required 政策未满足（缺失或过期）→ 跳转 /legal/accept 重新同意。
 *    这是 consent gate 的服务端强制点：所有业务 mutation 都经由
 *    requireUser/requireAdmin 进入，无法通过直接调用绕过。
 */
export async function requireUser() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
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

  if (!dbUser || dbUser.status !== "ACTIVE" || dbUser.deletedAt || dbUser.erasedAt) {
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

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
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

  if (!dbUser || dbUser.status !== "ACTIVE" || dbUser.deletedAt || dbUser.erasedAt) {
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
 * API Route 的会话校验（带数据库复核 + 可选 consent gate）。
 *
 * 与 requireUser 的差异：route handler 中不能 throw redirect，
 * 这里返回可判别联合，由调用方映射为 401/403 JSON。
 *
 * @param requireConsent true 用于业务 mutation：required 政策未满足时
 *        返回 LEGAL_ACCEPTANCE_REQUIRED（403）。公开读接口传 false。
 */
export async function getVerifiedSession(
  options: { requireConsent?: boolean } = {},
): Promise<VerifiedSession> {
  const session = await auth();

  if (!session?.user?.id) {
    return { ok: false, reason: "UNAUTHENTICATED" };
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, role: true, status: true, deletedAt: true, erasedAt: true },
  });

  if (!dbUser || dbUser.status !== "ACTIVE" || dbUser.deletedAt || dbUser.erasedAt) {
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

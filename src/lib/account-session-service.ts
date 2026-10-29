import { randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "@/lib/prisma";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { isRateLimited } from "@/lib/rate-limit";
import { newPasswordSchema } from "@/validators/auth";
import { emitAccountSecurityNoticeTx } from "@/lib/account-security-notifications";

export const ACCOUNT_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function describeDevice(userAgent?: unknown): string {
  const ua = typeof userAgent === "string" ? userAgent.slice(0, 512) : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "浏览器";
  const platform = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "未知设备";
  return `${platform} · ${browser}`;
}

export async function createAccountSessionTx(tx: Prisma.TransactionClient, userId: string,
  deviceLabel: string, strongAuthAt: Date | null = null) {
  const now = new Date();
  const session = await tx.accountSession.create({ data: {
    id: randomUUID(), userId, deviceLabel, strongAuthAt,
    createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + ACCOUNT_SESSION_LIFETIME_MS),
  } });
  await recordAdminAudit({ actorId: userId, action: "ACCOUNT_LOGIN", targetType: "USER", targetId: userId }, tx);
  return session;
}

export async function isAccountSessionActive(userId?: string, sessionId?: string): Promise<boolean> {
  if (!userId || !sessionId) return false;
  const now = new Date();
  const session = await prisma.accountSession.findFirst({ where: {
    id: sessionId, userId, revokedAt: null, expiresAt: { gt: now },
    user: { deletedAt: null, erasedAt: null, credentialRecoveryRequired: false, status: { in: ["ACTIVE", "SUSPENDED"] } },
  }, select: { id: true, lastSeenAt: true } });
  if (!session) return false;
  if (session.lastSeenAt.getTime() < now.getTime() - 5 * 60_000) {
    await prisma.accountSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { lastSeenAt: now } });
  }
  return true;
}

export async function revokeAccountSessionsTx(tx: Prisma.TransactionClient, userId: string,
  mode: "ONE" | "OTHERS" | "ALL", currentSessionId: string, sessionId?: string) {
  if (mode === "ONE" && !sessionId) throw new Error("SESSION_ID_REQUIRED");
  return tx.accountSession.updateMany({ where: { userId, revokedAt: null,
    ...(mode === "ONE" ? { id: sessionId } : mode === "OTHERS" ? { id: { not: currentSessionId } } : {}),
  }, data: { revokedAt: new Date() } });
}

export async function requireCurrentSessionTx(tx: Prisma.TransactionClient, userId: string, sessionId: string) {
  await acquireGovernanceSubjectLock(tx, "USER", userId);
  const user = await tx.user.findUnique({ where: { id: userId } });
  const session = await tx.accountSession.findFirst({ where: {
    id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() },
  } });
  if (!user || !session || user.deletedAt || user.erasedAt || user.credentialRecoveryRequired || user.status !== "ACTIVE") {
    throw new Error("请重新登录后操作");
  }
  return user;
}

export async function revokeOwnSessions(userId: string, currentSessionId: string,
  mode: "ONE" | "OTHERS" | "ALL", sessionId?: string) {
  return withTransaction(async (tx) => {
    await requireCurrentSessionTx(tx, userId, currentSessionId);
    const result = await revokeAccountSessionsTx(tx, userId, mode, currentSessionId, sessionId);
    await recordAdminAudit({ actorId: userId, action: "ACCOUNT_SESSIONS_REVOKED", targetType: "USER", targetId: userId }, tx);
    await emitAccountSecurityNoticeTx(tx, userId, "SESSIONS_REVOKED", randomUUID());
    return result;
  });
}

// Logout remains idempotent after password reset, revocation or suspension.
export async function revokeSignedOutSession(userId: string, sessionId: string) {
  await withTransaction(async (tx) => {
    await acquireGovernanceSubjectLock(tx, "USER", userId);
    await revokeAccountSessionsTx(tx, userId, "ONE", sessionId, sessionId);
  });
}

export async function changeOwnPassword(userId: string, sessionId: string, currentPassword: string, newPassword: string) {
  const parsed = newPasswordSchema.safeParse(newPassword);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  if (Buffer.byteLength(currentPassword, "utf8") > 72) throw new Error("当前密码不正确");
  const budget = await isRateLimited({ key: `change-password:${userId}`, limit: 5, windowMs: 15 * 60_000 });
  if (budget.limited) throw new Error("尝试过于频繁，请稍后重试");
  const snapshot = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!snapshot || !await compare(currentPassword, snapshot.passwordHash)) throw new Error("当前密码不正确");
  if (await compare(newPassword, snapshot.passwordHash)) throw new Error("新密码不能与当前密码相同");
  const passwordHash = await hash(newPassword, 12);
  await withTransaction(async (tx) => {
    const user = await requireCurrentSessionTx(tx, userId, sessionId);
    if (user.passwordHash !== snapshot.passwordHash) throw new Error("凭据已变化，请重新登录");
    await tx.user.update({ where: { id: userId }, data: { passwordHash, mfaPendingEncrypted: null, mfaPendingExpiresAt: null, mfaPendingSessionId: null } });
    await revokeAccountSessionsTx(tx, userId, "ALL", sessionId);
    await recordAdminAudit({ actorId: userId, action: "ACCOUNT_PASSWORD_CHANGED", targetType: "USER", targetId: userId }, tx);
    await emitAccountSecurityNoticeTx(tx, userId, "PASSWORD_CHANGED", randomUUID());
  });
}

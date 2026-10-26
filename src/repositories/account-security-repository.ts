import { prisma } from "@/lib/prisma";

export const SECURITY_EVENT_LABELS: Record<string, string> = {
  ACCOUNT_LOGIN: "账号登录",
  ACCOUNT_PASSWORD_CHANGED: "修改密码",
  ACCOUNT_PASSWORD_RESET: "重置密码",
  ACCOUNT_SESSIONS_REVOKED: "撤销登录会话",
  ACCOUNT_MFA_ENABLED: "启用验证器",
  ACCOUNT_MFA_DISABLED: "停用验证器",
  ACCOUNT_EMAIL_VERIFIED: "验证邮箱",
};

export async function getOwnAccountSecurity(userId: string) {
  const [sessions, events, security] = await Promise.all([
    prisma.accountSession.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, deviceLabel: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true } }),
    prisma.adminLog.findMany({ where: { adminId: userId, targetType: "USER", targetId: userId,
      action: { in: Object.keys(SECURITY_EVENT_LABELS) } }, orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, action: true, createdAt: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { emailVerifiedAt: true, mfaSecretEncrypted: true } }),
  ]);
  return {
    emailVerified: Boolean(security.emailVerifiedAt),
    mfaEnabled: Boolean(security.mfaSecretEncrypted),
    sessions: sessions.map((row) => ({ ...row, active: !row.revokedAt && row.expiresAt.getTime() > Date.now(), createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(), expiresAt: row.expiresAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null })),
    events: events.map((row) => ({ id: row.id, label: SECURITY_EVENT_LABELS[row.action], at: row.createdAt.toISOString() })),
  };
}

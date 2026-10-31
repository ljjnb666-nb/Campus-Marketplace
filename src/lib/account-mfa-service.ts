import { randomUUID } from "node:crypto";
import { compare } from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "@/lib/prisma";
import { requireCurrentSessionTx, revokeAccountSessionsTx } from "@/lib/account-session-service";
import { decryptMfa, encryptMfa, matchTotpCounter, newTotpSecret } from "@/lib/account-security-crypto";
import { emitAccountSecurityNoticeTx } from "@/lib/account-security-notifications";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { isRateLimited, resetRateLimit } from "@/lib/rate-limit";
import { hasPermission, loadAuthorizationContext } from "@/lib/rbac/service";
import { asPermissionKey } from "@/lib/rbac/permissions";

// Called under the USER lock by credential finalization / challenge completion.
export async function verifyCredentialMfaTx(tx: Prisma.TransactionClient, userId: string, code?: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { mfaSecretEncrypted: true, mfaLastCounter: true } });
  if (!user) return { ok: false, strongAuthAt: null };
  if (!user.mfaSecretEncrypted) return { ok: true, strongAuthAt: null };
  // Called only after a valid password, recovery token or authenticated session.
  // Unknown-password failures cannot use this account-level budget to lock out a victim.
  const budgetKey = `mfa-verify:${userId}`;
  if ((await isRateLimited({ key: budgetKey, limit: 10, windowMs: 15 * 60_000 })).limited) {
    return { ok: false, strongAuthAt: null };
  }
  const counter = matchTotpCounter(decryptMfa(user.mfaSecretEncrypted, userId), code ?? "", user.mfaLastCounter);
  if (counter === null) return { ok: false, strongAuthAt: null };
  await tx.user.update({ where: { id: userId }, data: { mfaLastCounter: BigInt(counter) } });
  await resetRateLimit(budgetKey);
  return { ok: true, strongAuthAt: new Date() };
}

export async function privilegedSessionNeedsMfa(userId: string, sessionId?: string): Promise<boolean> {
  const context = await loadAuthorizationContext(userId);
  const privileged = context?.grants.some((grant) => grant.permissionKeys.some((value) => {
    const key = asPermissionKey(value);
    return key !== null && hasPermission(context, key, grant.campusId);
  }));
  if (!privileged) return false;
  if (!sessionId) return true;
  const session = await prisma.accountSession.findFirst({ where: {
    id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() },
    strongAuthAt: { gt: new Date(Date.now() - 12 * 60 * 60_000) },
    user: { mfaSecretEncrypted: { not: null } },
  }, select: { id: true } });
  return !session;
}

async function throttle(userId: string) {
  if ((await isRateLimited({ key: `mfa-manage:${userId}`, limit: 10, windowMs: 15 * 60_000 })).limited) throw new Error("SECURITY_RATE_LIMITED");
}
export async function beginMfaSetup(userId: string, sessionId: string, password: string) {
  await throttle(userId);
  const snapshot = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!snapshot || Buffer.byteLength(password) > 72 || !await compare(password, snapshot.passwordHash)) throw new Error("SECURITY_CREDENTIAL_INVALID");
  const secret = newTotpSecret();
  await withTransaction(async (tx) => {
    const user = await requireCurrentSessionTx(tx, userId, sessionId);
    if (user.passwordHash !== snapshot.passwordHash || user.mfaSecretEncrypted || !user.emailVerifiedAt) throw new Error("SECURITY_SETUP_DENIED");
    await tx.user.update({ where: { id: userId }, data: { mfaPendingEncrypted: encryptMfa(secret, userId), mfaPendingSessionId: sessionId, mfaPendingExpiresAt: new Date(Date.now() + 10 * 60_000) } });
  });
  return secret;
}

export async function confirmMfa(userId: string, sessionId: string, code: string, mode: "ENABLE" | "STEP_UP" | "DISABLE") {
  await throttle(userId);
  await withTransaction(async (tx) => {
    const user = await requireCurrentSessionTx(tx, userId, sessionId);
    if (mode === "ENABLE") {
      if (user.mfaSecretEncrypted || !user.mfaPendingEncrypted || user.mfaPendingSessionId !== sessionId || !user.mfaPendingExpiresAt || user.mfaPendingExpiresAt.getTime() <= Date.now()) throw new Error("SECURITY_SETUP_EXPIRED");
      const counter = matchTotpCounter(decryptMfa(user.mfaPendingEncrypted, userId), code, null);
      if (counter === null) throw new Error("SECURITY_CODE_INVALID");
      await tx.user.update({ where: { id: userId }, data: { mfaSecretEncrypted: user.mfaPendingEncrypted,
        mfaLastCounter: BigInt(counter), mfaPendingEncrypted: null, mfaPendingSessionId: null, mfaPendingExpiresAt: null } });
    } else {
      if (!user.mfaSecretEncrypted || !(await verifyCredentialMfaTx(tx, userId, code)).ok) throw new Error("SECURITY_CODE_INVALID");
      if (mode === "DISABLE") await tx.user.update({ where: { id: userId }, data: { mfaSecretEncrypted: null, mfaLastCounter: null, mfaPendingEncrypted: null, mfaPendingSessionId: null, mfaPendingExpiresAt: null } });
    }
    await tx.accountSession.update({ where: { id: sessionId }, data: { strongAuthAt: mode === "DISABLE" ? null : new Date() } });
    if (mode !== "STEP_UP") {
      await revokeAccountSessionsTx(tx, userId, "OTHERS", sessionId);
      const event = mode === "ENABLE" ? "MFA_ENABLED" : "MFA_DISABLED";
      await recordAdminAudit({ actorId: userId, action: `ACCOUNT_${event}`, targetType: "USER", targetId: userId }, tx);
      await emitAccountSecurityNoticeTx(tx, userId, event, randomUUID());
    }
  });
}

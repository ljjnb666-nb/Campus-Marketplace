import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { z } from "zod";
import { prisma, withTransaction } from "@/lib/prisma";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { challengeToken, digest, equalDigest } from "@/lib/account-security-crypto";
import { emitNotificationTx } from "@/lib/notifications/notification-service";
import { emitAccountSecurityNoticeTx } from "@/lib/account-security-notifications";
import { verifyCredentialMfaTx } from "@/lib/account-mfa-service";
import { isRateLimited } from "@/lib/rate-limit";
import { newPasswordSchema } from "@/validators/auth";

export type ChallengePurpose = "VERIFY_EMAIL" | "RESET_PASSWORD";
const lifetime = 15 * 60_000;
const binding = (email: string, passwordHash: string) => digest(JSON.stringify([email, passwordHash]));
const active = (user: { status: string; deletedAt: Date | null; erasedAt: Date | null } | null) =>
  user && !user.deletedAt && !user.erasedAt && (user.status === "ACTIVE" || user.status === "SUSPENDED");

// Return no identity/existence information, even for a throttled or absent account.
export async function requestAccountChallenge(email: string, purpose: ChallengePurpose, source: string) {
  const parsed = z.string().email().max(254).safeParse(email);
  if (!parsed.success) return;
  if ((await isRateLimited({ key: `account-challenge:source:${digest(source)}`, limit: 20, windowMs: 15 * 60_000 })).limited) return;
  if ((await isRateLimited({ key: `account-challenge:address:${digest(email)}`, limit: 5, windowMs: 60 * 60_000 })).limited) return;
  const snapshot = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!snapshot) return;
  await withTransaction(async (tx) => {
    await acquireGovernanceSubjectLock(tx, "USER", snapshot.id);
    const user = await tx.user.findUnique({ where: { id: snapshot.id } });
    if (!user || !active(user) || user.email !== email || (purpose === "VERIFY_EMAIL" && user.emailVerifiedAt)) return;
    // A restored T0 mailbox/MFA is not independent identity proof. Do not
    // issue ordinary reset links for quarantined accounts.
    if (purpose === "RESET_PASSWORD" && user.credentialRecoveryRequired) return;
    const now = new Date();
    const bindingHash = binding(user.email, user.passwordHash);
    // Resending must not invalidate an earlier link: an unauthenticated attacker
    // cannot continuously replace the victim's live recovery challenge.
    if (await tx.accountChallenge.findFirst({ where: { userId: user.id, purpose, bindingHash, consumedAt: null, expiresAt: { gt: now } } })) return;
    await tx.accountChallenge.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } } });
    const id = randomUUID();
    await tx.accountChallenge.create({ data: { id, userId: user.id, purpose, bindingHash,
      tokenHash: digest(challengeToken(id, purpose)), expiresAt: new Date(now.getTime() + lifetime) } });
    await emitNotificationTx(tx, { kind: "ACCOUNT_SECURITY_CHALLENGE", recipientUserId: user.id,
      dedupeKey: `ACCOUNT_SECURITY_CHALLENGE:${id}`, payload: { challengeId: id, purpose } });
  });
}

export async function completeAccountChallenge(input: {
  id: string; token: string; purpose: ChallengePurpose; newPassword?: string; mfaCode?: string;
}, source: string) {
  if ((await isRateLimited({ key: `account-challenge:consume:${digest(source)}`, limit: 20, windowMs: 15 * 60_000 })).limited) throw new Error("SECURITY_RATE_LIMITED");
  if (!z.string().uuid().safeParse(input.id).success || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new Error("SECURITY_LINK_INVALID");
  const snapshot = await prisma.accountChallenge.findUnique({ where: { id: input.id } });
  if (!snapshot || snapshot.purpose !== input.purpose || snapshot.consumedAt || snapshot.expiresAt.getTime() <= Date.now()
    || !equalDigest(snapshot.tokenHash, digest(input.token))) throw new Error("SECURITY_LINK_INVALID");
  const passwordHash = input.purpose === "RESET_PASSWORD" ? await hash(newPasswordSchema.parse(input.newPassword), 12) : undefined;
  await withTransaction(async (tx) => {
    await acquireGovernanceSubjectLock(tx, "USER", snapshot.userId);
    const user = await tx.user.findUnique({ where: { id: snapshot.userId } });
    const current = await tx.accountChallenge.findUnique({ where: { id: input.id } });
    if (!user || !active(user) || !current || current.consumedAt || current.expiresAt.getTime() <= Date.now()
      || current.purpose !== input.purpose || !equalDigest(current.tokenHash, digest(input.token))
      || !equalDigest(current.bindingHash, binding(user.email, user.passwordHash))) throw new Error("SECURITY_LINK_INVALID");
    if (input.purpose === "RESET_PASSWORD") {
      // Existing links can predate the disaster hold; reject inside the USER
      // lock so even a previously issued valid link cannot lift quarantine.
      if (user.credentialRecoveryRequired) throw new Error("SECURITY_LINK_INVALID");
      if (!(await verifyCredentialMfaTx(tx, user.id, input.mfaCode)).ok) throw new Error("SECURITY_CODE_INVALID");
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, mfaPendingEncrypted: null, mfaPendingExpiresAt: null, mfaPendingSessionId: null } });
      await tx.accountSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await recordAdminAudit({ actorId: user.id, action: "ACCOUNT_PASSWORD_RESET", targetType: "USER", targetId: user.id }, tx);
      await emitAccountSecurityNoticeTx(tx, user.id, "PASSWORD_RESET", input.id);
    } else {
      await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      await recordAdminAudit({ actorId: user.id, action: "ACCOUNT_EMAIL_VERIFIED", targetType: "USER", targetId: user.id }, tx);
    }
    await tx.accountChallenge.update({ where: { id: input.id }, data: { consumedAt: new Date() } });
  });
}

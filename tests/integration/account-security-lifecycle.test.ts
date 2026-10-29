// @vitest-environment node
import { randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { challengeToken, digest, encryptMfa, decryptMfa, totpCode } from "@/lib/account-security-crypto";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

const url = process.env.INTEGRATION_DATABASE_URL;
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!url)("account challenges and MFA authority (real PostgreSQL)", () => {
  let db: PrismaClient;
  let mfa: typeof import("@/lib/account-mfa-service");
  let challenges: typeof import("@/lib/account-challenge-service");
  let login: typeof import("@/lib/credential-login-service");
  const campusId = randomUUID(); const ids: string[] = []; const roleIds: string[] = [];
  const password = "OriginalPassword123";

  beforeAll(async () => {
    if (process.env.DATABASE_URL !== url) throw new Error("Integration app and fixture datasource must match");
    vi.stubEnv("NEXTAUTH_SECRET", "isolated-account-security-test-key-only");
    db = new PrismaClient({ datasources: { db: { url } } });
    mfa = await import("@/lib/account-mfa-service");
    challenges = await import("@/lib/account-challenge-service");
    login = await import("@/lib/credential-login-service");
    await db.campus.create({ data: { id: campusId, name: campusId, slug: campusId, schoolName: "Fixture" } });
  });
  afterAll(async () => {
    if (!db) return;
    const notifications = await db.notification.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const deliveries = await db.notificationDelivery.findMany({ where: { notificationId: { in: notifications.map((n) => n.id) } }, select: { id: true } });
    await db.asyncJob.deleteMany({ where: { dedupeKey: { in: deliveries.map((d) => `NOTIFICATION_DELIVERY:${d.id}`) } } });
    await db.notificationDelivery.deleteMany({ where: { id: { in: deliveries.map((d) => d.id) } } });
    await db.adminLog.deleteMany({ where: { adminId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.role.deleteMany({ where: { id: { in: roleIds } } });
    await db.campus.deleteMany({ where: { id: campusId } });
    await db.$disconnect();
    await (await import("@/lib/prisma")).prisma.$disconnect();
    vi.unstubAllEnvs();
  });
  async function account(verified = true) {
    const id = randomUUID(); ids.push(id);
    return db.user.create({ data: { id, email: `${id}@test.invalid`, name: "Fixture", schoolName: "Fixture",
      campusId, passwordHash: await hash(password, 10), emailVerifiedAt: verified ? new Date() : null } });
  }
  async function signIn(user: { id: string; email: string; passwordHash: string }) {
    const result = await login.finalizeCredentialLogin(user);
    expect(result?.sessionId).toBeTruthy(); return result!.sessionId;
  }
  async function challenge(user: { id: string; email: string }, purpose: "VERIFY_EMAIL" | "RESET_PASSWORD" = "VERIFY_EMAIL") {
    await challenges.requestAccountChallenge(user.email, purpose, randomUUID());
    const row = await db.accountChallenge.findFirstOrThrow({ where: { userId: user.id, purpose } });
    return { id: row.id, token: challengeToken(row.id, purpose), purpose };
  }

  it("bounds MFA guesses per account after primary proof without charging stale passwords", async () => {
    const user = await account();
    await db.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptMfa(secret, user.id) } });
    for (let attempt = 0; attempt < 12; attempt++) {
      expect(await login.finalizeCredentialLogin({ ...user, passwordHash: "stale-primary-proof", mfaCode: "invalid" })).toBeNull();
    }
    const code = totpCode(secret, Math.floor(Date.now() / 30_000));
    expect(await login.finalizeCredentialLogin({ ...user, mfaCode: code })).not.toBeNull();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await login.finalizeCredentialLogin({ ...user, mfaCode: "invalid" })).toBeNull();
    }
    // A fresh future-step code is valid cryptographically, but the spent account
    // budget denies it regardless of a distributed caller's source address.
    expect(await login.finalizeCredentialLogin({ ...user, mfaCode: totpCode(secret, Math.floor(Date.now() / 30_000) + 1) })).toBeNull();
    expect(await db.accountSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it("binds pending MFA enrollment to the password-proved session and revokes other sessions", async () => {
    const user = await account(); const one = await signIn(user); const two = await signIn(user);
    const key = await mfa.beginMfaSetup(user.id, one, password);
    const pending = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.mfaPendingSessionId).toBe(one);
    expect(decryptMfa(pending.mfaPendingEncrypted!, user.id)).toBe(key);
    const code = totpCode(key, Math.floor(Date.now() / 30_000));
    await expect(mfa.confirmMfa(user.id, two, code, "ENABLE")).rejects.toThrow("SECURITY_SETUP_EXPIRED");
    await mfa.confirmMfa(user.id, one, code, "ENABLE");
    const enabled = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(enabled.mfaPendingEncrypted).toBeNull(); expect(enabled.mfaPendingSessionId).toBeNull();
    expect(enabled.mfaSecretEncrypted).toBeTruthy(); expect(enabled.mfaLastCounter).not.toBeNull();
    expect((await db.accountSession.findUniqueOrThrow({ where: { id: one } })).strongAuthAt).not.toBeNull();
    expect((await db.accountSession.findUniqueOrThrow({ where: { id: two } })).revokedAt).not.toBeNull();
    expect(await login.finalizeCredentialLogin({ ...user, mfaCode: code })).toBeNull();
  });

  it("denies pending enrollment after expiry or missing mailbox proof", async () => {
    const user = await account(false); const sid = await signIn(user);
    await expect(mfa.beginMfaSetup(user.id, sid, password)).rejects.toThrow("SECURITY_SETUP_DENIED");
    await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const key = await mfa.beginMfaSetup(user.id, sid, password);
    await db.user.update({ where: { id: user.id }, data: { mfaPendingExpiresAt: new Date(0) } });
    await expect(mfa.confirmMfa(user.id, sid, totpCode(key, Math.floor(Date.now() / 30_000)), "ENABLE")).rejects.toThrow("SECURITY_SETUP_EXPIRED");
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).mfaSecretEncrypted).toBeNull();
  });

  it("serializes simultaneous logins so a TOTP creates exactly one strong session", async () => {
    const user = await account(); const counter = Math.floor(Date.now() / 30_000);
    await db.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptMfa(secret, user.id) } });
    const held = barrier(); const release = barrier();
    const candidate = { ...user, mfaCode: totpCode(secret, counter) };
    const first = login.finalizeCredentialLogin(candidate, { afterCheck: async () => { held.release(); await release.promise; } });
    await held.promise;
    const second = login.finalizeCredentialLogin(candidate);
    try { await waitForAdvisoryLockWaiter(db, [`USER:${user.id}`]); } finally { release.release(); }
    expect(await first).not.toBeNull(); expect(await second).toBeNull();
    expect(await db.accountSession.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).mfaLastCounter).toBe(BigInt(counter));
  });

  it("persists only challenge digests and keeps resends from replacing a live link", async () => {
    const user = await account(false); const input = await challenge(user);
    await challenges.requestAccountChallenge(user.email, "VERIFY_EMAIL", randomUUID());
    expect(await db.accountChallenge.count({ where: { userId: user.id } })).toBe(1);
    const row = await db.accountChallenge.findUniqueOrThrow({ where: { id: input.id } });
    expect(row.tokenHash).toBe(digest(input.token)); expect(row.tokenHash).not.toBe(input.token);
    const notifications = await db.notification.findMany({ where: { userId: user.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].payload).toEqual({ challengeId: input.id, purpose: input.purpose });
    expect(JSON.stringify(notifications)).not.toContain(input.token);
    const { renderNotificationEmail } = await import("@/lib/notifications/email-renderer");
    const rendered = renderNotificationEmail({ kind: notifications[0].kind!, schemaVersion: 1, payload: notifications[0].payload }, user.id, "https://campus.example");
    const url = new URL(rendered.text.match(/https:\/\/\S+/)![0]);
    expect(url.search).toBe(""); expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(input.token);
  });

  it.each(["token", "purpose", "expiry", "password", "email"])("rejects changed %s binding without consuming the challenge", async (changed) => {
    const user = await account(false); const input = await challenge(user);
    if (changed === "token") input.token = `${input.token[0] === "A" ? "B" : "A"}${input.token.slice(1)}`;
    if (changed === "purpose") input.purpose = "RESET_PASSWORD";
    if (changed === "expiry") await db.accountChallenge.update({ where: { id: input.id }, data: { expiresAt: new Date(0) } });
    if (changed === "password") await db.user.update({ where: { id: user.id }, data: { passwordHash: await hash("ChangedPassword456", 10) } });
    if (changed === "email") await db.user.update({ where: { id: user.id }, data: { email: `${randomUUID()}@test.invalid` } });
    await expect(challenges.completeAccountChallenge(input, randomUUID())).rejects.toThrow("SECURITY_LINK_INVALID");
    expect((await db.accountChallenge.findUniqueOrThrow({ where: { id: input.id } })).consumedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });

  it("consumes a mailbox challenge exactly once under concurrent requests", async () => {
    const user = await account(false); const input = await challenge(user);
    const held = barrier(); const release = barrier();
    const blocker = db.$transaction(async (tx) => {
      await acquireGovernanceSubjectLock(tx, "USER", user.id); held.release(); await release.promise;
    }, { timeout: 15_000 });
    await held.promise;
    const completing = Promise.allSettled([challenges.completeAccountChallenge(input, randomUUID()), challenges.completeAccountChallenge(input, randomUUID())]);
    try { await waitForAdvisoryLockWaiter(db, [`USER:${user.id}`]); } finally { release.release(); }
    await blocker;
    const results = await completing;
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect((await db.accountChallenge.findUniqueOrThrow({ where: { id: input.id } })).consumedAt).not.toBeNull();
    expect(await db.adminLog.count({ where: { adminId: user.id, action: "ACCOUNT_EMAIL_VERIFIED" } })).toBe(1);
  });

  it("password reset retains MFA, revokes all sessions, and cannot consume a link without its TOTP", async () => {
    const user = await account(); const sid = await signIn(user); const other = await signIn(user);
    await db.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptMfa(secret, user.id) } });
    const input = { ...await challenge(user, "RESET_PASSWORD"), newPassword: "ChangedPassword456" };
    await expect(challenges.completeAccountChallenge(input, randomUUID())).rejects.toThrow("SECURITY_CODE_INVALID");
    expect((await db.accountChallenge.findUniqueOrThrow({ where: { id: input.id } })).consumedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
    await challenges.completeAccountChallenge({ ...input, mfaCode: totpCode(secret, Math.floor(Date.now() / 30_000)) }, randomUUID());
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await compare(input.newPassword, updated.passwordHash)).toBe(true);
    expect(updated.mfaSecretEncrypted).not.toBeNull();
    expect(await db.accountSession.count({ where: { id: { in: [sid, other] }, revokedAt: null } })).toBe(0);
    expect(await login.finalizeCredentialLogin(user)).toBeNull();
    await expect(challenges.completeAccountChallenge(input, randomUUID())).rejects.toThrow("SECURITY_LINK_INVALID");
    expect(await db.adminLog.count({ where: { adminId: user.id, action: "ACCOUNT_PASSWORD_RESET" } })).toBe(1);
  });

  it("RECOVERY-HOLD-02：T0 旧哈希恢复后旧密码拒绝；真实邮箱挑战+重置解除隔离", async () => {
    const user = await account();
    const oldSession = await signIn(user);
    // The old bcrypt proof matches the database, but a production restore
    // quarantines that credential before any writer is restarted.
    await db.user.update({ where: { id: user.id }, data: { credentialRecoveryRequired: true } });
    expect(await compare(password, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
    expect(await login.finalizeCredentialLogin(user)).toBeNull();
    const { isAccountSessionActive } = await import("@/lib/account-session-service");
    expect(await isAccountSessionActive(user.id, oldSession)).toBe(false);

    const reset = { ...await challenge(user, "RESET_PASSWORD"), newPassword: "RecoveredAndRotatedPassword456" };
    await challenges.completeAccountChallenge(reset, randomUUID());
    const recovered = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(recovered.credentialRecoveryRequired).toBe(false);
    expect(await compare(password, recovered.passwordHash)).toBe(false);
    expect(await compare(reset.newPassword, recovered.passwordHash)).toBe(true);
    expect(await db.accountSession.count({ where: { id: oldSession, revokedAt: null } })).toBe(0);
    expect(await login.finalizeCredentialLogin(user)).toBeNull();
    expect(await login.finalizeCredentialLogin({ ...recovered })).not.toBeNull();
  });

  it("RECOVERY-HOLD-03：邮箱验证不能清除灾后密码隔离", async () => {
    const user = await account(false);
    await db.user.update({ where: { id: user.id }, data: { credentialRecoveryRequired: true } });
    const confirm = await challenge(user, "VERIFY_EMAIL");
    await challenges.completeAccountChallenge(confirm, randomUUID());
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).credentialRecoveryRequired).toBe(true);
    expect(await login.finalizeCredentialLogin(user)).toBeNull();
  });

  it("erasure wins against a waiting challenge completion and clears recovery secrets", async () => {
    const user = await account(false); const input = await challenge(user); const held = barrier(); const release = barrier();
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const erasing = eraseAccount(user.id, undefined, async () => { held.release(); await release.promise; });
    await held.promise;
    const consuming = challenges.completeAccountChallenge(input, randomUUID()).catch((error: unknown) => error);
    try { await waitForAdvisoryLockWaiter(db, [`USER:${user.id}`]); } finally { release.release(); }
    await erasing;
    expect(await consuming).toMatchObject({ message: "SECURITY_LINK_INVALID" });
    expect(await db.accountChallenge.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });

  it("uses current effective RBAC grants, membership and live strong session instead of the legacy role", async () => {
    const user = await account(); const other = await account(); const sid = await signIn(user); const otherSid = await signIn(other);
    await db.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    expect(await mfa.privilegedSessionNeedsMfa(user.id, sid)).toBe(false);
    await db.user.update({ where: { id: user.id }, data: { role: "STUDENT" } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: "report.review" } });
    const role = await db.role.create({ data: { key: `security-fixture-${randomUUID()}`, name: "Fixture", scope: "CAMPUS", rolePermissions: { create: { permissionId: permission.id } } } });
    roleIds.push(role.id);
    await db.userRoleAssignment.create({ data: { userId: user.id, roleId: role.id, campusId, scopeKey: `CAMPUS:${campusId}` } });
    expect(await mfa.privilegedSessionNeedsMfa(user.id, sid)).toBe(false);
    await db.campusMembership.create({ data: { userId: user.id, campusId, status: "ACTIVE" } });
    expect(await mfa.privilegedSessionNeedsMfa(user.id, sid)).toBe(true);
    await db.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptMfa(secret, user.id) } });
    await db.accountSession.update({ where: { id: sid }, data: { strongAuthAt: new Date() } });
    expect(await mfa.privilegedSessionNeedsMfa(user.id, sid)).toBe(false);
    expect(await mfa.privilegedSessionNeedsMfa(user.id, otherSid)).toBe(true);
    expect(await mfa.privilegedSessionNeedsMfa(user.id, undefined)).toBe(true);
    await db.accountSession.update({ where: { id: sid }, data: { strongAuthAt: new Date(Date.now() - 13 * 60 * 60_000) } });
    expect(await mfa.privilegedSessionNeedsMfa(user.id, sid)).toBe(true);
    await db.accountSession.update({ where: { id: sid }, data: { strongAuthAt: new Date(), revokedAt: new Date() } });
    expect(await mfa.privilegedSessionNeedsMfa(user.id, sid)).toBe(true);
    await db.campusMembership.update({ where: { userId_campusId: { userId: user.id, campusId } }, data: { status: "SUSPENDED" } });
    expect(await mfa.privilegedSessionNeedsMfa(user.id, sid)).toBe(false);
  });
});

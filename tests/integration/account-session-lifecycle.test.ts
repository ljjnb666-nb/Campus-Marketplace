// @vitest-environment node
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("account session authority PostgreSQL", () => {
  let db: PrismaClient;
  let sessions: typeof import("@/lib/account-session-service");
  let login: typeof import("@/lib/credential-login-service");
  const campusId = randomUUID();
  const ids: string[] = [];
  const password = "OriginalPassword123";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    vi.doMock("@/lib/prisma", () => ({ prisma: db,
      withTransaction: (fn: Parameters<typeof db.$transaction>[0]) => db.$transaction(fn),
    }));
    sessions = await import("@/lib/account-session-service");
    login = await import("@/lib/credential-login-service");
    await db.campus.create({ data: { id: campusId, name: campusId, slug: campusId, schoolName: "Fixture" } });
  });

  async function account() {
    const id = randomUUID();
    ids.push(id);
    return db.user.create({ data: { id, email: `${id}@test.invalid`, name: "Fixture", schoolName: "Fixture",
      campusId, passwordHash: await hash(password, 10) } });
  }
  async function signIn(user: { id: string; email: string; passwordHash: string }) {
    const identity = await login.finalizeCredentialLogin(user);
    expect(identity?.sessionId).toBeTruthy();
    return identity!.sessionId;
  }
  afterAll(async () => {
    if (!db) return;
    const notifications = await db.notification.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const deliveries = await db.notificationDelivery.findMany({ where: { notificationId: { in: notifications.map((n) => n.id) } }, select: { id: true } });
    await db.asyncJob.deleteMany({ where: { dedupeKey: { in: deliveries.map((d) => `NOTIFICATION_DELIVERY:${d.id}`) } } });
    await db.notificationDelivery.deleteMany({ where: { id: { in: deliveries.map((d) => d.id) } } });
    await db.adminLog.deleteMany({ where: { adminId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.campus.deleteMany({ where: { id: campusId } });
    await db.$disconnect();
    vi.doUnmock("@/lib/prisma");
  });

  it("rejects legacy or wrong-owner sessions and expires sessions independently of JWT", async () => {
    const a = await account(); const b = await account();
    const sid = await signIn(a);
    expect(await sessions.isAccountSessionActive(a.id, sid)).toBe(true);
    expect(await sessions.isAccountSessionActive(a.id, undefined)).toBe(false);
    expect(await sessions.isAccountSessionActive(b.id, sid)).toBe(false);
    await db.accountSession.update({ where: { id: sid }, data: { expiresAt: new Date(0) } });
    expect(await sessions.isAccountSessionActive(a.id, sid)).toBe(false);
  });

  it("selective and revoke-other controls cannot revoke another user's session", async () => {
    const a = await account(); const b = await account();
    const one = await signIn(a); const two = await signIn(a); const outsider = await signIn(b);
    expect((await sessions.revokeOwnSessions(a.id, one, "ONE", outsider)).count).toBe(0);
    expect(await sessions.isAccountSessionActive(b.id, outsider)).toBe(true);
    await sessions.revokeOwnSessions(a.id, one, "OTHERS");
    expect(await sessions.isAccountSessionActive(a.id, two)).toBe(false);
    expect(await sessions.isAccountSessionActive(a.id, one)).toBe(true);
    await sessions.revokeOwnSessions(a.id, one, "ALL");
    expect(await sessions.isAccountSessionActive(a.id, one)).toBe(false);
    await expect(sessions.revokeOwnSessions(a.id, two, "ALL")).rejects.toThrow("请重新登录");
  });

  it("password change invalidates every old session and stale bcrypt candidates", async () => {
    const user = await account(); const one = await signIn(user); const two = await signIn(user);
    await sessions.changeOwnPassword(user.id, one, password, "ChangedPassword456");
    expect(await sessions.isAccountSessionActive(user.id, one)).toBe(false);
    expect(await sessions.isAccountSessionActive(user.id, two)).toBe(false);
    expect(await login.finalizeCredentialLogin(user)).toBeNull();
    expect(await db.adminLog.count({ where: { adminId: user.id, action: "ACCOUNT_PASSWORD_CHANGED" } })).toBe(1);
    expect(await db.notification.count({ where: { userId: user.id, kind: "ACCOUNT_SECURITY_EVENT" } })).toBe(1);
  });

  it("wrong current password and equivalent new password leave sessions intact", async () => {
    const user = await account(); const sid = await signIn(user);
    await expect(sessions.changeOwnPassword(user.id, sid, "WrongPassword123", "ChangedPassword456")).rejects.toThrow("当前密码不正确");
    await expect(sessions.changeOwnPassword(user.id, sid, password, password)).rejects.toThrow("新密码不能");
    expect(await sessions.isAccountSessionActive(user.id, sid)).toBe(true);
  });

  it("logout is idempotent after revocation or suspension", async () => {
    const user = await account(); const sid = await signIn(user);
    await db.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    await sessions.revokeSignedOutSession(user.id, sid);
    await sessions.revokeSignedOutSession(user.id, sid);
    expect(await sessions.isAccountSessionActive(user.id, sid)).toBe(false);
  });
});

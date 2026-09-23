import { randomUUID } from "node:crypto";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RB-03 Active Account Mutation Serialization 集成测试（真实 PostgreSQL）。
 *
 * 在生产服务路径（updateOwnProfileTx：真实 withTransaction + USER 治理
 * advisory 锁 + loadAuthorizationContext 锁内 fresh 复核）上证明
 * ACTIVE_ACCOUNT_MUTATION_CONTRACT：
 *
 *  - RACE-01 erase wins：T1 完成 entry auth 后、取锁前挂起（beforeLock
 *    seam）→ T2 eraseAccount 同一 USER 锁域提交 → T1 恢复后锁内 fresh
 *    复核失败（AUTH_ACCOUNT_INACTIVE，零写入）→ 无 PII resurrection。
 *  - RACE-02 mutation wins：T1 持锁挂起（afterCheck seam）→ T2 erase
 *    真实进入锁等待队列（pg_locks barrier）→ T1 提交 → erase 随后执行
 *    → erasure 保持最终权威；零 40P01。
 *  - RACE-03 suspend wins：同 RACE-01，T2 = suspendAccount（production
 *    enforcement 路径）→ stale profile mutation 被拒。
 *  - SEND-ENTRY：CLASS C 代表路径 sendMessage 在停用账号下被 guard 拒绝。
 *
 * lifecycle authorities（eraseAccount / suspendAccount）均为生产路径，
 * 不 mock 锁。
 */

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `rb03it-${randomUUID().slice(0, 8)}`;
const RB03_CAMPUS_SLUG = "rb03-active-account-it";

const { integrationRequireUser } = vi.hoisted(() => ({
  integrationRequireUser: vi.fn(),
}));

vi.mock("@/lib/server-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-auth")>();
  return { ...actual, requireUser: integrationRequireUser };
});

describe.skipIf(!integrationDatabaseUrl)("active account mutation serialization (RB-03, real PostgreSQL)", () => {
  let campusId = "";
  let suspenderId = "";
  const userIds: string[] = [];
  const adHocRoleIds: string[] = [];
  const assignmentIds: string[] = [];
  const conversationIds: string[] = [];

  async function createFixtureUser(name: string) {
    const user = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-${userIds.length}-${name}@it.local`,
        name,
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId,
        role: "STUDENT",
        status: "ACTIVE",
      },
    });
    userIds.push(user.id);
    await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId, status: "ACTIVE" },
    });
    return user;
  }

  async function profileFields(userId: string) {
    return rawClient!.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        name: true,
        bio: true,
        phone: true,
        college: true,
        grade: true,
        avatarUrl: true,
        erasedAt: true,
        deletedAt: true,
        status: true,
      },
    });
  }

  beforeAll(async () => {
    const campus = await rawClient!.campus.upsert({
      where: { slug: RB03_CAMPUS_SLUG },
      create: { name: "RB03 集成校区", slug: RB03_CAMPUS_SLUG, schoolName: "集成测试大学" },
      update: {},
    });
    campusId = campus.id;

    // suspendAccount 的 actor：GLOBAL user.suspend 授权（production 合同）
    const suspender = await createFixtureUser("RB03 停用操作者");
    suspenderId = suspender.id;
    const role = await rawClient!.role.create({
      data: {
        key: `${RUN_TAG}_SUSPENDER`,
        name: `${RUN_TAG}_SUSPENDER`,
        scope: "GLOBAL",
        isSystem: false,
        rolePermissions: {
          create: [{ permission: { connect: { key: "user.suspend" } } }],
        },
      },
    });
    adHocRoleIds.push(role.id);
    const assignment = await rawClient!.userRoleAssignment.create({
      data: { userId: suspender.id, roleId: role.id, campusId: null, scopeKey: "GLOBAL" },
    });
    assignmentIds.push(assignment.id);
  });

  afterAll(async () => {
    await rawClient!.userRoleAssignment.deleteMany({ where: { id: { in: assignmentIds } } });
    await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: adHocRoleIds } } });
    await rawClient!.role.deleteMany({ where: { id: { in: adHocRoleIds } } });
    await rawClient!.conversationParticipant.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await rawClient!.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await rawClient!.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.enforcementAction.deleteMany({ where: { targetId: { in: userIds } } });
    await rawClient!.adminLog.deleteMany({ where: { adminId: { in: userIds } } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
    // 不删除 Campus 行（稳定 slug 复用）
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  it("RACE-01 erase wins：entry 后挂起 → erase 提交 → stale profile 锁内复核被拒，无 PII resurrection", async () => {
    const user = await createFixtureUser("RB01 竞态用户A");
    const { updateOwnProfileTx } = await import("@/lib/user/profile-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    // T1：entry auth 已完成（requireUser 层），在取锁前挂起
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateOwnProfileTx(
        tx,
        user.id,
        {
          name: "PII 复活者",
          bio: "被注销后写回的个人简介",
          college: "复活的学院",
          grade: "复活的年级",
          phone: "13800000000",
          avatarToken: "",
        },
        {
          beforeLock: async () => {
            signalEntered();
            await t1Gate;
          },
        },
      ),
    );
    await entered;

    // T2：erasure 提交（T1 未持任何锁 → 无竞争）
    await eraseAccount(user.id);

    releaseT1();
    // T1 恢复：USER 锁内 fresh 复核失败 → 业务拒绝、事务回滚
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    // 最终 DB 状态：erasure 契约字段保持匿名化，无任何 PII 复活
    const finalState = await profileFields(user.id);
    expect(finalState.erasedAt).not.toBeNull();
    expect(finalState.name).toBe("已注销用户");
    expect(finalState.bio).toBeNull();
    expect(finalState.phone).toBeNull();
    expect(finalState.college).toBeNull();
    expect(finalState.grade).toBeNull();
    expect(finalState.avatarUrl).toBeNull();
  });

  it("RACE-02 mutation wins：T1 持锁提交 → erase 排队后执行 → erasure 保持最终权威", async () => {
    const user = await createFixtureUser("RB03 竞态用户B");
    const { updateOwnProfileTx } = await import("@/lib/user/profile-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    let signalLockedChecked!: () => void;
    const lockedChecked = new Promise<void>((resolve) => {
      signalLockedChecked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    // T1：已持 USER 锁 + fresh active check 通过，挂起在首个写入前
    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateOwnProfileTx(
        tx,
        user.id,
        {
          name: "先提交的资料",
          bio: "随后被 erasure 覆盖",
          college: "",
          grade: "",
          phone: "13911112222",
          avatarToken: "",
        },
        {
          afterCheck: async () => {
            signalLockedChecked();
            await t1Gate;
          },
        },
      ),
    );
    await lockedChecked;

    // T2：erase 需要同一 USER 锁 → 真实进入等待队列（pg_locks barrier，零 sleep）
    const t2 = eraseAccount(user.id);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${user.id}`]);

    releaseT1();
    const profileResult = await t1;
    expect(profileResult.name).toBe("先提交的资料");
    const eraseResult = await t2;
    expect(eraseResult.userId).toBe(user.id);

    // erasure 最终权威：profile 的先提交被 erasure 完整覆盖
    const finalState = await profileFields(user.id);
    expect(finalState.erasedAt).not.toBeNull();
    expect(finalState.name).toBe("已注销用户");
    expect(finalState.bio).toBeNull();
    expect(finalState.phone).toBeNull();
  });

  it("RACE-03 suspend wins：suspendAccount（production 路径）先提交 → stale profile 被拒", async () => {
    const user = await createFixtureUser("RB03 竞态用户C");
    const { updateOwnProfileTx } = await import("@/lib/user/profile-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateOwnProfileTx(
        tx,
        user.id,
        {
          name: "停用后不得写入",
          bio: "",
          college: "",
          grade: "",
          phone: "13700000000",
          avatarToken: "",
        },
        {
          beforeLock: async () => {
            signalEntered();
            await t1Gate;
          },
        },
      ),
    );
    await entered;

    const suspendResult = await suspendAccount({
      actorId: suspenderId,
      targetUserId: user.id,
      reasonCode: "MANUAL_REVIEW",
      note: "RB-03 RACE-03 集成测试",
    });
    expect(suspendResult.status).toBe("SUSPENDED");

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const finalState = await profileFields(user.id);
    expect(finalState.status).toBe("SUSPENDED");
    // stale profile 写入未发生：姓名保持 fixture 原值
    expect(finalState.name).toBe("RB03 竞态用户C");
  });

  it("SEND-ENTRY：CLASS C 代表路径 sendMessage 对停用账号 fail closed", async () => {
    const { sendMessage } = await import("@/actions/conversation");
    const { withTransaction: realWithTransaction } = await import("@/lib/prisma");

    const suspendedUser = await createFixtureUser("RB03 停用发言者");
    const counterpart = await createFixtureUser("RB03 会话对方");
    await rawClient!.user.update({
      where: { id: suspendedUser.id },
      data: { status: "SUSPENDED" },
    });
    integrationRequireUser.mockResolvedValue({ id: suspendedUser.id, role: "STUDENT" });

    const conversation = await rawClient!.conversation.create({
      data: {
        conversationKey: `${RUN_TAG}-send-entry`,
        title: "RB03 会话",
      },
    });
    conversationIds.push(conversation.id);
    for (const participantId of [suspendedUser.id, counterpart.id]) {
      await rawClient!.conversationParticipant.create({
        data: { conversationId: conversation.id, userId: participantId },
      });
    }

    const formData = new FormData();
    formData.set("conversationId", conversation.id);
    formData.set("content", "停用账号不应能发送的消息");

    const result = await sendMessage({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    // RbacError（AUTH_ACCOUNT_INACTIVE）被 isMarketplaceGateError 分支消费，
    // 用户文案为 rbac 稳定 message
    expect(result.message).toBe("账号当前不可用");
    const messageCount = await rawClient!.message.count({
      where: { conversationId: conversation.id },
    });
    expect(messageCount).toBe(0);

    // withTransaction 引用保持真实（防 tree-shake 误报）
    expect(realWithTransaction).toBeTypeOf("function");
  });

  it("LOGIN-RACE-01 erase wins：bcrypt 后 beforeLock 挂起 → erase 提交 → finalizer DENY，无 lastLoginAt resurrection", async () => {
    const { hash } = await import("bcryptjs");
    const { finalizeCredentialLogin } = await import("@/lib/credential-login-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const password = ["RB03", "Correct", "Password1"].join("-");
    const passwordHash = await hash(password, 10);
    const user = await createFixtureUser("RB03 登录竞态A");
    await rawClient!.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    const candidate = { id: user.id, passwordHash, email: user.email };

    let signalCredentialed!: () => void;
    const credentialed = new Promise<void>((resolve) => {
      signalCredentialed = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    // T1：bcrypt 已逻辑完成，USER 锁之前挂起
    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      finalizeCredentialLogin(candidate, {
        beforeLock: async () => {
          signalCredentialed();
          await t1Gate;
        },
      }),
    );
    await credentialed;

    // T2：erasure 提交（替换 hash / 清 lastLoginAt / 匿名化）
    await eraseAccount(user.id);

    releaseT1();
    // 锁内 fresh：erasedAt + hash 变化 → DENY
    await expect(t1).resolves.toBeNull();

    const finalState = await rawClient!.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(finalState.erasedAt).not.toBeNull();
    expect(finalState.lastLoginAt).toBeNull();
    expect(finalState.name).toBe("已注销用户");
    expect(finalState.passwordHash).not.toBe(passwordHash);
  });

  it("LOGIN-RACE-02 login wins：finalizer 持锁提交 → erase 排队后执行 → erasure 最终权威（lastLoginAt 归零）", async () => {
    const { hash } = await import("bcryptjs");
    const { finalizeCredentialLogin } = await import("@/lib/credential-login-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");

    const password = ["RB03", "Correct", "Password2"].join("-");
    const passwordHash = await hash(password, 10);
    const user = await createFixtureUser("RB03 登录竞态B");
    await rawClient!.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    const candidate = { id: user.id, passwordHash, email: user.email };

    let signalChecked!: () => void;
    const checked = new Promise<void>((resolve) => {
      signalChecked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      finalizeCredentialLogin(candidate, {
        afterCheck: async () => {
          signalChecked();
          await t1Gate;
        },
      }),
    );
    await checked;

    const t2 = eraseAccount(user.id);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${user.id}`]);

    releaseT1();
    const identity = await t1;
    expect(identity).toEqual(
      expect.objectContaining({ id: user.id, email: user.email }),
    );
    const eraseResult = await t2;
    expect(eraseResult.userId).toBe(user.id);

    // erasure 最终权威：login 先提交的 lastLoginAt 被 erasure 清零
    const finalState = await rawClient!.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(finalState.erasedAt).not.toBeNull();
    expect(finalState.lastLoginAt).toBeNull();
    expect(finalState.name).toBe("已注销用户");
  });

  it("BLOCK-RACE-01 erase wins：entry 后 beforeLock 挂起 → erase actor 提交 → block 被拒，行 ABSENT", async () => {
    const { blockUserTx } = await import("@/lib/trust/block-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const actor = await createFixtureUser("RB03 拉黑竞态操作者");
    const target = await createFixtureUser("RB03 拉黑竞态目标");

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      blockUserTx(
        tx,
        actor.id,
        { targetUserId: target.id, reason: "RB03 race" },
        {
          beforeLock: async () => {
            signalEntered();
            await t1Gate;
          },
        },
      ),
    );
    await entered;

    await eraseAccount(actor.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const blockRow = await rawClient!.blockedUser.findUnique({
      where: {
        blockerId_blockedUserId: { blockerId: actor.id, blockedUserId: target.id },
      },
    });
    expect(blockRow).toBeNull();
  });
});

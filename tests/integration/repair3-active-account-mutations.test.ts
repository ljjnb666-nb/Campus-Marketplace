import { randomUUID } from "node:crypto";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import { PrismaClient, type Prisma, type ErrandTaskStatus } from "@prisma/client";
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
  let productCategoryId = "";
  let serviceCategoryId = "";
  let errandCategoryId = "";
  let rentalCategoryId = "";
  const productIds: string[] = [];
  const serviceIds: string[] = [];
  const rentalIds: string[] = [];
  const errandIds: string[] = [];
  const orderIds: string[] = [];
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

  async function createCategory(kind: "product" | "service" | "errand" | "rental") {
    const slug = `${RUN_TAG}-${kind}`;
    if (kind === "product") {
      if (!productCategoryId) {
        const row = await rawClient!.productCategory.create({ data: { name: slug, slug } });
        productCategoryId = row.id;
        return row.id;
      }
      return productCategoryId;
    }
    if (kind === "service") {
      if (!serviceCategoryId) {
        const row = await rawClient!.serviceCategory.create({ data: { name: slug, slug } });
        serviceCategoryId = row.id;
        return row.id;
      }
      return serviceCategoryId;
    }
    if (kind === "errand") {
      if (!errandCategoryId) {
        const row = await rawClient!.errandCategory.create({ data: { name: slug, slug } });
        errandCategoryId = row.id;
        return row.id;
      }
      return errandCategoryId;
    }
    if (!rentalCategoryId) {
      const row = await rawClient!.rentalCategory.create({ data: { name: slug, slug } });
      rentalCategoryId = row.id;
      return row.id;
    }
    return rentalCategoryId;
  }

  async function createProductRow(ownerId: string, status: "ACTIVE" | "PAUSED" | "RESERVED" | "SOLD" | "OFFLINE") {
    const categoryId = await createCategory("product");
    const row = await rawClient!.product.create({
      data: {
        title: `RB03 商品 ${randomUUID().slice(0, 6)}`,
        description: "RB03 status race",
        price: 10,
        condition: "NEW",
        locationText: "北门",
        categoryId,
        campusId,
        sellerId: ownerId,
        status,
      },
    });
    return row;
  }

  async function createServiceRow(ownerId: string, status: "ACTIVE" | "PAUSED" | "OFFLINE") {
    const categoryId = await createCategory("service");
    const row = await rawClient!.serviceListing.create({
      data: {
        title: `RB03 服务 ${randomUUID().slice(0, 6)}`,
        description: "RB03 status race",
        price: "10.00",
        pricingUnit: "PER_ORDER",
        locationText: "北门",
        categoryId,
        campusId,
        providerId: ownerId,
        status,
      },
    });
    return row;
  }

  async function createRentalRow(ownerId: string, status: "AVAILABLE" | "PAUSED" | "OFFLINE") {
    const categoryId = await createCategory("rental");
    const row = await rawClient!.rentalListing.create({
      data: {
        title: `RB03 租赁 ${randomUUID().slice(0, 6)}`,
        description: "RB03 status race",
        condition: "NEW",
        price: "10.00",
        pricingUnit: "PER_DAY",
        depositAmount: "0",
        minimumDuration: 1,
        maximumDuration: 7,
        totalQuantity: 1,
        availableQuantity: 1,
        pickupLocation: "北门",
        returnLocation: "北门",
        status,
        ownerId,
        campusId,
        categoryId,
      },
    });
    return row;
  }

  async function createErrandRow(publisherId: string, status: ErrandTaskStatus, accepterId?: string) {
    const categoryId = await createCategory("errand");
    const row = await rawClient!.errandTask.create({
      data: {
        title: `RB03 跑腿 ${randomUUID().slice(0, 6)}`,
        description: "RB03 status race",
        categoryId,
        reward: "8.00",
        pickupLocation: "北门",
        deliveryLocation: "南门",
        deadline: new Date(Date.now() + 24 * 3600_000),
        campusId,
        publisherId,
        accepterId: accepterId ?? null,
        status,
      },
    });
    return row;
  }

  async function createRentalOrderRow(input: {
    listingId: string;
    ownerId: string;
    renterId: string;
    status: "PENDING_APPROVAL" | "IN_RENTAL" | "COMPLETED";
  }) {
    const now = new Date();
    return rawClient!.rentalOrder.create({
      data: {
        orderNumber: `${RUN_TAG}-ro-${randomUUID().slice(0, 8)}`,
        rentalListingId: input.listingId,
        ownerId: input.ownerId,
        renterId: input.renterId,
        startTime: new Date(now.getTime() + 24 * 3600_000),
        endTime: new Date(now.getTime() + 48 * 3600_000),
        quantity: 1,
        unitPriceSnapshot: "10.00",
        pricingUnitSnapshot: "PER_DAY",
        rentalDuration: 1,
        rentalAmount: "10.00",
        depositAmount: "0",
        finalAmount: "10.00",
        paymentStatus: "OFFLINE_PENDING",
        depositStatus: "NOT_REQUIRED",
        status: input.status,
        pickupLocationSnapshot: "北门",
        returnLocationSnapshot: "北门",
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
    // 预建四类类目（RB-03 status race fixtures 用）
    await createCategory("product");
    await createCategory("service");
    await createCategory("errand");
    await createCategory("rental");

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
    await rawClient!.order.deleteMany({ where: { OR: [{ buyerId: { in: userIds } }, { sellerId: { in: userIds } }] } });
    // RentalOrder（owner/renter 维度，非 general Order 表）先行清理，
    // 否则 rentalListing 删除被 FK 阻塞
    await rawClient!.rentalOrder.deleteMany({
      where: { OR: [{ ownerId: { in: userIds } }, { renterId: { in: userIds } }] },
    });
    await rawClient!.privacyRequest.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.errandTask.deleteMany({ where: { id: { in: errandIds } } });
    await rawClient!.product.deleteMany({ where: { id: { in: productIds } } });
    await rawClient!.serviceListing.deleteMany({ where: { id: { in: serviceIds } } });
    await rawClient!.rentalListing.deleteMany({ where: { id: { in: rentalIds } } });
    await rawClient!.productCategory.deleteMany({ where: { id: productCategoryId } });
    await rawClient!.serviceCategory.deleteMany({ where: { id: serviceCategoryId } });
    await rawClient!.errandCategory.deleteMany({ where: { id: errandCategoryId } });
    await rawClient!.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
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

  // ============================================================
  // RB-03 REVIEW FIX 3：LISTING_STATUS_LIFECYCLE_SERIALIZATION races
  // ============================================================

  it("STATUS-RACE-PRODUCT-01 erase wins：stale RESERVED 挂起 → erase 提交 → 拒绝，Product OFFLINE", async () => {
    const { updateProductStatusTx } = await import("@/lib/listing-status-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const seller = await createFixtureUser("RB03 商品竞态A");
    const product = await createProductRow(seller.id, "ACTIVE");
    productIds.push(product.id);

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateProductStatusTx(tx, seller.id, product.id, "RESERVED", {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      }),
    );
    await entered;

    await eraseAccount(seller.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const finalUser = await rawClient!.user.findUniqueOrThrow({ where: { id: seller.id } });
    expect(finalUser.erasedAt).not.toBeNull();
    const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
    // POST_ERASURE_PRODUCT_STATUS_RESURRECTION = NO：erasure 权威 OFFLINE
    expect(finalProduct.status).toBe("OFFLINE");
  });

  it("STATUS-RACE-PRODUCT-02 mutation wins：RESERVED 先提交 → erase 排队后执行 → OFFLINE 最终权威", async () => {
    const { updateProductStatusTx } = await import("@/lib/listing-status-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");

    const seller = await createFixtureUser("RB03 商品竞态B");
    const product = await createProductRow(seller.id, "ACTIVE");
    productIds.push(product.id);

    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateProductStatusTx(tx, seller.id, product.id, "RESERVED", {
        afterCheck: async () => {
          signalLocked();
          await t1Gate;
        },
      }),
    );
    await locked;

    const t2 = eraseAccount(seller.id);
    await waitForAdvisoryLockWaiter(rawClient!, ["USER:" + seller.id]);

    releaseT1();
    expect(await t1).toBe(true);
    await t2;

    // ERASURE_FINAL_AUTHORITY：erase 看到竞态提交的 RESERVED → 置 OFFLINE
    const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(finalProduct.status).toBe("OFFLINE");
  });

  it("STATUS-RACE-SERVICE-01 erase wins：stale PAUSED → 拒绝，Service OFFLINE", async () => {
    const { updateServiceStatusTx } = await import("@/lib/listing-status-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const provider = await createFixtureUser("RB03 服务竞态");
    const service = await createServiceRow(provider.id, "ACTIVE");
    serviceIds.push(service.id);

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateServiceStatusTx(tx, provider.id, service.id, "PAUSED", {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      }),
    );
    await entered;

    await eraseAccount(provider.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const finalService = await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } });
    expect(finalService.status).toBe("OFFLINE");
  });

  it("STATUS-RACE-RENTAL-01 erase wins：stale PAUSED → 拒绝，Rental OFFLINE", async () => {
    const { updateRentalListingStatusTx } = await import("@/lib/listing-status-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const owner = await createFixtureUser("RB03 租赁竞态");
    const rental = await createRentalRow(owner.id, "AVAILABLE");
    rentalIds.push(rental.id);

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateRentalListingStatusTx(tx, owner.id, rental.id, "PAUSED", {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      }),
    );
    await entered;

    await eraseAccount(owner.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const finalRental = await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: rental.id } });
    expect(finalRental.status).toBe("OFFLINE");
  });

  it("STATUS-RACE-ERRAND-01 accepter erase wins：stale CLAIMED to IN_PROGRESS → 拒绝，任务保持 CLAIMED", async () => {
    const { updateErrandStatusTx } = await import("@/lib/errand-status-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const publisher = await createFixtureUser("RB03 跑腿发布者");
    const accepter = await createFixtureUser("RB03 跑腿接单者");
    const task = await createErrandRow(publisher.id, "CLAIMED", accepter.id);
    errandIds.push(task.id);

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateErrandStatusTx(tx, accepter.id, task.id, "IN_PROGRESS", {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      }),
    );
    await entered;

    await eraseAccount(accepter.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const finalTask = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: task.id } });
    // POST_ERASURE_STATUS_WRITE = NO：被注销接单者不能驱动 publisher 任务状态
    expect(finalTask.status).toBe("CLAIMED");
  });

  it("STATUS-RACE-ERRAND-02 fresh-state：事务外 stale CLAIMED snapshot 不能授权旧 transition", async () => {
    const { updateErrandStatusTx } = await import("@/lib/errand-status-service");
    const { withTransaction } = await import("@/lib/prisma");

    const publisher = await createFixtureUser("RB03 fresh-state 发布者");
    const task = await createErrandRow(publisher.id, "CLAIMED");
    errandIds.push(task.id);

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateErrandStatusTx(tx, publisher.id, task.id, "IN_PROGRESS", {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      }),
    );
    void t1;
    await entered;

    // controlled DB mutation：fresh row 在 T1 取锁前变为 CANCELLED
    await rawClient!.errandTask.update({ where: { id: task.id }, data: { status: "CANCELLED" } });

    releaseT1();
    // fresh CANCELLED + 请求 IN_PROGRESS：角色/状态均不满足 → NO-OP
    expect(await t1).toBe(false);

    const finalTask = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(finalTask.status).toBe("CANCELLED");
  });

  it("SUSPEND-REGRESSION：suspend 先提交 → stale Product RESERVED 被拒，Product 保持原状态", async () => {
    const { updateProductStatusTx } = await import("@/lib/listing-status-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");

    // 本文件内联 suspender fixture（GLOBAL user.suspend ad-hoc 角色）
    const suspender = await createFixtureUser("RB03 suspend 回归操作者");
    const susRole = await rawClient!.role.create({
      data: {
        key: `${RUN_TAG}-sus-regr`,
        name: `${RUN_TAG}-sus-regr`,
        scope: "GLOBAL",
        isSystem: false,
        rolePermissions: {
          create: [{ permission: { connect: { key: "user.suspend" } } }],
        },
      },
    });
    adHocRoleIds.push(susRole.id);
    const susAssignment = await rawClient!.userRoleAssignment.create({
      data: { userId: suspender.id, roleId: susRole.id, campusId: null, scopeKey: "GLOBAL" },
    });
    assignmentIds.push(susAssignment.id);
    const seller = await createFixtureUser("RB03 suspend 回归卖家");
    const product = await createProductRow(seller.id, "ACTIVE");
    productIds.push(product.id);

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateProductStatusTx(tx, seller.id, product.id, "RESERVED", {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      }),
    );
    await entered;

    const suspendResult = await suspendAccount({
      actorId: suspender.id,
      targetUserId: seller.id,
      reasonCode: "MANUAL_REVIEW",
      note: "RB-03 SUSPEND-REGRESSION",
    });
    expect(suspendResult.status).toBe("SUSPENDED");

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
    // SUSPEND_FIRST = NO LATER STATUS WRITE：保持 suspend 前 authoritative 状态
    expect(finalProduct.status).toBe("ACTIVE");
  });

  it("WIND-DOWN：ACTIVE but RISK_RESTRICTED → OFFLINE wind-down ALLOW / ACTIVE reactivation DENY", async () => {
    const { updateProductStatusTx } = await import("@/lib/listing-status-service");
    const seller = await createFixtureUser("RB03 restricted 卖家");
    const product = await createProductRow(seller.id, "ACTIVE");
    productIds.push(product.id);

    // riskState RESTRICTED（GLOBAL scope）
    await rawClient!.riskState.create({
      data: {
        userId: seller.id,
        scopeKey: "GLOBAL",
        state: "RESTRICTED",
        reasonCode: "RB03_WIND_DOWN_TEST",
      },
    });

    // wind-down 到 OFFLINE：仅 lifecycle guard，ALLOW（Phase 6C-3 语义）
    const { withTransaction } = await import("@/lib/prisma");
    const windDown = await withTransaction((tx: Prisma.TransactionClient) =>
      updateProductStatusTx(tx, seller.id, product.id, "OFFLINE"),
    );
    expect(windDown).toBe(true);
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("OFFLINE");

    // 重新激活到 ACTIVE：capability DENY（risk RESTRICTED）
    const { enforceMarketplaceCapability } = await import("@/lib/enforcement/capability-gate");
    await expect(
      withTransaction(async (tx: Prisma.TransactionClient) => {
        await enforceMarketplaceCapability(tx, seller.id, campusId);
        await tx.product.update({ where: { id: product.id }, data: { status: "ACTIVE" } });
      }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_RESTRICTED" });
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).not.toBe("ACTIVE");
  });

  // ============================================================
  // RB-03 FINAL PROOF：RENTAL / PRIVACY lifecycle races
  // ============================================================

  it("RENTAL-RACE-01 suspend wins：stale requestExtension 挂起 → suspend 提交 → 拒绝，零 extension 零通知", async () => {
    const { requestExtensionTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");

    const owner = await createFixtureUser("RB03-PR 续租出租者");
    const renter = await createFixtureUser("RB03-PR 续租租客");
    const listing = await createRentalRow(owner.id, "AVAILABLE");
    rentalIds.push(listing.id);
    const order = await createRentalOrderRow({
      listingId: listing.id,
      ownerId: owner.id,
      renterId: renter.id,
      status: "IN_RENTAL",
    });
    orderIds.push(order.id);
    const expectedEndTime = order.endTime;

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      requestExtensionTx(
        tx,
        {
          orderId: order.id,
          userId: renter.id,
          newEndTime: new Date(Date.now() + 96 * 3600_000),
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
      targetUserId: renter.id,
      reasonCode: "MANUAL_REVIEW",
      note: "RB-03 RENTAL-RACE-01",
    });
    expect(suspendResult.status).toBe("SUSPENDED");

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    // 零 durable mutation
    const extensions = await rawClient!.rentalExtensionRequest.count({
      where: { orderId: order.id },
    });
    expect(extensions).toBe(0);
    const finalOrder = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.endTime.getTime()).toBe(expectedEndTime.getTime());
    const orderNotifications = await rawClient!.notification.count({
      where: { orderId: order.id },
    });
    expect(orderNotifications).toBe(0);
  }, 30_000);

  it("RENTAL-RACE-02 erase wins：COMPLETED rental 的 stale review 挂起 → erase 提交 → 拒绝，零 RentalReview", async () => {
    const { submitRentalReviewTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const owner = await createFixtureUser("RB03-PR 评价出租者");
    const renter = await createFixtureUser("RB03-PR 评价租客");
    await rawClient!.user.update({
      where: { id: owner.id },
      data: { rentalPositiveRate: 0.83 },
    });
    const listing = await createRentalRow(owner.id, "OFFLINE");
    rentalIds.push(listing.id);
    const order = await createRentalOrderRow({
      listingId: listing.id,
      ownerId: owner.id,
      renterId: renter.id,
      status: "COMPLETED",
    });
    orderIds.push(order.id);

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      submitRentalReviewTx(
        tx,
        {
          orderId: order.id,
          userId: renter.id,
          overallRating: 5,
          content: "post-erasure resurrection attempt",
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

    await eraseAccount(renter.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    // 零 RentalReview + target positive rate 不变（post-erasure 零内容复活）
    const reviews = await rawClient!.rentalReview.count({ where: { orderId: order.id } });
    expect(reviews).toBe(0);
    const target = await rawClient!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(Number(target.rentalPositiveRate)).toBe(0.83);
    const orderNotifications = await rawClient!.notification.count({
      where: { orderId: order.id },
    });
    expect(orderNotifications).toBe(0);
  }, 30_000);

  it("RENTAL-RACE-03 initiator erase wins：participant 锁前挂起 → erase initiator → sorted 锁后 checks-only DENY，零 dispute/hold/status-log", async () => {
    const { initiateDisputeTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const owner = await createFixtureUser("RB03-PR 纠纷出租者");
    const initiator = await createFixtureUser("RB03-PR 纠纷发起者");
    const listing = await createRentalRow(owner.id, "OFFLINE");
    rentalIds.push(listing.id);
    const order = await createRentalOrderRow({
      listingId: listing.id,
      ownerId: owner.id,
      renterId: initiator.id,
      status: "COMPLETED",
    });
    orderIds.push(order.id);

    let signalDiscovered!: () => void;
    const discovered = new Promise<void>((resolve) => {
      signalDiscovered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      initiateDisputeTx(tx, {
        orderId: order.id,
        userId: initiator.id,
        reason: "post-erasure dispute attempt",
        evidencePhotos: [],
        beforeSubjectLocks: async (tx2: Prisma.TransactionClient) => {
          void tx2;
          signalDiscovered();
          await t1Gate;
        },
      }),
    );
    await discovered;

    // initiator erase 先提交（COMPLETED 不阻断注销）
    await eraseAccount(initiator.id);

    releaseT1();
    // sorted participant 锁取得后：checks-only initiator 复核 DENY
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    // 全部 dispute 副作用为零
    const disputes = await rawClient!.rentalDispute.count({ where: { orderId: order.id } });
    expect(disputes).toBe(0);
    const holds = await rawClient!.dataHold.count({
      where: { subjectType: "USER", subjectId: initiator.id },
    });
    expect(holds).toBe(0);
    const finalOrder = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("COMPLETED");
    const statusLogs = await rawClient!.rentalOrderStatusLog.count({
      where: { orderId: order.id },
    });
    expect(statusLogs).toBe(0);
    const orderNotifications = await rawClient!.notification.count({
      where: { orderId: order.id },
    });
    expect(orderNotifications).toBe(0);
  }, 30_000);

  it("EXPORT-RACE-01 erase wins：beforeLock 挂起 → erase 提交 → 拒绝，零 DATA_EXPORT PrivacyRequest，builder 未调用", async () => {
    const { executeSynchronousDataExport } = await import("@/lib/privacy/data-export");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const user = await createFixtureUser("RB03 导出竞态用户");
    const builder = vi.fn().mockResolvedValue({ profile: {} });

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = executeSynchronousDataExport(user.id, builder, {
      beforeLock: async () => {
        signalEntered();
        await t1Gate;
      },
    });
    await entered;

    await eraseAccount(user.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    expect(builder).not.toHaveBeenCalled();
    const exportRequests = await rawClient!.privacyRequest.count({
      where: { userId: user.id, type: "DATA_EXPORT" },
    });
    expect(exportRequests).toBe(0);
  }, 30_000);

  it("DELETION-RACE-01 suspend wins：beforeLock 挂起 → suspend 提交 → 拒绝，零 ACCOUNT_DELETION request，零部分擦除", async () => {
    const { createAccountDeletionRequest } = await import("@/lib/privacy/privacy-request-service");

    const user = await createFixtureUser("RB03 删除竞态A");

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = createAccountDeletionRequest(user.id, {
      beforeLock: async () => {
        signalEntered();
        await t1Gate;
      },
    });
    await entered;

    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
    const suspendResult = await suspendAccount({
      actorId: suspenderId,
      targetUserId: user.id,
      reasonCode: "MANUAL_REVIEW",
      note: "RB-03 DELETION-RACE-01",
    });
    expect(suspendResult.status).toBe("SUSPENDED");

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const deletionRequests = await rawClient!.privacyRequest.count({
      where: { userId: user.id, type: "ACCOUNT_DELETION" },
    });
    expect(deletionRequests).toBe(0);
    const finalUser = await rawClient!.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(finalUser.status).toBe("SUSPENDED");
    expect(finalUser.erasedAt).toBeNull();
    expect(finalUser.name).toBe("RB03 删除竞态A");
  }, 30_000);

  it("DELETION-RACE-02 deletion wins：USER 锁内挂起 → suspend 排队（pg_locks 证明）→ 删除完成 → suspend 安全失败", async () => {
    const { createAccountDeletionRequest } = await import("@/lib/privacy/privacy-request-service");
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");

    console.log("[DR02] stage: fixture start");
    const user = await createFixtureUser("RB03 删除竞态B");
    console.log("[DR02] stage: fixture done");

    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    console.log("[DR02] stage: t1 launching");
    const t1 = createAccountDeletionRequest(user.id, {
      afterCheck: async () => {
        signalLocked();
        await t1Gate;
      },
    });
    await locked;
    console.log("[DR02] stage: locked, t2 launching");

    console.log("[DR02] t2 suspend starting");
    const enforcement = await import("@/lib/enforcement/account-enforcement-service");
    const t2 = enforcement.suspendAccount({
      actorId: suspenderId,
      targetUserId: user.id,
      reasonCode: "MANUAL_REVIEW",
      note: "RB-03 DELETION-RACE-02",
    });
    void t2.catch(() => undefined);
    console.log("[DR02] t2 launched, waiting for lock waiter");
    // pg_locks 证明 T2 真实等待 USER:<target> advisory lock
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${user.id}`]);
    console.log("[DR02] stage: waiter detected");
    console.log("[DR02] waiter detected");

    releaseT1();
    console.log("[DR02] t1 released");
    const outcome = await t1;
    if (outcome.status !== "COMPLETED") {
      throw new Error("expected COMPLETED deletion outcome");
    }
    expect(outcome.status).toBe("COMPLETED");
    expect(outcome.erasure.erasedAt).not.toBeNull();

    // target 已 erased：suspend fails safely（不产生 SUSPENDED 终态覆盖）
    console.log("[DR02] stage: awaiting t2");
    const t2Outcome = await t2.then(
      (v) => ({ settled: true, v }),
      (e) => ({ settled: true as const, code: (e as { code?: string }).code }),
    );
    console.log("[DR02] t2 settled", JSON.stringify(t2Outcome));
    expect((t2Outcome as { code?: string }).code).toBe("ENFORCEMENT_TARGET_NOT_FOUND");

    const finalUser = await rawClient!.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(finalUser.erasedAt).not.toBeNull();
    expect(finalUser.lastLoginAt).toBeNull();
    expect(finalUser.name).toBe("已注销用户");
    expect(finalUser.status).not.toBe("SUSPENDED");
    const request = await rawClient!.privacyRequest.findFirstOrThrow({
      where: { userId: user.id, type: "ACCOUNT_DELETION" },
    });
    expect(request.status).toBe("COMPLETED");
  }, 90_000);

  it("PRIVACY-CANCEL-RACE-01 erase wins：legacy REQUESTED cancel 挂起 → erase 提交 → 拒绝，请求保持 REQUESTED", async () => {
    const { cancelOwnPendingRequest } = await import("@/lib/privacy/privacy-request-service");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const user = await createFixtureUser("RB03 取消竞态用户");
    const legacy = await rawClient!.privacyRequest.create({
      data: { userId: user.id, type: "ACCOUNT_DELETION", status: "REQUESTED" },
    });

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = cancelOwnPendingRequest(user.id, legacy.id, {
      beforeLock: async () => {
        signalEntered();
        await t1Gate;
      },
    });
    await entered;

    await eraseAccount(user.id);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    const finalRequest = await rawClient!.privacyRequest.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(finalRequest.status).toBe("REQUESTED");
  }, 30_000);
});

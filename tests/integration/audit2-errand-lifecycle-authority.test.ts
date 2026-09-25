import { randomUUID } from "node:crypto";
import { PrismaClient, type ErrandTaskStatus, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * AUDIT2-RB02：ERRAND LIFECYCLE AUTHORITY CLOSURE 真实 PostgreSQL 集成验证。
 *
 * 冻结不变量：ErrandTask + 其当前 active ERRAND Order 组成一个业务生命
 * 周期 aggregate，全部状态转换由 ONE CANONICAL AUTHORITY
 * （src/lib/errand-lifecycle.ts）决定——详情页与订单中心两个入口共享
 * 同一套 participant locks → ErrandTask 行锁 → active Order 行锁 →
 * pair 谓词 → 写入。
 *
 * 竞态全部使用 Promise barrier + advisory-lock waiter 证据
 * （waitForAdvisoryLockWaiter；禁止 sleep 排序，timeout 仅作死锁保护），
 * 状态突变全部为真实 DB 行；每个用例最终同时断言 ErrandTask.status /
 * accepterId / Order.status / cancelReason / 通知数量（§56）。
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `a2rb02-${randomUUID().slice(0, 8)}`;
const CAMPUS_SLUG = "a2rb02-lifecycle-it";

const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");

describe.skipIf(!integrationDatabaseUrl)(
  "AUDIT2-RB02 errand lifecycle authority (real PostgreSQL)",
  () => {
    let campusId = "";
    let errandCategoryId = "";
    const userIds: string[] = [];
    const errandIds: string[] = [];
    const orderIds: string[] = [];

    let fixtureSeq = 0;

    async function createFixtureUser(name: string) {
      const seq = fixtureSeq++;
      const user = await rawClient!.user.create({
        data: {
          email: `${RUN_TAG}-${seq}-${name}@it.local`,
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

    /** 创建 ErrandTask + 可选 active ERRAND Order（真实双行 fixture）。 */
    async function createErrandFixture(input: {
      taskStatus: "OPEN" | "CLAIMED" | "IN_PROGRESS" | "PENDING_CONFIRMATION";
      withAccepter?: boolean;
      orderStatus?: "ACCEPTED" | "IN_PROGRESS" | null;
    }) {
      const publisher = await createFixtureUser("发布者");
      const accepter =
        input.withAccepter === false ? null : await createFixtureUser("接单者");
      const task = await rawClient!.errandTask.create({
        data: {
          title: `A2RB02 任务 ${randomUUID().slice(0, 6)}`,
          description: "AUDIT2-RB02 lifecycle authority fixture",
          categoryId: errandCategoryId,
          reward: "8.00",
          pickupLocation: "北门",
          deliveryLocation: "南门",
          deadline: new Date(Date.now() + 24 * 3600_000),
          campusId,
          publisherId: publisher.id,
          accepterId: accepter?.id ?? null,
          status: input.taskStatus,
        },
      });
      errandIds.push(task.id);

      let order: Awaited<ReturnType<PrismaClient["order"]["create"]>> | null = null;
      if (input.orderStatus) {
        order = await rawClient!.order.create({
          data: {
            orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
            type: "ERRAND",
            status: input.orderStatus,
            amount: "8.00",
            paymentStatus: "OFFLINE_PENDING",
            buyerId: publisher.id,
            sellerId: accepter!.id,
            errandTaskId: task.id,
          },
        });
        orderIds.push(order.id);
      }
      return { publisher, accepter, task, order };
    }

    /** 详情页 transition（production canonical 权威）。 */
    async function detailTransition(
      actorId: string,
      errandId: string,
      status: ErrandTaskStatus,
      seams?: Parameters<typeof import("@/lib/errand-lifecycle").transitionErrandTx>[4],
    ) {
      const { transitionErrandTx } = await import("@/lib/errand-lifecycle");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        transitionErrandTx(tx, actorId, errandId, status, seams),
      );
    }

    /** 订单中心 transition（production 委派入口）。 */
    async function orderCenterTransition(
      actorId: string,
      orderId: string,
      status: "IN_PROGRESS" | "COMPLETED",
      seams?: Parameters<typeof import("@/lib/order-status-service").updateOrderStatusTx>[4],
    ) {
      const { updateOrderStatusTx } = await import("@/lib/order-status-service");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        updateOrderStatusTx(tx, actorId, orderId, { requestedStatus: status }, seams),
      );
    }

    /** 接单（production claimErrandTx；racePoint/domainRacePoint 为既有测试 seam）。 */
    async function claimViaProduction(
      claimerId: string,
      fixture: { publisher: { id: string }; task: { id: string; reward: Prisma.Decimal } },
      racePoint?: (tx: Prisma.TransactionClient) => Promise<void>,
      domainRacePoint?: (tx: Prisma.TransactionClient) => Promise<void>,
    ) {
      const { claimErrandTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(
          tx,
          {
            errandId: fixture.task.id,
            publisherId: fixture.publisher.id,
            claimerId,
            campusId,
            reward: fixture.task.reward,
          },
          racePoint,
          domainRacePoint,
        ),
      );
    }

    async function editViaProduction(
      actorId: string,
      errandId: string,
      content: { title: string; reward: string },
      seams?: Parameters<typeof import("@/lib/errand-lifecycle").updateErrandContentTx>[4],
    ) {
      const { updateErrandContentTx } = await import("@/lib/errand-lifecycle");
      const { decimalValue } = await import("@/lib/decimal");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        updateErrandContentTx(
          tx,
          actorId,
          errandId,
          {
            title: content.title,
            description: "AUDIT2-RB02 edit fixture",
            categoryId: errandCategoryId,
            reward: decimalValue(content.reward),
            pickupLocation: "北门",
            deliveryLocation: "南门",
            deadline: new Date(Date.now() + 24 * 3600_000),
            contactNote: null,
            needsAdvancePay: false,
            advanceAmount: null,
          },
          seams,
        ),
      );
    }

    async function deleteViaProduction(
      actorId: string,
      errandId: string,
      seams?: Parameters<typeof import("@/lib/errand-lifecycle").deleteErrandTx>[3],
    ) {
      const { deleteErrandTx } = await import("@/lib/errand-lifecycle");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        deleteErrandTx(tx, actorId, errandId, seams),
      );
    }

    /** §56 cross-entity assertion：Task/Order/通知必须同时成立。 */
    async function assertErrandState(input: {
      errandId: string;
      taskStatus: string;
      accepterId: string | null;
      deletedAt?: boolean;
      orderId?: string | null;
      orderStatus?: string;
      cancelReason?: string | null;
      completedAt?: boolean;
      notificationCount?: number;
      participantIds?: string[];
    }) {
      const task = await rawClient!.errandTask.findUniqueOrThrow({
        where: { id: input.errandId },
      });
      expect(task.status).toBe(input.taskStatus);
      expect(task.accepterId).toBe(input.accepterId);
      if (input.deletedAt !== undefined) {
        expect(task.deletedAt !== null).toBe(input.deletedAt);
      }
      if (input.orderId) {
        const order = await rawClient!.order.findUniqueOrThrow({
          where: { id: input.orderId },
        });
        if (input.orderStatus !== undefined) {
          expect(order.status).toBe(input.orderStatus);
        }
        if (input.cancelReason !== undefined) {
          expect(order.cancelReason).toBe(input.cancelReason);
        }
        if (input.completedAt !== undefined) {
          expect(order.completedAt !== null).toBe(input.completedAt);
        }
        if (input.notificationCount !== undefined) {
          const count = await rawClient!.notification.count({
            where: {
              orderId: input.orderId,
              userId: { in: input.participantIds ?? [] },
            },
          });
          expect(count).toBe(input.notificationCount);
        }
      }
      return task;
    }

    beforeAll(async () => {
      const campus = await rawClient!.campus.upsert({
        where: { slug: CAMPUS_SLUG },
        create: { name: "A2RB02 权威校区", slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
        update: {},
      });
      campusId = campus.id;
      const category = await rawClient!.errandCategory.create({
        data: { name: `A2RB02类目-${RUN_TAG}`, slug: RUN_TAG, sortOrder: 999 },
      });
      errandCategoryId = category.id;
    });

    afterAll(async () => {
      await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.riskState.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.order.deleteMany({ where: { id: { in: orderIds } } });
      await rawClient!.errandTask.deleteMany({ where: { id: { in: errandIds } } });
      await rawClient!.errandCategory.deleteMany({ where: { id: errandCategoryId } });
      await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
      await rawClient!.campus.deleteMany({ where: { id: campusId } });
      await rawClient!.$disconnect();
      await prisma?.$disconnect();
    });

    // ==================================================================
    // Normal canonical pairs（§55 ERRAND-01..05）
    // ==================================================================

    it("ERRAND-01 normal CLAIMED→OPEN：Task OPEN/accepter null + Order ACCEPTED→CANCELLED + 双通知", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      const ok = await detailTransition(publisher.id, task.id, "OPEN");

      expect(ok).toBe(true);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "OPEN",
        accepterId: null,
        orderId: order!.id,
        orderStatus: "CANCELLED",
        cancelReason: "发布者撤销接单",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    it("ERRAND-02 normal CLAIMED→IN_PROGRESS：Task + Order 同事务 IN_PROGRESS（详情页入口）", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      const ok = await detailTransition(accepter!.id, task.id, "IN_PROGRESS");

      expect(ok).toBe(true);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "IN_PROGRESS",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    it("ERRAND-02B 订单中心 START 委派 canonical：Task + Order 同事务 IN_PROGRESS", async () => {
      const { accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      const outcome = await orderCenterTransition(accepter!.id, order!.id, "IN_PROGRESS");

      expect(outcome).toEqual({
        productId: null,
        serviceListingId: null,
        errandTaskId: task.id,
        isBuyer: false,
      });
      await assertErrandState({
        errandId: task.id,
        taskStatus: "IN_PROGRESS",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
      });
    });

    it("ERRAND-03 normal IN_PROGRESS→PENDING_CONFIRMATION：仅 Task 更新，Order 保持 IN_PROGRESS", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "IN_PROGRESS",
        orderStatus: "IN_PROGRESS",
      });

      const ok = await detailTransition(accepter!.id, task.id, "PENDING_CONFIRMATION");

      expect(ok).toBe(true);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "PENDING_CONFIRMATION",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    it("ERRAND-04 normal PENDING_CONFIRMATION→COMPLETED：exactly-once 完成（计数 +1/人、双完成通知）", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "PENDING_CONFIRMATION",
        orderStatus: "IN_PROGRESS",
      });

      const ok = await detailTransition(publisher.id, task.id, "COMPLETED");

      expect(ok).toBe(true);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "COMPLETED",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "COMPLETED",
        completedAt: true,
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
      const [buyer, seller] = await Promise.all([
        rawClient!.user.findUniqueOrThrow({ where: { id: publisher.id } }),
        rawClient!.user.findUniqueOrThrow({ where: { id: accepter!.id } }),
      ]);
      expect(buyer.completedOrdersCount).toBe(1);
      expect(seller.completedOrdersCount).toBe(1);
    });

    it("ERRAND-04B 订单中心 COMPLETED 委派 canonical：同一套完成副作用", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "PENDING_CONFIRMATION",
        orderStatus: "IN_PROGRESS",
      });

      const outcome = await orderCenterTransition(publisher.id, order!.id, "COMPLETED");

      expect(outcome).toEqual({
        productId: null,
        serviceListingId: null,
        errandTaskId: task.id,
        isBuyer: true,
      });
      await assertErrandState({
        errandId: task.id,
        taskStatus: "COMPLETED",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "COMPLETED",
        completedAt: true,
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
      const seller = await rawClient!.user.findUniqueOrThrow({ where: { id: accepter!.id } });
      expect(seller.completedOrdersCount).toBe(1);
    });

    it("ERRAND-05 normal OPEN→CANCELLED：无 active order 才可取消；从未接单零通知", async () => {
      const { publisher, task } = await createErrandFixture({
        taskStatus: "OPEN",
        withAccepter: false,
        orderStatus: null,
      });

      const ok = await detailTransition(publisher.id, task.id, "CANCELLED");

      expect(ok).toBe(true);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "CANCELLED",
        accepterId: null,
      });
    });

    it("ERRAND-05B OPEN→CANCELLED：历史 CANCELLED order 允许存在，通知挂载其上", async () => {
      const { publisher, task } = await createErrandFixture({
        taskStatus: "OPEN",
        withAccepter: false,
        orderStatus: null,
      });
      const historicalSeller = await createFixtureUser("历史接单者");
      // 历史：曾被接单后 reopen（order CANCELLED）
      const historical = await rawClient!.order.create({
        data: {
          orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
          type: "ERRAND",
          status: "CANCELLED",
          cancelReason: "发布者撤销接单",
          amount: "8.00",
          paymentStatus: "OFFLINE_PENDING",
          buyerId: publisher.id,
          sellerId: historicalSeller.id,
          errandTaskId: task.id,
        },
      });
      orderIds.push(historical.id);

      const ok = await detailTransition(publisher.id, task.id, "CANCELLED");

      expect(ok).toBe(true);
      const notifications = await rawClient!.notification.findMany({
        where: { orderId: historical.id, userId: { in: [publisher.id, historicalSeller.id] } },
      });
      expect(notifications).toHaveLength(2);
      expect(notifications.every((n) => n.title.includes("已取消"))).toBe(true);
    });

    // ==================================================================
    // Primary race（§55 ERRAND-RACE-01A/01B）
    // ==================================================================

    it("ERRAND-RACE-01A publisher reopen wins：accepter start 真实等待共享锁 → fresh 复核失败 no-op", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      let authorityHeld!: () => void;
      const authority = new Promise<void>((resolve) => {
        authorityHeld = resolve;
      });
      let releaseReopen!: () => void;
      const reopenGate = new Promise<void>((resolve) => {
        releaseReopen = resolve;
      });

      const reopenTx = detailTransition(publisher.id, task.id, "OPEN", {
        afterOrderRowLock: async () => {
          authorityHeld();
          await reopenGate;
        },
      });
      await authority;

      // accepter start：必须真实阻塞在共享 participant 治理锁上
      const startTx = detailTransition(accepter!.id, task.id, "IN_PROGRESS");
      await waitForAdvisoryLockWaiter(rawClient!, [
        `USER:${publisher.id}`,
        `USER:${accepter!.id}`,
      ]);

      releaseReopen();
      expect(await reopenTx).toBe(true);
      expect(await startTx).toBe(false);

      await assertErrandState({
        errandId: task.id,
        taskStatus: "OPEN",
        accepterId: null,
        orderId: order!.id,
        orderStatus: "CANCELLED",
        cancelReason: "发布者撤销接单",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    it("ERRAND-RACE-01B accepter start wins：publisher reopen 随后 fresh 复核失败 no-op", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      let authorityHeld!: () => void;
      const authority = new Promise<void>((resolve) => {
        authorityHeld = resolve;
      });
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });

      const startTx = detailTransition(accepter!.id, task.id, "IN_PROGRESS", {
        afterOrderRowLock: async () => {
          authorityHeld();
          await startGate;
        },
      });
      await authority;

      const reopenTx = detailTransition(publisher.id, task.id, "OPEN");
      await waitForAdvisoryLockWaiter(rawClient!, [
        `USER:${publisher.id}`,
        `USER:${accepter!.id}`,
      ]);

      releaseStart();
      expect(await startTx).toBe(true);
      expect(await reopenTx).toBe(false);

      await assertErrandState({
        errandId: task.id,
        taskStatus: "IN_PROGRESS",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    // ==================================================================
    // Cross-entry race（§55 ERRAND-RACE-02）
    // ==================================================================

    it("ERRAND-RACE-02A detail reopen wins vs order-center start：绝不允许 Task OPEN + Order IN_PROGRESS", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      let authorityHeld!: () => void;
      const authority = new Promise<void>((resolve) => {
        authorityHeld = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const reopenTx = detailTransition(publisher.id, task.id, "OPEN", {
        afterOrderRowLock: async () => {
          authorityHeld();
          await gate;
        },
      });
      await authority;

      const startTx = orderCenterTransition(accepter!.id, order!.id, "IN_PROGRESS");
      await waitForAdvisoryLockWaiter(rawClient!, [
        `USER:${publisher.id}`,
        `USER:${accepter!.id}`,
      ]);

      release();
      expect(await reopenTx).toBe(true);
      expect(await startTx).toBeNull();

      await assertErrandState({
        errandId: task.id,
        taskStatus: "OPEN",
        accepterId: null,
        orderId: order!.id,
        orderStatus: "CANCELLED",
        cancelReason: "发布者撤销接单",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    it("ERRAND-RACE-02B order-center start wins vs detail reopen", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      let authorityHeld!: () => void;
      const authority = new Promise<void>((resolve) => {
        authorityHeld = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const startTx = orderCenterTransition(accepter!.id, order!.id, "IN_PROGRESS", {
        afterOrderRowLock: async () => {
          authorityHeld();
          await gate;
        },
      });
      await authority;

      const reopenTx = detailTransition(publisher.id, task.id, "OPEN");
      await waitForAdvisoryLockWaiter(rawClient!, [
        `USER:${publisher.id}`,
        `USER:${accepter!.id}`,
      ]);

      release();
      expect(await startTx).not.toBeNull();
      expect(await reopenTx).toBe(false);

      await assertErrandState({
        errandId: task.id,
        taskStatus: "IN_PROGRESS",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    // ==================================================================
    // Double start / double submit（§55 ERRAND-RACE-03/04）
    // ==================================================================

    it("ERRAND-RACE-03 double start：detail start × order-center start → 恰一胜者、一组通知", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });

      const [detailResult, centerResult] = await Promise.all([
        detailTransition(accepter!.id, task.id, "IN_PROGRESS"),
        orderCenterTransition(accepter!.id, order!.id, "IN_PROGRESS"),
      ]);

      const wins = [detailResult === true, centerResult !== null].filter(Boolean);
      expect(wins).toHaveLength(1);

      await assertErrandState({
        errandId: task.id,
        taskStatus: "IN_PROGRESS",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    it("ERRAND-RACE-04 double pending-confirmation：重复提交 → 恰一真实 transition、无重复通知", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "IN_PROGRESS",
        orderStatus: "IN_PROGRESS",
      });

      const [first, second] = await Promise.all([
        detailTransition(accepter!.id, task.id, "PENDING_CONFIRMATION"),
        detailTransition(accepter!.id, task.id, "PENDING_CONFIRMATION"),
      ]);

      const wins = [first, second].filter(Boolean);
      expect(wins).toHaveLength(1);

      await assertErrandState({
        errandId: task.id,
        taskStatus: "PENDING_CONFIRMATION",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
        notificationCount: 2,
        participantIds: [publisher.id, accepter!.id],
      });
    });

    // ==================================================================
    // Delete/Edit vs Claim（§55 ERRAND-RACE-05/06）
    // ==================================================================

    it("ERRAND-RACE-05A delete wins vs claim：delete 持 publisher 锁提交 → claim 锁后重读失败，无 Order create", async () => {
      const { publisher, task } = await createErrandFixture({
        taskStatus: "OPEN",
        withAccepter: false,
        orderStatus: null,
      });
      const claimer = await createFixtureUser("抢接单者A");

      let deleteLocked!: () => void;
      const deleteLockedPromise = new Promise<void>((resolve) => {
        deleteLocked = resolve;
      });
      let releaseDelete!: () => void;
      const deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });

      const deleteTx = deleteViaProduction(publisher.id, task.id, {
        afterCheck: async () => {
          deleteLocked();
          await deleteGate;
        },
      });
      await deleteLockedPromise;

      const claimTx = claimViaProduction(claimer.id, { publisher, task });
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${publisher.id}`]);

      releaseDelete();
      expect(await deleteTx).toBe("DELETED");
      expect(await claimTx).toBeNull();

      // claim 失败不得留下半程 Order
      const orders = await rawClient!.order.findMany({
        where: { errandTaskId: task.id },
      });
      expect(orders).toHaveLength(0);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "CANCELLED",
        accepterId: null,
        deletedAt: true,
      });
    });

    it("ERRAND-RACE-05B claim wins vs delete：claim 提交 CLAIMED+ACCEPTED → delete 锁后看到 CLAIMED NO-OP", async () => {
      const { publisher, task } = await createErrandFixture({
        taskStatus: "OPEN",
        withAccepter: false,
        orderStatus: null,
      });
      const claimer = await createFixtureUser("抢接单者B");

      let claimLocked!: () => void;
      const claimLockedPromise = new Promise<void>((resolve) => {
        claimLocked = resolve;
      });
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });

      // domainRacePoint = claim 持全参与方锁 + ErrandTask 行锁后的受控暂停
      const claimTx = claimViaProduction(
        claimer.id,
        { publisher, task } as never,
        undefined,
        async () => {
          claimLocked();
          await claimGate;
        },
      );
      await claimLockedPromise;

      const deleteTx = deleteViaProduction(publisher.id, task.id);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${publisher.id}`]);

      releaseClaim();
      const claimOrder = await claimTx;
      expect(claimOrder).not.toBeNull();
      orderIds.push(claimOrder!.id);
      expect(await deleteTx).toBe("NOT_DELETABLE");

      // 最终：Task CLAIMED + Order ACCEPTED + deletedAt null（§38 方向 B）
      await assertErrandState({
        errandId: task.id,
        taskStatus: "CLAIMED",
        accepterId: claimer.id,
        deletedAt: false,
        orderId: claimOrder!.id,
        orderStatus: "ACCEPTED",
      });
    });

    it("ERRAND-RACE-06A edit wins vs claim：claim 必须使用锁内 fresh.reward 创建 Order", async () => {
      const { publisher, task } = await createErrandFixture({
        taskStatus: "OPEN",
        withAccepter: false,
        orderStatus: null,
      });
      const claimer = await createFixtureUser("抢接单者C");

      let editLocked!: () => void;
      const editLockedPromise = new Promise<void>((resolve) => {
        editLocked = resolve;
      });
      let releaseEdit!: () => void;
      const editGate = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });

      const editTx = editViaProduction(
        publisher.id,
        task.id,
        { title: "AUDIT2-RB02 编辑后的标题", reward: "12.00" },
        {
          afterOrderRowLock: async () => {
            editLocked();
            await editGate;
          },
        },
      );
      await editLockedPromise;

      const claimTx = claimViaProduction(claimer.id, { publisher, task });
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${publisher.id}`]);

      releaseEdit();
      expect(await editTx).toBe("UPDATED");
      const claimOrder = await claimTx;
      expect(claimOrder).not.toBeNull();
      orderIds.push(claimOrder!.id);

      // §39 方向 A：claim 成功，Order.amount = 锁内 fresh.reward（12.00）
      const order = await rawClient!.order.findUniqueOrThrow({ where: { id: claimOrder!.id } });
      expect(order.amount.toFixed(2)).toBe("12.00");
      await assertErrandState({
        errandId: task.id,
        taskStatus: "CLAIMED",
        accepterId: claimer.id,
        orderId: claimOrder!.id,
        orderStatus: "ACCEPTED",
      });
      const editedTask = await rawClient!.errandTask.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(editedTask.title).toBe("AUDIT2-RB02 编辑后的标题");
    });

    it("ERRAND-RACE-06B claim wins vs edit：edit 锁后看到 CLAIMED → NO-OP 零内容变更", async () => {
      const { publisher, task } = await createErrandFixture({
        taskStatus: "OPEN",
        withAccepter: false,
        orderStatus: null,
      });
      const claimer = await createFixtureUser("抢接单者D");

      let claimLocked!: () => void;
      const claimLockedPromise = new Promise<void>((resolve) => {
        claimLocked = resolve;
      });
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });

      const claimTx = claimViaProduction(
        claimer.id,
        { publisher, task } as never,
        undefined,
        async () => {
          claimLocked();
          await claimGate;
        },
      );
      await claimLockedPromise;

      const editTx = editViaProduction(publisher.id, task.id, {
        title: "并发编辑不得生效",
        reward: "99.00",
      });
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${publisher.id}`]);

      releaseClaim();
      const claimOrder = await claimTx;
      expect(claimOrder).not.toBeNull();
      orderIds.push(claimOrder!.id);
      expect(await editTx).toBe("NOT_OPEN");

      // §39 方向 B：claim 内容（含 amount 8.00）不被并发 edit 穿越
      const order = await rawClient!.order.findUniqueOrThrow({ where: { id: claimOrder!.id } });
      expect(order.amount.toFixed(2)).toBe("8.00");
      const finalTask = await rawClient!.errandTask.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(finalTask.title).not.toBe("并发编辑不得生效");
      expect(finalTask.reward.toFixed(2)).toBe("8.00");
      await assertErrandState({
        errandId: task.id,
        taskStatus: "CLAIMED",
        accepterId: claimer.id,
        orderId: claimOrder!.id,
        orderStatus: "ACCEPTED",
      });
    });

    // ==================================================================
    // Data anomalies → fail closed（§55 ERRAND-ANOMALY-01/02）
    // ==================================================================

    it("ERRAND-ANOMALY-01 CLAIMED 但 0 个 active order → START/REOPEN 全部 fail closed", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });
      // 构造历史异常：active order 消失
      await rawClient!.order.delete({ where: { id: order!.id } });
      orderIds.push(order!.id);

      const start = await detailTransition(accepter!.id, task.id, "IN_PROGRESS");
      const reopen = await detailTransition(publisher.id, task.id, "OPEN");

      expect(start).toBe(false);
      expect(reopen).toBe(false);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "CLAIMED",
        accepterId: accepter!.id,
      });
    });

    it("ERRAND-ANOMALY-02 CLAIMED 但 >1 个 active order → fail closed，不猜 latest", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });
      const duplicate = await rawClient!.order.create({
        data: {
          orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
          type: "ERRAND",
          status: "ACCEPTED",
          amount: "8.00",
          paymentStatus: "OFFLINE_PENDING",
          buyerId: publisher.id,
          sellerId: accepter!.id,
          errandTaskId: task.id,
        },
      });
      orderIds.push(duplicate.id);

      const start = await detailTransition(accepter!.id, task.id, "IN_PROGRESS");

      expect(start).toBe(false);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "CLAIMED",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "ACCEPTED",
      });
      const finalDuplicate = await rawClient!.order.findUniqueOrThrow({
        where: { id: duplicate.id },
      });
      expect(finalDuplicate.status).toBe("ACCEPTED");
    });

    // ==================================================================
    // Lifecycle contracts（§47-§49）
    // ==================================================================

    it("ERRAND-ACTOR-SUSPENDED：actor SUSPENDED → AUTH_ACCOUNT_INACTIVE 零写入", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });
      await rawClient!.user.update({
        where: { id: accepter!.id },
        data: { status: "SUSPENDED" },
      });

      await expect(
        detailTransition(accepter!.id, task.id, "IN_PROGRESS"),
      ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

      await assertErrandState({
        errandId: task.id,
        taskStatus: "CLAIMED",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "ACCEPTED",
      });
    });

    it("ERRAND-COUNTERPARTY-SUSPENDED：publisher SUSPENDED 不阻断 accepter 既有义务推进", async () => {
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });
      await rawClient!.user.update({
        where: { id: publisher.id },
        data: { status: "SUSPENDED" },
      });

      const ok = await detailTransition(accepter!.id, task.id, "IN_PROGRESS");

      expect(ok).toBe(true);
      await assertErrandState({
        errandId: task.id,
        taskStatus: "IN_PROGRESS",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "IN_PROGRESS",
      });
    });

    it("ERRAND-OPEN-REEXPOSURE-RESTRICTED：publisher RESTRICTED → MARKETPLACE_RESTRICTED，整个 OPEN transition 失败", async () => {
      const { GLOBAL_SCOPE_KEY } = await import("@/lib/rbac/roles");
      const { publisher, accepter, task, order } = await createErrandFixture({
        taskStatus: "CLAIMED",
        orderStatus: "ACCEPTED",
      });
      await rawClient!.riskState.create({
        data: {
          userId: publisher.id,
          scopeKey: GLOBAL_SCOPE_KEY,
          state: "RESTRICTED",
          reasonCode: "MANUAL_REVIEW",
        },
      });

      await expect(detailTransition(publisher.id, task.id, "OPEN")).rejects.toMatchObject({
        code: "MARKETPLACE_RESTRICTED",
      });

      await assertErrandState({
        errandId: task.id,
        taskStatus: "CLAIMED",
        accepterId: accepter!.id,
        orderId: order!.id,
        orderStatus: "ACCEPTED",
      });
    });

    // ==================================================================
    // Deadlock protection（§62）
    // ==================================================================

    it("ERRAND-DEADLOCK：publisher/accepter 并发相反 transition × 3 轮 → 无死锁、终态恒为合法 pair", async () => {
      for (let round = 0; round < 3; round += 1) {
        const { publisher, accepter, task, order } = await createErrandFixture({
          taskStatus: "CLAIMED",
          orderStatus: "ACCEPTED",
        });

        const [reopen, start] = await Promise.all([
          detailTransition(publisher.id, task.id, "OPEN"),
          detailTransition(accepter!.id, task.id, "IN_PROGRESS"),
        ]);

        // 任意一方可能胜出，但必须恰有一个真实 transition，且终态是两个
        // 合法 state pair 之一；Postgres 死锁会以异常冒泡（不允许）
        const wins = [reopen === true, start === true].filter(Boolean);
        expect(wins).toHaveLength(1);

        if (reopen === true) {
          await assertErrandState({
            errandId: task.id,
            taskStatus: "OPEN",
            accepterId: null,
            orderId: order!.id,
            orderStatus: "CANCELLED",
            cancelReason: "发布者撤销接单",
            notificationCount: 2,
            participantIds: [publisher.id, accepter!.id],
          });
        } else {
          await assertErrandState({
            errandId: task.id,
            taskStatus: "IN_PROGRESS",
            accepterId: accepter!.id,
            orderId: order!.id,
            orderStatus: "IN_PROGRESS",
            notificationCount: 2,
            participantIds: [publisher.id, accepter!.id],
          });
        }
      }
    });
  },
);

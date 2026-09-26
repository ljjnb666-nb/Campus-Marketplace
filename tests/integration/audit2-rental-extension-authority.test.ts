import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma, type RentalOrderStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUDIT2-RB03：RENTAL EXTENSION AUTHORITY CLOSURE 真实 PostgreSQL 集成验证。
 *
 * 冻结不变量（directive §8）：RentalExtension 是 existing obligation
 * modification，不是独立于 RentalOrder 的第二套 authority。request/approve/
 * reject 全部以 fresh locked RentalOrder 为基础：
 *
 *   sorted {USER:owner, USER:renter} advisory locks
 *   → RentalOrder FOR UPDATE
 *   → RentalListing FOR UPDATE（approve/request capacity authority，
 *     与 createRentalOrderTx 同一 mutex）
 *   → RentalExtensionRequest FOR UPDATE（approve/reject）
 *   → predicates / capacity reads → writes
 *
 * 竞态全部使用 Promise barrier + advisory-lock waiter 证据
 * （waitForAdvisoryLockWaiter；SLEEP_ORDERING = 0），全部走 production
 * requestExtensionTx / approveExtensionTx / rejectExtensionTx /
 * requestReturnTx / createRentalOrderTx，禁止 mock-only。
 *
 * 会计合同（§35-§37/§67）：approve 后 endTime = ext.newEndTime、
 * rentalDuration = calculateRentalDuration(startTime→newEnd)、
 * rentalAmount 与 finalAmount 各恰好增加 expectedAdditionalFee 一次。
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

const RUN_TAG = `a2rb03-${randomUUID().slice(0, 8)}`;
// 校区按稳定 slug 复用且 teardown 不删除（同 RB02 集成文件的理由：
// 避免干扰其他文件的全局 campus.count() 断言窗口）
const CAMPUS_SLUG = "rb03-extension-it-campus";

const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");

// 时间轴（PER_DAY 计价，整除无余数）：
//   T0 = +1d（订单开始）  T1 = T0+2d（初始 endTime，rentalDuration=2）
//   T2 = T1+2d            T3 = T2+2d
const DAY = 24 * 3600_000;
const T0 = new Date(Date.now() + 1 * DAY);
const T1 = new Date(T0.getTime() + 2 * DAY);
const T2 = new Date(T1.getTime() + 2 * DAY);
const T3 = new Date(T2.getTime() + 2 * DAY);

describe.skipIf(!integrationDatabaseUrl)(
  "AUDIT2-RB03 rental extension authority (real PostgreSQL)",
  () => {
    let campusId = "";
    let categoryId = "";
    const userIds: string[] = [];
    const listingIds: string[] = [];
    const orderIds: string[] = [];
    let orderNumberSeq = 0;

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

    async function createFixtureListing(totalQuantity: number, maximumDuration = 30) {
      const listing = await rawClient!.rentalListing.create({
        data: {
          title: `RB03 续租 ${randomUUID().slice(0, 6)}`,
          description: "AUDIT2-RB03 extension authority fixture",
          condition: "NEW",
          price: "20.00",
          pricingUnit: "PER_DAY",
          depositAmount: "50.00",
          minimumDuration: 1,
          maximumDuration,
          totalQuantity,
          availableQuantity: totalQuantity,
          pickupLocation: "南门",
          returnLocation: "南门",
          status: "AVAILABLE",
          ownerId: owner.id,
          campusId,
          categoryId,
        },
      });
      listingIds.push(listing.id);
      return listing;
    }

    function nextOrderNumber() {
      orderNumberSeq += 1;
      return `${RUN_TAG}-${orderNumberSeq}`;
    }

    async function createFixtureOrder(input: {
      listingId: string;
      renterId: string;
      status: RentalOrderStatus;
      startTime?: Date;
      endTime?: Date;
      quantity?: number;
      rentalDuration?: number;
    }) {
      const startTime = input.startTime ?? T0;
      const endTime = input.endTime ?? T1;
      const rentalAmount = "40.00";
      const order = await rawClient!.rentalOrder.create({
        data: {
          orderNumber: nextOrderNumber(),
          rentalListingId: input.listingId,
          ownerId: owner.id,
          renterId: input.renterId,
          startTime,
          endTime,
          quantity: input.quantity ?? 1,
          unitPriceSnapshot: "20.00",
          pricingUnitSnapshot: "PER_DAY",
          rentalDuration: input.rentalDuration ?? 2,
          rentalAmount,
          depositAmount: "50.00",
          finalAmount: "90.00",
          paymentStatus: "OFFLINE_PENDING",
          depositStatus: "NOT_REQUIRED",
          status: input.status,
          pickupLocationSnapshot: "南门",
          returnLocationSnapshot: "南门",
        },
      });
      orderIds.push(order.id);
      return order;
    }

    /** 历史 anomaly fixture（§18/§51：绕过 production writer 直造 PENDING 行）。 */
    async function createPendingExtension(input: {
      orderId: string;
      newEndTime: Date;
      additionalFee?: string;
    }) {
      return rawClient!.rentalExtensionRequest.create({
        data: {
          orderId: input.orderId,
          requesterId: (await rawClient!.rentalOrder.findUniqueOrThrow({
            where: { id: input.orderId },
            select: { renterId: true },
          })).renterId,
          newEndTime: input.newEndTime,
          additionalFee: input.additionalFee ?? "40.00",
          status: "PENDING",
        },
      });
    }

    // ---- production 入口（真实事务封装，禁止 mock）----

    async function requestViaProduction(
      renterId: string,
      orderId: string,
      newEndTime: Date,
      seams?: Parameters<typeof import("@/lib/rental-order-machine").requestExtensionTx>[2],
    ) {
      const { requestExtensionTx } = await import("@/lib/rental-order-machine");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        requestExtensionTx(tx, { orderId, userId: renterId, newEndTime }, seams),
      );
    }

    async function approveViaProduction(
      ownerId: string,
      extensionRequestId: string,
      racePoint?: Parameters<typeof import("@/lib/rental-order-machine").approveExtensionTx>[2],
    ) {
      const { approveExtensionTx } = await import("@/lib/rental-order-machine");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        approveExtensionTx(tx, { extensionRequestId, userId: ownerId }, racePoint),
      );
    }

    async function rejectViaProduction(
      ownerId: string,
      extensionRequestId: string,
      racePoint?: Parameters<typeof import("@/lib/rental-order-machine").rejectExtensionTx>[2],
    ) {
      const { rejectExtensionTx } = await import("@/lib/rental-order-machine");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        rejectExtensionTx(tx, { extensionRequestId, userId: ownerId }, racePoint),
      );
    }

    async function returnViaProduction(
      renterId: string,
      orderId: string,
      seams?: Parameters<typeof import("@/lib/rental-order-machine").requestReturnTx>[2],
    ) {
      const { requestReturnTx } = await import("@/lib/rental-order-machine");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        requestReturnTx(tx, { orderId, userId: renterId }, seams),
      );
    }

    async function createOrderViaProduction(
      renterId: string,
      listingId: string,
      interval: { startTime: Date; endTime: Date },
      domainRacePoint?: (tx: Prisma.TransactionClient) => Promise<void>,
    ) {
      const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        createRentalOrderTx(
          tx,
          {
            userId: renterId,
            rentalListingId: listingId,
            startTime: interval.startTime,
            endTime: interval.endTime,
            quantity: 1,
          },
          undefined,
          domainRacePoint,
        ),
      );
    }

    // ---- 状态断言（order + extension + 通知同时核对）----

    async function readOrder(orderId: string) {
      return rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: orderId } });
    }

    async function readExtension(extensionRequestId: string) {
      return rawClient!.rentalExtensionRequest.findUniqueOrThrow({
        where: { id: extensionRequestId },
      });
    }

    async function notificationCount(input: { userId: string; title: string }) {
      return rawClient!.notification.count({
        where: { userId: input.userId, title: input.title },
      });
    }

    let owner: { id: string };
    let renterA: { id: string };
    let renterB: { id: string };

    // 通知断言以"当前用例"为单位：用户跨用例复用，先清空再断言绝对数量
    beforeEach(async () => {
      await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
    });

    beforeAll(async () => {
      const campus = await rawClient!.campus.upsert({
        where: { slug: CAMPUS_SLUG },
        create: { name: "RB03 续租集成校区", slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
        update: {},
      });
      campusId = campus.id;
      const category = await rawClient!.rentalCategory.create({
        data: { name: `RB03类目-${RUN_TAG}`, slug: RUN_TAG },
      });
      categoryId = category.id;
      owner = await createFixtureUser("RB03 出租者");
      renterA = await createFixtureUser("RB03 租客A");
      renterB = await createFixtureUser("RB03 租客B");
    });

    afterAll(async () => {
      // RentalExtensionRequest / RentalOrderStatusLog 随 RentalOrder 级联删除
      await rawClient!.rentalOrder.deleteMany({ where: { rentalListingId: { in: listingIds } } });
      await rawClient!.rentalListing.deleteMany({ where: { id: { in: listingIds } } });
      await rawClient!.rentalCategory.deleteMany({ where: { id: categoryId } });
      await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
      // 不删除 Campus 行（稳定 slug 复用，见 CAMPUS_SLUG 注释）
      await rawClient!.$disconnect();
      await prisma?.$disconnect();
    });

    // ============================================================
    // EXT-01 normal request
    // ============================================================
    it("EXT-01 normal request：PENDING 行 + snapshot 计价 fee=40 + owner 通知 1 条", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });

      const result = await requestViaProduction(renterA.id, order.id, T2);

      expect(result).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(ext.status).toBe("PENDING");
      expect(ext.requesterId).toBe(renterA.id);
      expect(ext.newEndTime.getTime()).toBe(T2.getTime());
      expect(ext.additionalFee.toString()).toBe("40"); // 2 天 × 20，基于订单 price snapshot
      // 订单零变更
      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
      expect(await notificationCount({ userId: owner.id, title: "收到续租请求" })).toBe(1);
    });

    // ============================================================
    // EXT-02 double request：barrier 证明锁内 single-PENDING
    // ============================================================
    it("EXT-02 double request：并发双请求恰好一个 PENDING，另一个稳定业务错误", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });

      // T1 持完整 participant 锁挂起（afterCheck seam，生产不传）
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = requestViaProduction(renterA.id, order.id, T2, {
        afterCheck: async () => {
          signalT1Locked();
          await t1Gate;
        },
      });
      await t1Locked;

      // T2 同订单并发提交：必须阻塞在 participant locks 上（真实 waiter 证据）
      const promiseT2 = requestViaProduction(renterA.id, order.id, T2).catch((e: unknown) => e);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterA.id}`]);

      releaseT1();
      const [resultT1, resultT2] = await Promise.all([promiseT1, promiseT2]);

      expect(resultT1).toEqual({ success: true });
      expect(resultT2).toEqual({ error: "已有待处理的续租请求" });

      const pendingRows = await rawClient!.rentalExtensionRequest.findMany({
        where: { orderId: order.id, status: "PENDING" },
      });
      expect(pendingRows).toHaveLength(1);
      expect(await rawClient!.rentalExtensionRequest.count({ where: { orderId: order.id } })).toBe(1);
    });

    // ============================================================
    // EXT-03 normal approve：§67 全量会计断言
    // ============================================================
    it("EXT-03 normal approve：endTime/duration/rentalAmount/finalAmount/ext/通知 全量一致", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      expect(await approveViaProduction(owner.id, ext.id)).toEqual({ success: true });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T2.getTime()); // oldEnd T1 → newEnd T2
      expect(finalOrder.rentalDuration).toBe(4); // T0 → T2 重算（不是 +2 的粗糙累加恰好也为 4）
      expect(finalOrder.rentalAmount.toString()).toBe("80"); // 40 + 40
      expect(finalOrder.finalAmount.toString()).toBe("130"); // 90 + 40
      // 押金/手续费/逾期费/扣押不被触碰
      expect(finalOrder.depositAmount.toString()).toBe("50");
      expect(finalOrder.serviceFee.toString()).toBe("0");
      expect(finalOrder.overdueFee.toString()).toBe("0");
      expect(finalOrder.depositDeduction.toString()).toBe("0");

      expect((await readExtension(ext.id)).status).toBe("APPROVED");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(1);

      const logs = await rawClient!.rentalOrderStatusLog.findMany({
        where: { orderId: order.id, note: { contains: "同意续租" } },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.fromStatus).toBe("IN_RENTAL");
      expect(logs[0]!.toStatus).toBe("IN_RENTAL"); // §38 same-status domain event
    });

    // ============================================================
    // EXT-04 double approve：exactly once
    // ============================================================
    it("EXT-04 double approve：双击批准金额/时长/通知各恰好一次", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      // T1 通过全部校验后挂起（racePoint，持全部锁）
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = approveViaProduction(owner.id, ext.id, async () => {
        signalT1Locked();
        await t1Gate;
      });
      await t1Locked;

      // T2 同一 extension 双击批准：阻塞于 participant locks
      const promiseT2 = approveViaProduction(owner.id, ext.id).catch((e: unknown) => e);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterA.id}`]);

      releaseT1();
      const [resultT1, resultT2] = await Promise.all([promiseT1, promiseT2]);

      expect(resultT1).toEqual({ success: true });
      expect(resultT2).toEqual({ error: "无效请求" });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T2.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("80"); // 恰 +40，不是 +80
      expect(finalOrder.finalAmount.toString()).toBe("130"); // 恰 +40，不是 +80
      expect(finalOrder.rentalDuration).toBe(4);
      expect((await readExtension(ext.id)).status).toBe("APPROVED");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(1);
    });

    // ============================================================
    // EXT-05 approve vs reject：单胜者
    // ============================================================
    it("EXT-05 approve vs reject：同一 extension 单胜者，通知恰一条", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      let signalApproveLocked!: () => void;
      const approveLocked = new Promise<void>((resolve) => {
        signalApproveLocked = resolve;
      });
      let releaseApprove!: () => void;
      const approveGate = new Promise<void>((resolve) => {
        releaseApprove = resolve;
      });
      const promiseApprove = approveViaProduction(owner.id, ext.id, async () => {
        signalApproveLocked();
        await approveGate;
      });
      await approveLocked;

      const promiseReject = rejectViaProduction(owner.id, ext.id).catch((e: unknown) => e);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterA.id}`]);

      releaseApprove();
      const [approveResult, rejectResult] = await Promise.all([promiseApprove, promiseReject]);

      expect(approveResult).toEqual({ success: true });
      expect(rejectResult).toEqual({ error: "无效请求" });

      expect((await readExtension(ext.id)).status).toBe("APPROVED");
      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T2.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("80");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(1);
      expect(await notificationCount({ userId: renterA.id, title: "续租请求被拒绝" })).toBe(0);
    });

    // ============================================================
    // EXT-06A approve wins vs requestReturn（合法线性化）
    // ============================================================
    it("EXT-06A approve wins vs requestReturn：先批准后归还 → PENDING_RETURN + 续租生效", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      let signalApproveLocked!: () => void;
      const approveLocked = new Promise<void>((resolve) => {
        signalApproveLocked = resolve;
      });
      let releaseApprove!: () => void;
      const approveGate = new Promise<void>((resolve) => {
        releaseApprove = resolve;
      });
      const promiseApprove = approveViaProduction(owner.id, ext.id, async () => {
        signalApproveLocked();
        await approveGate;
      });
      await approveLocked;

      // requestReturn 无 seam：必须等待 USER:renter（被 approve 的参与方锁持有）
      const promiseReturn = returnViaProduction(renterA.id, order.id).catch((e: unknown) => e);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterA.id}`]);

      releaseApprove();
      const [approveResult, returnResult] = await Promise.all([promiseApprove, promiseReturn]);

      expect(approveResult).toEqual({ success: true });
      expect(returnResult).toEqual({ success: true });

      // 合法线性结果：extension 发生在 return 之前——续租生效且订单进入归还
      const finalOrder = await readOrder(order.id);
      expect(finalOrder.status).toBe("PENDING_RETURN");
      expect(finalOrder.endTime.getTime()).toBe(T2.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("80");
      expect(finalOrder.finalAmount.toString()).toBe("130");
      expect((await readExtension(ext.id)).status).toBe("APPROVED");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(1);
    });

    // ============================================================
    // EXT-06B requestReturn wins vs approve（本轮核心真实 race 关闭证明）
    // ============================================================
    it("EXT-06B requestReturn wins vs approve：先归还 → approve 见 PENDING_RETURN 拒绝，extension 保持 PENDING 零变更", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      // T1 requestReturn：active-check 后持 USER:renter 挂起（§48 允许的 seam）
      let signalReturnLocked!: () => void;
      const returnLocked = new Promise<void>((resolve) => {
        signalReturnLocked = resolve;
      });
      let releaseReturn!: () => void;
      const returnGate = new Promise<void>((resolve) => {
        releaseReturn = resolve;
      });
      const promiseReturn = returnViaProduction(renterA.id, order.id, {
        afterCheck: async () => {
          signalReturnLocked();
          await returnGate;
        },
      });
      await returnLocked;

      // T2 approve：尝试完整 participant locks，必须等待 renter 锁
      const promiseApprove = approveViaProduction(owner.id, ext.id).catch((e: unknown) => e);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterA.id}`]);

      releaseReturn();
      const [returnResult, approveResult] = await Promise.all([promiseReturn, promiseApprove]);

      expect(returnResult).toEqual({ success: true });
      expect(approveResult).toEqual({ error: "订单状态已变化，无法续租" });

      // 最终：Order PENDING_RETURN，extension 仍 PENDING，金额/endTime 不变
      const finalOrder = await readOrder(order.id);
      expect(finalOrder.status).toBe("PENDING_RETURN");
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
      expect(finalOrder.rentalDuration).toBe(2);
      expect((await readExtension(ext.id)).status).toBe("PENDING");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(0);
      expect(await notificationCount({ userId: owner.id, title: "租客请求归还" })).toBe(1);
    });

    // ============================================================
    // EXT-07 / EXT-08 fresh order status gate（静态形态）
    // ============================================================
    it.each(["PENDING_RETURN", "IN_DISPUTE"] as const)(
      "EXT-07/08 order %s → approve blocked，extension 保持 PENDING 零变更",
      async (status) => {
        const listing = await createFixtureListing(1);
        const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status });
        const ext = await createPendingExtension({ orderId: order.id, newEndTime: T2 });

        expect(await approveViaProduction(owner.id, ext.id)).toEqual({
          error: "订单状态已变化，无法续租",
        });

        const finalOrder = await readOrder(order.id);
        expect(finalOrder.status).toBe(status);
        expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
        expect(finalOrder.rentalAmount.toString()).toBe("40");
        expect(finalOrder.finalAmount.toString()).toBe("90");
        expect((await readExtension(ext.id)).status).toBe("PENDING");
        expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(0);
      },
    );

    // ============================================================
    // EXT-09 historical double PENDING：approve FAIL CLOSED，reject 逐个清理
    // ============================================================
    it("EXT-09 historical double PENDING → approve fail closed；reject B 后仅剩 A", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      const extA = await createPendingExtension({ orderId: order.id, newEndTime: T2 });
      const extB = await createPendingExtension({ orderId: order.id, newEndTime: T3 });

      // 不猜 latest/earliest/最大 newEndTime——直接 FAIL CLOSED，零变更
      expect(await approveViaProduction(owner.id, extA.id)).toEqual({
        error: "存在多个待处理的续租请求，请先逐个拒绝后再审批",
      });
      let finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
      expect((await readExtension(extA.id)).status).toBe("PENDING");

      // owner 可逐个 REJECT 清理历史 anomaly（不自动篡改数据）
      expect(await rejectViaProduction(owner.id, extB.id)).toEqual({ success: true });
      expect((await readExtension(extB.id)).status).toBe("REJECTED");
      expect(
        await rawClient!.rentalExtensionRequest.count({ where: { orderId: order.id, status: "PENDING" } }),
      ).toBe(1);
      expect((await readExtension(extA.id)).status).toBe("PENDING");
      finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(await notificationCount({ userId: renterA.id, title: "续租请求被拒绝" })).toBe(1);
    });

    // ============================================================
    // EXT-10 backward end time
    // ============================================================
    it("EXT-10 backward end time → STALE 拒绝，绝不缩短订单", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      const staleExt = await createPendingExtension({
        orderId: order.id,
        newEndTime: new Date(T1.getTime() - 1 * DAY), // 早于当前 endTime（Day-1）
        additionalFee: "40.00",
      });

      expect(await approveViaProduction(owner.id, staleExt.id)).toEqual({
        error: "续租请求已过期，请重新提交续租",
      });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
      expect((await readExtension(staleExt.id)).status).toBe("PENDING");
    });

    // ============================================================
    // EXT-11 stale fee
    // ============================================================
    it("EXT-11 stale fee → FAIL CLOSED，金额零写", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      // fee 与 fresh 计价（T1→T2 = 2 天 × 20 = 40）不一致
      const staleFeeExt = await createPendingExtension({
        orderId: order.id,
        newEndTime: T2,
        additionalFee: "20.00",
      });

      expect(await approveViaProduction(owner.id, staleFeeExt.id)).toEqual({
        error: "续租费用已变化，请重新提交续租",
      });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
      expect((await readExtension(staleFeeExt.id)).status).toBe("PENDING");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(0);
    });

    // ============================================================
    // EXT-12 unavailable period（request 阶段）
    // ============================================================
    it("EXT-12 unavailable period 命中增量区间 → request 拒绝，零 extension 行", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      await rawClient!.rentalUnavailablePeriod.create({
        data: {
          rentalListingId: listing.id,
          startDate: new Date(T1.getTime() + 6 * 3600_000),
          endDate: new Date(T1.getTime() + 12 * 3600_000),
          reason: "RB03 fixture 维护窗口",
        },
      });

      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({
        error: "该时间段已被标记为不可租",
      });
      expect(await rawClient!.rentalExtensionRequest.count({ where: { orderId: order.id } })).toBe(0);
    });

    // ============================================================
    // EXT-13 unavailable period（approve 阶段重检）
    // ============================================================
    it("EXT-13 unavailable period 批准阶段重检 → 拒绝，extension 保持 PENDING", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      // request 之后、approve 之前插入不可租区间（历史 PENDING 仍必须重检）
      await rawClient!.rentalUnavailablePeriod.create({
        data: {
          rentalListingId: listing.id,
          startDate: new Date(T1.getTime() + 3 * 3600_000),
          endDate: new Date(T1.getTime() + 5 * 3600_000),
        },
      });

      expect(await approveViaProduction(owner.id, ext.id)).toEqual({
        error: "该时间段已被标记为不可租",
      });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect((await readExtension(ext.id)).status).toBe("PENDING");
    });

    // ============================================================
    // EXT-14 capacity conflict（approve 阶段）
    // ============================================================
    it("EXT-14 capacity conflict → 库存不足，extension 保持 PENDING 零变更", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      // 其它订单（renterB）占用 extension 增量区间 → totalQuantity=1 已满
      const blockingOrder = await createFixtureOrder({
        listingId: listing.id,
        renterId: renterB.id,
        status: "PENDING_APPROVAL",
        startTime: new Date(T1.getTime() + 1 * 3600_000),
        endTime: new Date(T2.getTime() - 1 * 3600_000),
      });

      expect(await approveViaProduction(owner.id, ext.id)).toEqual({ error: "续租时间段库存不足" });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
      expect((await readExtension(ext.id)).status).toBe("PENDING");
      expect(await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: blockingOrder.id } })).toBeTruthy();
    });

    // ============================================================
    // EXT-15 consecutive extensions：增量计价不重复收费
    // ============================================================
    it("EXT-15 consecutive A→B：B 基于 A 后 fresh endTime 计价，费用只算增量", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });

      // Extension A：T1 → T2（fee 40）
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const extA = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });
      expect(await approveViaProduction(owner.id, extA.id)).toEqual({ success: true });

      // Extension B：A 批准后基于 fresh endTime（T2）→ T3；fee 只算 T2→T3 增量
      expect(await requestViaProduction(renterA.id, order.id, T3)).toEqual({ success: true });
      const extB = await rawClient!.rentalExtensionRequest.findFirstOrThrow({
        where: { orderId: order.id, status: "PENDING" },
      });
      expect(extB.id).not.toBe(extA.id);
      expect(extB.additionalFee.toString()).toBe("40"); // T2→T3 = 2 天 × 20，绝不包含 T1→T2

      expect(await approveViaProduction(owner.id, extB.id)).toEqual({ success: true });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T3.getTime());
      expect(finalOrder.rentalDuration).toBe(6); // T0 → T3 重算
      expect(finalOrder.rentalAmount.toString()).toBe("120"); // 40 + 40 + 40（无重复计费）
      expect(finalOrder.finalAmount.toString()).toBe("170"); // 90 + 40 + 40
      expect((await readExtension(extA.id)).status).toBe("APPROVED");
      expect((await readExtension(extB.id)).status).toBe("APPROVED");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(2);
    });

    // ============================================================
    // EXT-16A approve × new order：approve wins（RB04 共享 owner 锁 + listing 行锁回归）
    // ============================================================
    it("EXT-16A approve × new order：approve 持锁期间新订单阻塞，容量永不超卖", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      // approve 持 participant 锁 + listing 行锁挂起
      let releaseApprove!: () => void;
      const approveGate = new Promise<void>((resolve) => {
        releaseApprove = resolve;
      });
      const promiseApprove = approveViaProduction(owner.id, ext.id, async () => {
        await approveGate;
      });

      // renterB 并发创建与增量区间重叠的新订单：必须等待共享 USER:owner
      const promiseCreate = createOrderViaProduction(renterB.id, listing.id, {
        startTime: new Date(T1.getTime() + 1 * 3600_000),
        endTime: new Date(T2.getTime() - 1 * 3600_000),
      }).catch((e: unknown) => e);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterB.id}`]);

      releaseApprove();
      const [approveResult, createResult] = await Promise.all([promiseApprove, promiseCreate]);

      expect(approveResult).toEqual({ success: true });
      // 串行化结果：approve 先提交 → 新订单容量复算拒绝（业务错误，非 DB 异常）
      expect(createResult).toEqual({ error: "该时间段已被预订，库存不足" });

      const orders = await rawClient!.rentalOrder.findMany({ where: { rentalListingId: listing.id } });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.quantity).toBeLessThanOrEqual(1);
      expect((await readExtension(ext.id)).status).toBe("APPROVED");
      expect((await readOrder(order.id)).endTime.getTime()).toBe(T2.getTime());
    });

    // ============================================================
    // EXT-16B approve × new order：create wins（反向串行，extension 保持 PENDING）
    // ============================================================
    it("EXT-16B new order × approve：create 持锁期间 approve 阻塞，approve 复算容量失败", async () => {
      const listing = await createFixtureListing(1);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({ where: { orderId: order.id } });

      // create 在 RentalListing FOR UPDATE 后挂起（production domainRacePoint seam）
      let releaseCreate!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      const promiseCreate = createOrderViaProduction(
        renterB.id,
        listing.id,
        {
          startTime: new Date(T1.getTime() + 1 * 3600_000),
          endTime: new Date(T2.getTime() - 1 * 3600_000),
        },
        async () => {
          await createGate;
        },
      );
      await vi.waitFor(async () => {
        // domainRacePoint 无锁等待可观测（create 此时已持锁）：以 pg_locks 上
        // create 事务已 GRANTED 的 participant advisory 键作为 barrier 证据
        const advisory = await rawClient!.$queryRaw<{ objid: number }[]>`
          SELECT locks.objid
          FROM pg_locks locks
          WHERE locks.locktype = 'advisory'
            AND locks.granted
            AND locks.classid = ${730_501}::int
            AND EXISTS (
              SELECT 1
              FROM unnest(${[`USER:${owner.id}`, `USER:${renterB.id}`]}::text[]) AS expected(key)
              WHERE hashtext(expected.key)::bit(32)::bigint = locks.objid
            )
        `;
        expect(advisory.length).toBeGreaterThan(0);
      }, { timeout: 15_000, interval: 20 });

      // approve 并发发起：必须阻塞在共享 USER:owner 锁上
      const promiseApprove = approveViaProduction(owner.id, ext.id).catch((e: unknown) => e);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterA.id}`]);

      releaseCreate();
      const [createResult, approveResult] = await Promise.all([promiseCreate, promiseApprove]);

      expect(createResult).toEqual({ orderId: expect.any(String) });
      // create 先提交 → approve 阶段 capacity 重检失败，extension 保持 PENDING
      expect(approveResult).toEqual({ error: "续租时间段库存不足" });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect((await readExtension(ext.id)).status).toBe("PENDING");
      // 容量不变量：totalQuantity=1，活跃重叠订单 quantity 总和 ≤ 1
      const orders = await rawClient!.rentalOrder.findMany({ where: { rentalListingId: listing.id } });
      expect(orders).toHaveLength(2);
      expect(orders.reduce((sum, o) => sum + o.quantity, 0)).toBe(2); // 时间不重叠：T0-T1 与 T1+1h-T2-1h
    });

    // ============================================================
    // AUDIT2-RB03 EXTERNAL REVIEW FIX：maximumDuration 总租期合同
    // （maximumDuration 约束 startTime → proposed endTime 的最大总租期，
    // request 与 approve 都以 locked listing 现势值为 authority）
    // ============================================================

    it("EXT-17 maximumDuration=3：request 总租期 4 > 3 → 拒绝，零 PENDING 零通知", async () => {
      const listing = await createFixtureListing(1, 3);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });

      // proposed total = T0 → T2 = 4 个计价单位 > 3
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({
        error: "最长租期为 3 个计价单位",
      });

      expect(
        await rawClient!.rentalExtensionRequest.count({ where: { orderId: order.id } }),
      ).toBe(0);
      expect(await notificationCount({ userId: owner.id, title: "收到续租请求" })).toBe(0);
      // 订单零变更
      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
    });

    it("EXT-18 policy drift：request 时 max=10 通过 → owner 收紧为 5 → approve 基于 fresh listing 拒绝，extension 保持 PENDING 零变更", async () => {
      const listing = await createFixtureListing(1, 10);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });

      // Day0 → Day8：proposed total = 8 ≤ 10，request 合法
      const day8 = new Date(T0.getTime() + 8 * DAY);
      expect(await requestViaProduction(renterA.id, order.id, day8)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(ext.status).toBe("PENDING");

      // 真实 DB 政策漂移：owner 在 request 之后把最长租期收紧为 5
      await rawClient!.rentalListing.update({
        where: { id: listing.id },
        data: { maximumDuration: 5 },
      });

      // approval 必须基于 fresh locked listing.maximumDuration = 5 拒绝（8 > 5），
      // 绝不信任 request-time 旧值 10
      expect(await approveViaProduction(owner.id, ext.id)).toEqual({
        error: "最长租期为 5 个计价单位",
      });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T1.getTime());
      expect(finalOrder.rentalDuration).toBe(2);
      expect(finalOrder.rentalAmount.toString()).toBe("40");
      expect(finalOrder.finalAmount.toString()).toBe("90");
      expect((await readExtension(ext.id)).status).toBe("PENDING");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(0);
    });

    it("EXT-19 boundary：maximumDuration=4，proposed total = 4 → request + approve 全 PASS（> 而非 >=）", async () => {
      const listing = await createFixtureListing(1, 4);
      const order = await createFixtureOrder({ listingId: listing.id, renterId: renterA.id, status: "IN_RENTAL" });

      // proposed total = T0 → T2 = 4，恰好等于上限
      expect(await requestViaProduction(renterA.id, order.id, T2)).toEqual({ success: true });
      const ext = await rawClient!.rentalExtensionRequest.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(ext.additionalFee.toString()).toBe("40");

      expect(await approveViaProduction(owner.id, ext.id)).toEqual({ success: true });

      const finalOrder = await readOrder(order.id);
      expect(finalOrder.endTime.getTime()).toBe(T2.getTime());
      expect(finalOrder.rentalDuration).toBe(4);
      expect(finalOrder.rentalAmount.toString()).toBe("80");
      expect(finalOrder.finalAmount.toString()).toBe("130");
      expect((await readExtension(ext.id)).status).toBe("APPROVED");
      expect(await notificationCount({ userId: renterA.id, title: "续租请求已通过" })).toBe(1);
    });
  },
);

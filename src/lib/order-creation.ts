import type { Prisma } from "@prisma/client";

import { enqueueAsyncJobTx } from "@/lib/async/job-repository";
import {
  PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
  PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
} from "@/lib/async/job-types";
import { decimalValue } from "@/lib/decimal";
import { marketplaceObligationValidator } from "@/lib/enforcement/capability-gate";
import { createOrderNo } from "@/lib/order-no";
import { hasActiveListingModeration } from "@/lib/moderation/listing-moderation-query";
import { computeProductReservationExpiresAt } from "@/lib/product-reservation";
import {
  emitNotificationsTx,
} from "@/lib/notifications/notification-service";
import {
  ERRAND_ORDER_CLAIMED_KIND,
  PRODUCT_ORDER_CREATED_KIND,
  SERVICE_ORDER_CREATED_KIND,
} from "@/lib/notifications/notification-registry";
import {
  withObligationGuard,
  type ObligationRacePoint,
} from "@/lib/governance/obligation-guard";

/**
 * 交易/履约义务创建的事务级入口（Phase 5 REPAIR 2，BLOCKER B）。
 *
 * 四类持续性 active obligation（商品订单 / 服务预约 / 跑腿接单 / 租赁订单）
 * 的创建都必须经由 participant governance 锁 + 锁内校验后才允许写入
 * （见 obligation-guard.ts 的线性化契约）。action 层只做表单解析与
 * requireUser 预检；真正的写事务从这里开始——requireUser 是事务前校验，
 * 不足以关闭"校验后被注销"的竞态窗口。
 *
 * Phase 6C-3：锁内校验统一由 marketplaceObligationValidator 组装——
 * STEP 1 发起方（buyer/claimer/renter）三门专用校验（403 族），
 * STEP 2 全参与方（含对手方 seller/provider/publisher/owner）资格校验
 * （account/membership/risk 任一维失效统一 MARKETPLACE_COUNTERPARTY_
 * UNAVAILABLE 409，不区分哪一方/哪一维）。#44（Phase 6B DEFER_TO_6C）
 * 已关闭：受限对手方不再接受新义务；其既有 listing 仍公开可读，
 * 既有义务 wind-down 不受影响。
 *
 * racePoint 为测试 seam（锁 + 锁内校验之后、义务写入之前），生产路径不传。
 */

/** 测试 seam：participant 锁 + validateLocked 校验之后、义务写入之前的受控暂停点。 */
export type { ObligationRacePoint };

/**
 * Phase 7C 测试 seam：listing 行锁 + 现势复查 + moderation 复查之后、
 * 义务写入之前的受控暂停点（C02B/C15-C17 持锁注入点；生产路径不传）。
 * 既有 ObligationRacePoint 保留原位（guard 级，行锁之前）供 6B/6C race
 * tests 使用，语义零变化。
 */
export type ListingModerationRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/** 商品订单：participants = buyer + seller。 */
export async function createProductOrderTx(
  tx: Prisma.TransactionClient,
  input: {
    buyerId: string;
    product: { id: string; price: string; sellerId: string; campusId: string };
    meetingLocation: string;
    note: string | null;
  },
  racePoint?: ObligationRacePoint,
  /** Phase 7C：listing 行锁 + 复查后、写入前的测试 seam（生产不传）。 */
  domainRacePoint?: ListingModerationRacePoint,
  /** Phase 8B-01：deadline 计算的可注入时钟（仅测试；生产不传）。 */
  options?: { now?: Date },
) {
  return withObligationGuard(
    tx,
    [input.buyerId, input.product.sellerId],
    marketplaceObligationValidator({
      initiatorId: input.buyerId,
      participantUserIds: [input.buyerId, input.product.sellerId],
      campusId: input.product.campusId,
    }),
    async () => {
      // Phase 7C（R2-02）：participant 锁 → listing 行锁 → 现势权威复查。
      // 事务外 product 读仅作 discovery / 参与方发现；金额与参与方事实以
      // 锁内 fresh 行为准（order.amount = fresh.price）。
      const lockedRows = await tx.$queryRaw<Array<{
        id: string; campusId: string; status: string; price: string; sellerId: string; deletedAt: Date | null;
      }>>`
        SELECT id, "campusId", status, price, "sellerId", "deletedAt"
        FROM "Product"
        WHERE id = ${input.product.id}
        FOR UPDATE
      `;
      const fresh = lockedRows[0];
      if (
        !fresh ||
        fresh.deletedAt !== null ||
        fresh.status !== "ACTIVE" ||
        fresh.sellerId !== input.product.sellerId ||
        fresh.campusId !== input.product.campusId
      ) {
        return null;
      }
      // 活跃治理 moderation → 新义务拒绝（既有义务不受影响）
      if (await hasActiveListingModeration(tx, "PRODUCT", fresh.id)) {
        return null;
      }
      if (domainRacePoint) {
        await domainRacePoint(tx);
      }

      // 既有条件 update 保留为最终谓词安全带（行锁下恒真，幂等语义不变）
      const reserveResult = await tx.product.updateMany({
        where: {
          id: fresh.id,
          status: "ACTIVE",
          deletedAt: null,
        },
        data: { status: "RESERVED" },
      });

      if (reserveResult.count === 0) {
        return null;
      }

      // Phase 8B-01：deadline 基于同一次事务内捕获的单一 now（禁止多次
      // new Date() 漂移）；reservation resolution 二元组保持 NULL（未关闭）。
      const reservationNow = options?.now ?? new Date();
      const productReservationExpiresAt = computeProductReservationExpiresAt(reservationNow);

      const order = await tx.order.create({
        data: {
          orderNo: createOrderNo(),
          type: "PRODUCT",
          amount: decimalValue(fresh.price),
          meetingLocation: input.meetingLocation,
          note: input.note,
          paymentStatus: "OFFLINE_PENDING",
          buyerId: input.buyerId,
          sellerId: fresh.sellerId,
          productId: fresh.id,
          productReservationExpiresAt,
        },
      });

      // Phase 9A（§8/§9）：Order exists ⇔ expiry job durable intent exists。
      // AsyncJob 与 Order 在同一业务事务内原子落盘——严禁事务后 enqueue
      // （两步之间 crash → reservation 永不过期）。dedupeKey 幂等，worker
      // 到期后只负责 wake up → expireProductReservationTx（canonical authority）。
      await enqueueAsyncJobTx(tx, {
        kind: PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
        schemaVersion: PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
        dedupeKey: `${PRODUCT_RESERVATION_EXPIRE_JOB_KIND}:${order.id}`,
        payload: { orderId: order.id },
        runAt: productReservationExpiresAt,
      });

      // Phase 9B：canonical notification domain（文案由 registry 渲染）
      await emitNotificationsTx(tx, [
        {
          kind: PRODUCT_ORDER_CREATED_KIND,
          recipientUserId: input.buyerId,
          orderId: order.id,
          dedupeKey: `${PRODUCT_ORDER_CREATED_KIND}:${order.id}:${input.buyerId}`,
          payload: { orderId: order.id, buyerId: input.buyerId, sellerId: fresh.sellerId },
        },
        {
          kind: PRODUCT_ORDER_CREATED_KIND,
          recipientUserId: fresh.sellerId,
          orderId: order.id,
          dedupeKey: `${PRODUCT_ORDER_CREATED_KIND}:${order.id}:${fresh.sellerId}`,
          payload: { orderId: order.id, buyerId: input.buyerId, sellerId: fresh.sellerId },
        },
      ]);

      return order;
    },
    racePoint,
  );
}

/** 服务预约：participants = buyer + provider。 */
export async function createServiceOrderTx(
  tx: Prisma.TransactionClient,
  input: {
    buyerId: string;
    service: { id: string; price: string; providerId: string; campusId: string };
    meetingLocation: string;
    note: string | null;
  },
  racePoint?: ObligationRacePoint,
  /** Phase 7C：listing 行锁 + 复查后、写入前的测试 seam（生产不传）。 */
  domainRacePoint?: ListingModerationRacePoint,
) {
  return withObligationGuard(
    tx,
    [input.buyerId, input.service.providerId],
    marketplaceObligationValidator({
      initiatorId: input.buyerId,
      participantUserIds: [input.buyerId, input.service.providerId],
      campusId: input.service.campusId,
    }),
    async () => {
      // Phase 7C（R2-02）：锁内现势行 = 义务权威（amount = fresh.price）。
      const lockedRows = await tx.$queryRaw<Array<{
        id: string; campusId: string; status: string; price: string; providerId: string; deletedAt: Date | null;
      }>>`
        SELECT id, "campusId", status, price, "providerId", "deletedAt"
        FROM "ServiceListing"
        WHERE id = ${input.service.id}
        FOR UPDATE
      `;
      const fresh = lockedRows[0];
      if (
        !fresh ||
        fresh.deletedAt !== null ||
        fresh.status !== "ACTIVE" ||
        fresh.providerId !== input.service.providerId ||
        fresh.campusId !== input.service.campusId
      ) {
        return null;
      }
      if (await hasActiveListingModeration(tx, "SERVICE", fresh.id)) {
        return null;
      }
      if (domainRacePoint) {
        await domainRacePoint(tx);
      }

      const order = await tx.order.create({
        data: {
          orderNo: createOrderNo(),
          type: "SERVICE",
          amount: decimalValue(fresh.price),
          meetingLocation: input.meetingLocation,
          note: input.note,
          paymentStatus: "OFFLINE_PENDING",
          buyerId: input.buyerId,
          sellerId: fresh.providerId,
          serviceListingId: fresh.id,
        },
      });

      await emitNotificationsTx(tx, [
        {
          kind: SERVICE_ORDER_CREATED_KIND,
          recipientUserId: input.buyerId,
          orderId: order.id,
          dedupeKey: `${SERVICE_ORDER_CREATED_KIND}:${order.id}:${input.buyerId}`,
          payload: { orderId: order.id, buyerId: input.buyerId, sellerId: fresh.providerId },
        },
        {
          kind: SERVICE_ORDER_CREATED_KIND,
          recipientUserId: fresh.providerId,
          orderId: order.id,
          dedupeKey: `${SERVICE_ORDER_CREATED_KIND}:${order.id}:${fresh.providerId}`,
          payload: { orderId: order.id, buyerId: input.buyerId, sellerId: fresh.providerId },
        },
      ]);

      return order;
    },
    racePoint,
  );
}

/**
 * 跑腿接单：participants = publisher + claimant；义务 = CLAIMED 任务 + ACCEPTED 订单。
 *
 * Phase 9C-02（§4 第一红线）：deadline 进入 canonical claim authority——
 * participant 锁 → ErrandTask FOR UPDATE → fresh row 之上，`fresh.deadline
 * <= now` 一律 DENY（零 Task/Order/Notification 写入）。事务外 snapshot
 * deadline / UI disable / public query 隐藏都不构成 authority；本判定是
 * deadline 与接单义务之间的唯一线性化点（与 expiry 的 publisher 锁 +
 * 行锁互斥，见 errand-lifecycle.expireErrandDeadlineTx 锁序）。
 */
export async function claimErrandTx(
  tx: Prisma.TransactionClient,
  input: {
    errandId: string;
    publisherId: string;
    claimerId: string;
    campusId: string;
    reward: Prisma.Decimal;
  },
  racePoint?: ObligationRacePoint,
  /** Phase 7C：listing 行锁 + 复查后、写入前的测试 seam（生产不传）。 */
  domainRacePoint?: ListingModerationRacePoint,
  /** Phase 9C-02：deadline 判定的可注入时钟（仅测试；生产不传）。 */
  options?: { now?: Date },
) {
  return withObligationGuard(
    tx,
    [input.publisherId, input.claimerId],
    marketplaceObligationValidator({
      initiatorId: input.claimerId,
      participantUserIds: [input.publisherId, input.claimerId],
      campusId: input.campusId,
    }),
    async () => {
      // Phase 9C-02（§19）：本 transition 的全部 deadline 判定共用同一
      // authoritativeNow（禁止多处 new Date() 边界漂移）。
      const now = options?.now ?? new Date();
      // Phase 7C（R2-02）：锁内现势行 = 义务权威（amount = fresh.reward）。
      const lockedRows = await tx.$queryRaw<Array<{
        id: string; campusId: string; status: string; reward: string; publisherId: string; accepterId: string | null; deadline: Date; deletedAt: Date | null;
      }>>`
        SELECT id, "campusId", status, reward, "publisherId", "accepterId", "deadline", "deletedAt"
        FROM "ErrandTask"
        WHERE id = ${input.errandId}
        FOR UPDATE
      `;
      const fresh = lockedRows[0];
      if (
        !fresh ||
        fresh.deletedAt !== null ||
        fresh.status !== "OPEN" ||
        fresh.accepterId !== null ||
        fresh.publisherId !== input.publisherId ||
        fresh.campusId !== input.campusId
      ) {
        return null;
      }
      // Phase 9C-02 红线：锁内 fresh deadline 权威（§2.1 冻结语义——
      // deadline 是"允许该 OPEN 任务继续接受新接单"的截止时刻）。
      // deadline 过期 → return null，zero ErrandTask mutation / Order /
      // Notification（不依赖 public query 隐藏或 worker 是否已 materialize）。
      if (!(fresh.deadline instanceof Date) || fresh.deadline.getTime() <= now.getTime()) {
        return null;
      }
      if (await hasActiveListingModeration(tx, "ERRAND", fresh.id)) {
        return null;
      }
      if (domainRacePoint) {
        await domainRacePoint(tx);
      }

      // 既有条件 update 保留为最终谓词安全带（行锁下恒真，幂等语义不变）；
      // deadline 下界一并入带（防御纵深）
      const claimResult = await tx.errandTask.updateMany({
        where: {
          id: fresh.id,
          status: "OPEN",
          accepterId: null,
          deadline: { gt: now },
        },
        data: {
          accepterId: input.claimerId,
          status: "CLAIMED",
        },
      });

      if (claimResult.count === 0) {
        return null;
      }

      const order = await tx.order.create({
        data: {
          orderNo: createOrderNo(),
          type: "ERRAND",
          status: "ACCEPTED",
          amount: decimalValue(fresh.reward),
          paymentStatus: "OFFLINE_PENDING",
          buyerId: fresh.publisherId,
          sellerId: input.claimerId,
          errandTaskId: fresh.id,
        },
      });

      await emitNotificationsTx(tx, [
        {
          kind: ERRAND_ORDER_CLAIMED_KIND,
          recipientUserId: input.publisherId,
          orderId: order.id,
          dedupeKey: `${ERRAND_ORDER_CLAIMED_KIND}:${order.id}:${input.publisherId}`,
          payload: { orderId: order.id, publisherId: input.publisherId, claimerId: input.claimerId },
        },
        {
          kind: ERRAND_ORDER_CLAIMED_KIND,
          recipientUserId: input.claimerId,
          orderId: order.id,
          dedupeKey: `${ERRAND_ORDER_CLAIMED_KIND}:${order.id}:${input.claimerId}`,
          payload: { orderId: order.id, publisherId: input.publisherId, claimerId: input.claimerId },
        },
      ]);

      return order;
    },
    racePoint,
  );
}

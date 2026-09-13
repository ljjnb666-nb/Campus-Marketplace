import type { Prisma } from "@prisma/client";

import { decimalValue } from "@/lib/decimal";
import { marketplaceObligationValidator } from "@/lib/enforcement/capability-gate";
import { createOrderNo } from "@/lib/order-no";
import { hasActiveListingModeration } from "@/lib/moderation/listing-moderation-query";
import { createNotifications } from "@/repositories/notification-repository";
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
        },
      });

      await createNotifications(tx, [
        {
          userId: input.buyerId,
          orderId: order.id,
          type: "ORDER",
          title: "购买申请已提交",
          content: "你的商品购买申请已提交，等待卖家确认。",
        },
        {
          userId: fresh.sellerId,
          orderId: order.id,
          type: "ORDER",
          title: "收到新的商品订单",
          content: "有同学提交了你的商品购买申请，请尽快确认订单状态。",
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

      await createNotifications(tx, [
        {
          userId: input.buyerId,
          orderId: order.id,
          type: "ORDER",
          title: "服务预约已提交",
          content: "你的服务预约已提交，等待服务提供者确认。",
        },
        {
          userId: fresh.providerId,
          orderId: order.id,
          type: "ORDER",
          title: "收到新的服务预约",
          content: "有同学预约了你的服务，请尽快确认并安排后续沟通。",
        },
      ]);

      return order;
    },
    racePoint,
  );
}

/** 跑腿接单：participants = publisher + claimant；义务 = CLAIMED 任务 + ACCEPTED 订单。 */
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
      // Phase 7C（R2-02）：锁内现势行 = 义务权威（amount = fresh.reward）。
      const lockedRows = await tx.$queryRaw<Array<{
        id: string; campusId: string; status: string; reward: string; publisherId: string; accepterId: string | null; deletedAt: Date | null;
      }>>`
        SELECT id, "campusId", status, reward, "publisherId", "accepterId", "deletedAt"
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
      if (await hasActiveListingModeration(tx, "ERRAND", fresh.id)) {
        return null;
      }
      if (domainRacePoint) {
        await domainRacePoint(tx);
      }

      // 既有条件 update 保留为最终谓词安全带（行锁下恒真，幂等语义不变）
      const claimResult = await tx.errandTask.updateMany({
        where: {
          id: fresh.id,
          status: "OPEN",
          accepterId: null,
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

      await createNotifications(tx, [
        {
          userId: input.publisherId,
          orderId: order.id,
          type: "ORDER",
          title: "跑腿任务已被接单",
          content: "你的跑腿任务已有同学接单，可以前往订单中心继续跟进。",
        },
        {
          userId: input.claimerId,
          orderId: order.id,
          type: "ORDER",
          title: "你已接下跑腿任务",
          content: "接单成功，请尽快与发布者沟通并推进任务。",
        },
      ]);

      return order;
    },
    racePoint,
  );
}

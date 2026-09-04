import type { Prisma } from "@prisma/client";

import { decimalValue } from "@/lib/decimal";
import { createOrderNo } from "@/lib/order-no";
import { createNotifications } from "@/repositories/notification-repository";
import {
  withObligationGuard,
  type ObligationRacePoint,
} from "@/lib/governance/obligation-guard";

/**
 * 交易/履约义务创建的事务级入口（Phase 5 REPAIR 2，BLOCKER B）。
 *
 * 四类持续性 active obligation（商品订单 / 服务预约 / 跑腿接单 / 租赁订单）
 * 的创建都必须经由 participant governance 锁 + 活跃复核后才允许写入
 * （见 obligation-guard.ts 的线性化契约）。action 层只做表单解析与
 * requireUser 预检；真正的写事务从这里开始——requireUser 是事务前校验，
 * 不足以关闭"校验后被注销"的竞态窗口。
 *
 * racePoint 为测试 seam（锁 + 复核之后、义务写入之前），生产路径不传。
 */

/** 测试 seam：participant 锁 + active 复核之后、义务写入之前的受控暂停点。 */
export type { ObligationRacePoint };

/** 商品订单：participants = buyer + seller。 */
export async function createProductOrderTx(
  tx: Prisma.TransactionClient,
  input: {
    buyerId: string;
    product: { id: string; price: string; sellerId: string };
    meetingLocation: string;
    note: string | null;
  },
  racePoint?: ObligationRacePoint,
) {
  return withObligationGuard(tx, [input.buyerId, input.product.sellerId], async () => {
    const reserveResult = await tx.product.updateMany({
      where: {
        id: input.product.id,
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
        amount: decimalValue(input.product.price),
        meetingLocation: input.meetingLocation,
        note: input.note,
        paymentStatus: "OFFLINE_PENDING",
        buyerId: input.buyerId,
        sellerId: input.product.sellerId,
        productId: input.product.id,
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
        userId: input.product.sellerId,
        orderId: order.id,
        type: "ORDER",
        title: "收到新的商品订单",
        content: "有同学提交了你的商品购买申请，请尽快确认订单状态。",
      },
    ]);

    return order;
  }, racePoint);
}

/** 服务预约：participants = buyer + provider。 */
export async function createServiceOrderTx(
  tx: Prisma.TransactionClient,
  input: {
    buyerId: string;
    service: { id: string; price: string; providerId: string };
    meetingLocation: string;
    note: string | null;
  },
  racePoint?: ObligationRacePoint,
) {
  return withObligationGuard(tx, [input.buyerId, input.service.providerId], async () => {
    const order = await tx.order.create({
      data: {
        orderNo: createOrderNo(),
        type: "SERVICE",
        amount: decimalValue(input.service.price),
        meetingLocation: input.meetingLocation,
        note: input.note,
        paymentStatus: "OFFLINE_PENDING",
        buyerId: input.buyerId,
        sellerId: input.service.providerId,
        serviceListingId: input.service.id,
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
        userId: input.service.providerId,
        orderId: order.id,
        type: "ORDER",
        title: "收到新的服务预约",
        content: "有同学预约了你的服务，请尽快确认并安排后续沟通。",
      },
    ]);

    return order;
  }, racePoint);
}

/** 跑腿接单：participants = publisher + claimant；义务 = CLAIMED 任务 + ACCEPTED 订单。 */
export async function claimErrandTx(
  tx: Prisma.TransactionClient,
  input: {
    errandId: string;
    publisherId: string;
    claimerId: string;
    reward: Prisma.Decimal;
  },
  racePoint?: ObligationRacePoint,
) {
  return withObligationGuard(tx, [input.publisherId, input.claimerId], async () => {
    const claimResult = await tx.errandTask.updateMany({
      where: {
        id: input.errandId,
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
        amount: input.reward,
        paymentStatus: "OFFLINE_PENDING",
        buyerId: input.publisherId,
        sellerId: input.claimerId,
        errandTaskId: input.errandId,
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
  }, racePoint);
}

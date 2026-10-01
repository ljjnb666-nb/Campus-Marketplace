import { prisma } from "@/lib/prisma";

/**
 * Phase 8D-02：Meetup 用户面 server-side read projection。
 *
 * 边界（冻结，与 8D-01 domain authority 对齐）：
 * - Participant authorization：只有 Order.buyerId / Order.sellerId 可读；
 *   不存在 / 非参与方 / 不支持的 type 统一返回 null（反存在性 oracle，
 *   不泄露 meetup 是否存在 / 地点 / 时间 / 到场状态 / dispute provenance）。
 * - Type authority：仅 PRODUCT / SERVICE 进入本页 workflow；ERRAND /
 *   RENTAL 有独立履约 lifecycle（pickup/delivery、handover/return），
 *   结构上不进入 General Meetup 域。
 * - Historical location：历史地点唯一来源 = OrderMeetup.locationTextSnapshot
 *   （transaction snapshot authority），绝不重新 JOIN MeetupPoint 反写
 *   历史；meetupPointId 为 NULL（点已删除）时 MEETUP_POINT 快照仍显示原值。
 * - campus 读取（仅供发起表单的校内推荐见面点列表）= 交易标的归属 campus
 *   （PRODUCT → Product.campusId / SERVICE → ServiceListing.campusId），
 *   与 proposeOrderMeetupTx 锁内权威裁决同源；最终 point 可用性仍由
 *   canonical service 锁内裁决，这里只是候选列表投影。
 */

/** 历史记录 UX 上限（明确有序截断，避免无界传输） */
export const MEETUP_HISTORY_LIMIT = 10;

export type OrderMeetupStatusValue =
  | "PROPOSED"
  | "CONFIRMED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW_REPORTED";

export type OrderMeetupHistoryItem = {
  id: string;
  status: OrderMeetupStatusValue;
  scheduledAt: Date;
  locationTextSnapshot: string;
  locationSource: "CUSTOM" | "MEETUP_POINT";
  proposedById: string;
  confirmedById: string | null;
  cancelledAt: Date | null;
  buyerArrivedAt: Date | null;
  sellerArrivedAt: Date | null;
  noShowReportedById: string | null;
  triggeredDisputeId: string | null;
  createdAt: Date;
};

export type MeetupPointOption = {
  id: string;
  name: string;
  locationText: string;
};

export type OrderMeetupView = {
  order: {
    id: string;
    orderNo: string;
    type: "PRODUCT" | "SERVICE";
    status: string;
    amount: string;
    title: string;
    /** 交易对方展示名（viewer 的 counterparty） */
    counterpartyName: string;
    /** 下单时初始见面偏好快照（Order.meetingLocation）≠ 正式约定 authority */
    initialMeetingLocation: string | null;
  };
  viewerRole: "buyer" | "seller";
  /** createdAt 倒序，≤ MEETUP_HISTORY_LIMIT（首条即最新） */
  meetups: OrderMeetupHistoryItem[];
  /** 发起表单候选：authoritative campus + isActive 的校内见面点 */
  meetupPointOptions: MeetupPointOption[];
};

export async function getOrderMeetupView(
  orderId: string,
  viewerId: string,
): Promise<OrderMeetupView | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNo: true,
      type: true,
      status: true,
      amount: true,
      meetingLocation: true,
      buyerId: true,
      sellerId: true,
      buyer: { select: { name: true } },
      seller: { select: { name: true } },
      product: { select: { title: true, campusId: true } },
      serviceListing: { select: { title: true, campusId: true } },
    },
  });

  // 统一安全基调：不存在 / 非参与方 / 不支持的 type 一律 null → 页面 404，
  // 不区分原因（第三方无法探测 meetup 存在性或交易内容）
  if (!order) {
    return null;
  }
  if (order.buyerId !== viewerId && order.sellerId !== viewerId) {
    return null;
  }
  if (order.type !== "PRODUCT" && order.type !== "SERVICE") {
    return null;
  }

  const isBuyer = order.buyerId === viewerId;
  const title =
    order.type === "PRODUCT"
      ? (order.product?.title ?? "商品已下架")
      : (order.serviceListing?.title ?? "服务已下架");
  const campusId =
    order.type === "PRODUCT"
      ? (order.product?.campusId ?? null)
      : (order.serviceListing?.campusId ?? null);

  // 历史地点只读 OrderMeetup 行内 snapshot；不 select meetupPoint 关联、
  // 不 join MeetupPoint.locationText（点改名/删除绝不改写历史展示）
  const [meetups, meetupPointOptions] = await Promise.all([
    prisma.orderMeetup.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "desc" },
      take: MEETUP_HISTORY_LIMIT,
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        locationTextSnapshot: true,
        locationSource: true,
        proposedById: true,
        confirmedById: true,
        cancelledAt: true,
        buyerArrivedAt: true,
        sellerArrivedAt: true,
        noShowReportedById: true,
        triggeredDisputeId: true,
        createdAt: true,
      },
    }),
    campusId
      ? prisma.meetupPoint.findMany({
          where: { campusId, isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true, locationText: true },
        })
      : Promise.resolve([] as MeetupPointOption[]),
  ]);

  return {
    order: {
      id: order.id,
      orderNo: order.orderNo,
      type: order.type,
      status: order.status,
      amount: order.amount.toString(),
      title,
      counterpartyName: isBuyer
        ? (order.seller?.name ?? "对方")
        : (order.buyer?.name ?? "对方"),
      initialMeetingLocation: order.meetingLocation,
    },
    viewerRole: isBuyer ? "buyer" : "seller",
    meetups: meetups.map((meetup) => ({
      id: meetup.id,
      status: meetup.status as OrderMeetupStatusValue,
      scheduledAt: meetup.scheduledAt,
      locationTextSnapshot: meetup.locationTextSnapshot,
      locationSource: meetup.locationSource as "CUSTOM" | "MEETUP_POINT",
      proposedById: meetup.proposedById,
      confirmedById: meetup.confirmedById,
      cancelledAt: meetup.cancelledAt,
      buyerArrivedAt: meetup.buyerArrivedAt,
      sellerArrivedAt: meetup.sellerArrivedAt,
      noShowReportedById: meetup.noShowReportedById,
      triggeredDisputeId: meetup.triggeredDisputeId,
      createdAt: meetup.createdAt,
    })),
    meetupPointOptions,
  };
}

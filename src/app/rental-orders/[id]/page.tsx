import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/ui/page-container";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { UserSummaryCard } from "@/components/ui/user-summary-card";
import { PriceDisplay } from "@/components/ui/price-display";
import { OrderStatusBadgeUnified } from "@/components/order/order-status-badge-unified";
import { OrderTimeline, TimelineStep } from "@/components/order/order-timeline";
import { RentalOrderActions } from "@/components/rental/rental-order-actions";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { MapPin, Calendar, Clock, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function RentalOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order) {
    notFound();
  }

  const isOwner = user.id === order.ownerId;
  const userRole = isOwner ? "owner" : "renter";
  const counterparty = isOwner ? order.renter : order.owner;
  // 未决损坏索赔（resolvedAt 为空）供租客在订单详情中处理
  const pendingClaim = order.damageClaims.find((claim) => claim.resolvedAt === null) ?? null;

  function formatDate(value: Date | string) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  // 构造时间线 5 步骤
  const isApproved = order.status !== "PENDING_APPROVAL" && order.status !== "REJECTED" && order.status !== "CANCELLED";
  const isPickedUp = isApproved && order.status !== "PENDING_PICKUP";
  const isReturned = isPickedUp && order.status !== "IN_RENTAL" && order.status !== "OVERDUE";
  const isCompleted = order.status === "COMPLETED";

  const timelineSteps: TimelineStep[] = [
    {
      key: "submit",
      title: "提交申请",
      time: order.createdAt,
      isCompleted: true,
      isCurrent: order.status === "PENDING_APPROVAL",
    },
    {
      key: "pickup",
      title: "核对交接",
      time: order.handoverRecord?.renterConfirmedAt || order.handoverRecord?.ownerConfirmedAt,
      isCompleted: isPickedUp,
      isCurrent: order.status === "PENDING_PICKUP",
    },
    {
      key: "usage",
      title: "在租使用",
      time: order.startTime,
      isCompleted: isReturned,
      isCurrent: order.status === "IN_RENTAL" || order.status === "OVERDUE",
    },
    {
      key: "return",
      title: "归还验收",
      time: order.returnRecord?.ownerConfirmedAt,
      isCompleted: isCompleted,
      isCurrent: order.status === "PENDING_RETURN" || order.status === "PENDING_INSPECTION",
    },
    {
      key: "completed",
      title: "评价结清",
      time: order.completedAt,
      isCompleted: isCompleted,
      isCurrent: isCompleted,
    },
  ];

  return (
    <PageContainer maxWidth="standard">
      {/* 1. 面包屑 */}
      <Breadcrumbs
        items={[
          { label: "统一订单中心", href: "/my/orders" },
          { label: isOwner ? "我的出租" : "我的租用", href: `/my/orders?type=${isOwner ? "rental-owner" : "rental-renter"}` },
          { label: `订单 #${order.orderNumber.slice(-8)}` },
        ]}
      />

      {/* 2. 状态标头 */}
      <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              租赁订单详情
            </h1>
            <OrderStatusBadgeUnified
              type="RENTAL"
              status={order.status}
              userRole={userRole}
            />
          </div>
          <p className="text-xs text-slate-400">
            订单编号：{order.orderNumber} · 创建时间：{formatDate(order.createdAt)}
          </p>
        </div>

        <RentalOrderActions
          orderId={order.id}
          status={order.status}
          userRole={userRole}
          handoverRecord={
            order.handoverRecord
              ? {
                  renterConfirmed: order.handoverRecord.renterConfirmed,
                  ownerConfirmed: order.handoverRecord.ownerConfirmed,
                }
              : null
          }
          returnRecord={
            order.returnRecord
              ? {
                  renterConfirmed: order.returnRecord.renterConfirmed,
                  ownerConfirmed: order.returnRecord.ownerConfirmed,
                }
              : null
          }
          pendingClaim={
            pendingClaim
              ? {
                  id: pendingClaim.id,
                  damageDescription: pendingClaim.damageDescription,
                  requestedDeduction: Number(pendingClaim.requestedDeduction),
                }
              : null
          }
        />
      </div>

      {/* 3. 交易进度节点时间线 */}
      <div className="mt-6">
        <OrderTimeline steps={timelineSteps} />
      </div>

      {/* 4. 55% : 45% 双栏 */}
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        {/* 左侧：物品摘要 + 租期时间 + 明细 + 履约记录 */}
        <div className="space-y-6">
          {/* 物品摘要 */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">
              租赁物品信息
            </h2>
            <div className="flex gap-4">
              <div className="size-20 shrink-0 overflow-hidden rounded-2xl bg-slate-100 border border-slate-100 dark:bg-slate-800 dark:border-slate-800">
                {order.rentalListing.images?.[0]?.url && (
                  <img
                    src={order.rentalListing.images[0].url}
                    alt={order.rentalListing.title}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <div className="flex-1 space-y-1.5 min-w-0">
                <Link
                  href={`/rentals/${order.rentalListingId}`}
                  className="text-base font-bold text-slate-900 hover:text-indigo-600 dark:text-slate-100 line-clamp-1"
                >
                  {order.rentalListing.title}
                </Link>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>单价：</span>
                  <PriceDisplay
                    price={order.unitPriceSnapshot}
                    unit={order.pricingUnitSnapshot}
                    size="sm"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* 租期与取还位置 */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900 space-y-4">
            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider">
              约定租期与当面交接位置
            </h2>
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2 dark:border-slate-800">
                <span className="text-slate-500 flex items-center gap-1">
                  <Calendar className="size-3.5 text-indigo-500" />
                  起租取货时刻
                </span>
                <span className="font-bold text-slate-900 dark:text-slate-100">
                  {formatDate(order.startTime)}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-2 dark:border-slate-800">
                <span className="text-slate-500 flex items-center gap-1">
                  <Clock className="size-3.5 text-emerald-500" />
                  预估归还时刻
                </span>
                <span className="font-bold text-slate-900 dark:text-slate-100">
                  {formatDate(order.endTime)}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-2 dark:border-slate-800">
                <span className="text-slate-500 flex items-center gap-1">
                  <MapPin className="size-3.5 text-indigo-500" />
                  约定取货位置
                </span>
                <span className="font-bold text-slate-900 dark:text-slate-100">
                  {order.rentalListing.pickupLocation}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 flex items-center gap-1">
                  <MapPin className="size-3.5 text-emerald-500" />
                  约定归还位置
                </span>
                <span className="font-bold text-slate-900 dark:text-slate-100">
                  {order.rentalListing.returnLocation}
                </span>
              </div>
            </div>
          </div>

          {/* 交接与归还双向确认记录 */}
          <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900 space-y-4">
            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider">
              交接与归还真实履约确认记录
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 text-xs">
              <div className="rounded-2xl bg-slate-50/80 p-3.5 border border-slate-100 space-y-1 dark:bg-slate-950/40 dark:border-slate-800">
                <p className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1">
                  <CheckCircle2 className="size-3.5 text-emerald-500" />
                  取货交接确认
                </p>
                <p className="text-slate-500">
                  租客：{order.handoverRecord?.renterConfirmed ? "已确认" : "未确认"} ·
                  出租者：{order.handoverRecord?.ownerConfirmed ? "已确认" : "未确认"}
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50/80 p-3.5 border border-slate-100 space-y-1 dark:bg-slate-950/40 dark:border-slate-800">
                <p className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1">
                  <CheckCircle2 className="size-3.5 text-emerald-500" />
                  归还验收确认
                </p>
                <p className="text-slate-500">
                  租客：{order.returnRecord?.renterConfirmed ? "已确认归还" : "未提交"} ·
                  出租者：{order.returnRecord?.ownerConfirmed ? "已验收" : "未验收"}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：Sticky 交易信息与控制面板 */}
        <div className="lg:sticky lg:top-24 space-y-6">
          <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900 space-y-6">
            <div>
              <p className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {isOwner ? "租客同学信息" : "出租者同学信息"}
              </p>
              <UserSummaryCard user={counterparty} />
            </div>

            {/* 费用明细清单 */}
            <div className="space-y-2.5 rounded-2xl bg-slate-50/80 p-4 text-xs dark:bg-slate-950/40">
              <div className="flex justify-between border-b border-slate-100 pb-2 text-slate-600 dark:border-slate-800 dark:text-slate-400">
                <span>租金小计</span>
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  ¥{Number(order.rentalAmount).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-100 pb-2 text-slate-600 dark:border-slate-800 dark:text-slate-400">
                <span>押金 (可结算退还)</span>
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  ¥{Number(order.depositAmount).toFixed(2)}
                </span>
              </div>
              {Number(order.overdueFee) > 0 && (
                <div className="flex justify-between border-b border-slate-100 pb-2 text-rose-600">
                  <span>逾期扣费</span>
                  <span className="font-semibold">¥{Number(order.overdueFee).toFixed(2)}</span>
                </div>
              )}
              {Number(order.depositDeduction) > 0 && (
                <div className="flex justify-between border-b border-slate-100 pb-2 text-rose-600">
                  <span>押金损坏扣除</span>
                  <span className="font-semibold">¥{Number(order.depositDeduction).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between pt-1 font-bold text-slate-900 dark:text-slate-100">
                <span>结算总金额</span>
                <PriceDisplay price={order.finalAmount.toString()} size="md" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

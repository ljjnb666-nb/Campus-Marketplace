"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ChevronRight, MessageSquare } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { OrderStatusBadgeUnified } from "@/components/order/order-status-badge-unified";
import { OrderCancelDialog } from "@/components/order/order-cancel-dialog";
import { OrderConfirmDialog } from "@/components/order/order-confirm-dialog";
import { ReviewDialog } from "@/components/order/review-dialog";
import { DisputeDialog } from "@/components/order/dispute-dialog";
import { createOrOpenOrderConversation } from "@/actions/conversation";
import { updateOrderStatus } from "@/actions/order";
import { createReview } from "@/actions/trust";
import { initiateGeneralOrderDispute } from "@/actions/order-dispute";
import { cancelRentalOrder, submitRentalReview, initiateDispute } from "@/actions/rental-order";

/**
 * ERRAND 合法 dispute 发起源 canonical pair（Order.status ↔ ErrandTask.status）。
 * 纯展示便利副本：领域权威是 initiateOrderDisputeTx 锁内 fresh 校验
 * （order-dispute-machine 的 DISPUTABLE_ERRAND_PAIRS 冻结矩阵，两处同形）。
 */
const ERRAND_DISPUTABLE_PAIRS: readonly (readonly [orderStatus: string, taskStatus: string])[] = [
  ["ACCEPTED", "CLAIMED"],
  ["IN_PROGRESS", "IN_PROGRESS"],
  ["IN_PROGRESS", "PENDING_CONFIRMATION"],
  ["COMPLETED", "COMPLETED"],
];

export interface UnifiedOrderData {
  id: string;
  orderNo: string;
  type: "PRODUCT" | "ERRAND" | "SERVICE" | "RENTAL";
  status: string;
  amount: number | string;
  depositAmount?: number | string;
  title: string;
  imageUrl?: string | null;
  createdAt: Date | string;
  meetingLocation?: string | null;
  note?: string | null;
  counterparty: {
    id: string;
    name: string;
    avatarUrl?: string | null;
    schoolName?: string;
  };
  userRole: "buyer" | "seller" | "publisher" | "accepter" | "renter" | "owner";
  detailHref: string;
  hasReviewed?: boolean;
  /** ERRAND 专用：关联 ErrandTask.status。Order.status 无法表达
   * "接单者已提交完成、待发布者确认"（该阶段 Order 仍为 IN_PROGRESS），
   * 判定发布者可确认完成必须以此为准，不能从 Order.status 推断 */
  errandStatus?: string | null;
  /** Phase 8B-01：PRODUCT 预留 deadline（seller 确认截止）最小可见性；
   * 纯展示——server 事务锁内 fresh deadline 才是最终裁决 */
  productReservationExpiresAt?: Date | string | null;
  productReservationResolution?: string | null;
  /** 服务端渲染时刻 deadline 已过但 expiry 尚未 materialize（Phase 9 前） */
  productReservationOverdue?: boolean;
}

export function OrderCardUnified({ order }: { order: UnifiedOrderData }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);

  function formatDate(value: Date | string) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  const canCancel =
    (order.type === "PRODUCT" && (order.status === "PENDING" || order.status === "ACCEPTED")) ||
    (order.type === "SERVICE" && order.status === "PENDING") ||
    (order.type === "RENTAL" && (order.status === "PENDING_APPROVAL" || order.status === "PENDING_PICKUP"));

  // 卖家侧主流程入口：商品/服务订单待确认时可接受；服务订单接受后可开始履约。
  // updateOrderStatus 已按角色+当前状态校验这些转换，这里只补齐 UI 入口。
  const canAccept =
    (order.type === "PRODUCT" || order.type === "SERVICE") &&
    order.status === "PENDING" &&
    order.userRole === "seller";

  const canStartProgress =
    order.type === "SERVICE" &&
    order.status === "ACCEPTED" &&
    order.userRole === "seller";

  const canConfirmComplete =
    (order.type === "PRODUCT" && order.status === "ACCEPTED" && order.userRole === "buyer") ||
    (order.type === "SERVICE" && order.status === "IN_PROGRESS" && order.userRole === "buyer") ||
    // ERRAND：必须接单者已提交完成（ErrandTask = PENDING_CONFIRMATION）。
    // 仅 Order IN_PROGRESS 表示"开始履约"，不构成可确认完成的依据
    (order.type === "ERRAND" &&
      order.status === "IN_PROGRESS" &&
      order.errandStatus === "PENDING_CONFIRMATION" &&
      order.userRole === "publisher");

  const canReview = (order.status === "COMPLETED" || order.status === "COMPLETED") && !order.hasReviewed;

  // Phase 8C-02：General（PRODUCT/SERVICE/ERRAND）dispute 入口重新开放。
  // 以下只是展示便利 predicate（与 initiateOrderDisputeTx 的 disputable
  // 冻结矩阵同形）；stale UI 错误显示时 canonical domain 仍 fail closed。
  // RENTAL 保持 8C-01 收窄前的原行为不变。
  const generalDisputable =
    (order.type === "PRODUCT" &&
      (order.status === "ACCEPTED" || order.status === "COMPLETED")) ||
    (order.type === "SERVICE" &&
      (order.status === "ACCEPTED" ||
        order.status === "IN_PROGRESS" ||
        order.status === "COMPLETED")) ||
    // ERRAND 必须使用 Order.status + errandStatus canonical pair，不能仅看
    // Order.status；malformed pair → 按钮隐藏
    (order.type === "ERRAND" &&
      order.errandStatus != null &&
      ERRAND_DISPUTABLE_PAIRS.some(
        ([orderStatus, taskStatus]) =>
          orderStatus === order.status && taskStatus === order.errandStatus,
      ));

  const canDispute =
    order.type === "RENTAL"
      ? order.status !== "IN_DISPUTE" &&
        order.status !== "CANCELLED" &&
        order.status !== "COMPLETED" &&
        order.status !== "REJECTED"
      : generalDisputable;

  const typeLabels: Record<string, string> = {
    PRODUCT: "二手商品",
    ERRAND: "跑腿求助",
    SERVICE: "技能服务",
    RENTAL: order.userRole === "owner" ? "物品出租" : "物品租用",
  };

  const cancelAction = async (formData: FormData) => {
    if (order.type === "RENTAL") {
      return cancelRentalOrder(formData);
    }
    return updateOrderStatus(formData);
  };
  const confirmAction = async (formData: FormData) => {
    return updateOrderStatus(formData);
  };
  const reviewAction = async (formData: FormData) => {
    if (order.type === "RENTAL") {
      return submitRentalReview(formData);
    }
    return createReview({ success: false, message: "" }, formData);
  };

  // Phase 8C-02 §19：dispute action 按 kind 显式分发——RENTAL → 既有 rental
  // initiateDispute；PRODUCT/SERVICE/ERRAND → canonical initiateGeneralOrderDispute。
  // 禁止 General 回落到 Rental action（押金/租期语义不同 aggregate）。
  const disputeAction =
    order.type === "RENTAL" ? initiateDispute : initiateGeneralOrderDispute;

  return (
    <>
      <article className="group relative overflow-hidden rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs transition hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 space-y-4">
        {/* 卡片头部：类型 + 单号 + 状态标签 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-0.5 text-[11px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {typeLabels[order.type]}
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              #{order.orderNo.slice(-8)}
            </span>
          </div>

          <OrderStatusBadgeUnified
            type={order.type}
            // ERRAND 展示跑腿工作流状态：Order.status 无法表达
            // "待发布者确认"阶段（该阶段 Order 仍为 IN_PROGRESS）
            status={order.type === "ERRAND" && order.errandStatus ? order.errandStatus : order.status}
            userRole={order.userRole}
            size="sm"
          />
        </div>

        {/* 主体信息 */}
        <div className="flex flex-col sm:flex-row gap-4">
          {/* 左缩略图 */}
          <div className="size-20 shrink-0 overflow-hidden rounded-2xl bg-slate-100 border border-slate-100 dark:bg-slate-800 dark:border-slate-800">
            {order.imageUrl ? (
              <img src={order.imageUrl} alt={order.title} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-slate-400">
                无图片
              </div>
            )}
          </div>

          {/* 中间信息 */}
          <div className="flex-1 space-y-1.5 min-w-0">
            <Link
              href={order.detailHref}
              className="text-base font-bold text-slate-900 hover:text-indigo-600 line-clamp-1 dark:text-slate-100"
            >
              {order.title}
            </Link>

            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>交易对方：</span>
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                {order.counterparty.name}
              </span>
            </div>

            {order.meetingLocation && (
              <p className="text-xs text-slate-500 truncate">
                地点：{order.meetingLocation}
              </p>
            )}

            <p className="text-[11px] text-slate-400">
              下单时间：{formatDate(order.createdAt)}
            </p>

            {/* Phase 8B-01：PRODUCT 预留 deadline 最小可见性（禁止客户端
                countdown / mutation——server 事务裁决才是 authority） */}
            {order.type === "PRODUCT" &&
              order.status === "PENDING" &&
              order.productReservationExpiresAt != null && (
                <p
                  className={`text-[11px] ${
                    order.productReservationOverdue
                      ? "font-semibold text-amber-600 dark:text-amber-400"
                      : "text-slate-400"
                  }`}
                >
                  {order.productReservationOverdue
                    ? "预留已到期，等待系统释放"
                    : `卖家确认截止：${formatDate(order.productReservationExpiresAt)}`}
                </p>
              )}

            {order.type === "PRODUCT" &&
              order.status === "CANCELLED" &&
              order.productReservationResolution === "EXPIRED" && (
                <p className="text-[11px] text-slate-400">预留超时释放</p>
              )}
          </div>

          {/* 右侧金额 */}
          <div className="flex sm:flex-col justify-between sm:justify-center items-end text-right border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-100 dark:border-slate-800">
            <span className="text-xs text-slate-400 font-medium sm:block">实付/应付金额</span>
            <PriceDisplay price={order.amount} size="md" />
            {order.depositAmount && Number(order.depositAmount) > 0 && (
              <span className="text-[10px] text-slate-400 block mt-0.5">
                (含押金 ¥{Number(order.depositAmount).toFixed(0)})
              </span>
            )}
          </div>
        </div>

        {/* 底部操作工具栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <OrderStatusBadgeUnified
              type={order.type}
              status={order.status}
              userRole={order.userRole}
              showHint
            />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {canAccept && (
              <form action={updateOrderStatus}>
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="status" value="ACCEPTED" />
                <button
                  type="submit"
                  className="rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-indigo-700"
                >
                  接受订单
                </button>
              </form>
            )}

            {canStartProgress && (
              <form action={updateOrderStatus}>
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="status" value="IN_PROGRESS" />
                <button
                  type="submit"
                  className="rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-indigo-700"
                >
                  开始服务
                </button>
              </form>
            )}

            <form action={createOrOpenOrderConversation}>
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="orderType" value={order.type} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200/90 bg-white px-3.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
              >
                <MessageSquare className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>联系对方</span>
              </button>
            </form>

            {canCancel && (
              <button
                type="button"
                onClick={() => setCancelOpen(true)}
                className="rounded-xl border border-slate-200/90 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
              >
                取消订单
              </button>
            )}

            {canConfirmComplete && (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-emerald-700"
              >
                确认完成
              </button>
            )}

            {canReview && (
              <button
                type="button"
                onClick={() => setReviewOpen(true)}
                className="rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:from-indigo-700 hover:to-indigo-800"
              >
                发表评价
              </button>
            )}

            {order.hasReviewed && (
              <span className="rounded-xl bg-slate-100 px-3 py-1 text-xs text-slate-500 font-medium dark:bg-slate-800 dark:text-slate-400">
                已评价
              </span>
            )}

            {canDispute && (
              <button
                type="button"
                onClick={() => setDisputeOpen(true)}
                className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              >
                发起申诉
              </button>
            )}

            <Link
              href={order.detailHref}
              className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
            >
              <span>查看详情</span>
              <ChevronRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </article>

      {/* 确认弹窗集 */}
      <OrderCancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        action={cancelAction}
        orderId={order.id}
      />

      <OrderConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        action={confirmAction}
        orderId={order.id}
        nextStatus="COMPLETED"
      />

      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        action={reviewAction}
        orderId={order.id}
        targetUserId={order.counterparty.id}
        orderType={order.type}
      />

      <DisputeDialog
        open={disputeOpen}
        onOpenChange={setDisputeOpen}
        action={disputeAction}
        orderId={order.id}
      />
    </>
  );
}

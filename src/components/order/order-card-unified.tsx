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
import { cancelRentalOrder, submitRentalReview, initiateDispute } from "@/actions/rental-order";

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

  const canConfirmComplete =
    (order.type === "PRODUCT" && order.status === "ACCEPTED" && order.userRole === "buyer") ||
    (order.type === "SERVICE" && order.status === "IN_PROGRESS" && order.userRole === "buyer") ||
    (order.type === "ERRAND" && order.status === "PENDING_CONFIRMATION" && order.userRole === "publisher");

  const canReview = (order.status === "COMPLETED" || order.status === "COMPLETED") && !order.hasReviewed;

  const canDispute =
    order.status !== "IN_DISPUTE" &&
    order.status !== "CANCELLED" &&
    order.status !== "COMPLETED" &&
    order.status !== "REJECTED";

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
            status={order.status}
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
        action={initiateDispute}
        orderId={order.id}
      />
    </>
  );
}

"use client";

import React, { useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { RentalOrderStatus } from "./rental-status-badge";
import {
  approveRentalOrder,
  rejectRentalOrder,
  cancelRentalOrder,
  respondDamageClaim,
} from "@/actions/rental-order";

type PendingDamageClaim = {
  id: string;
  damageDescription: string;
  requestedDeduction: number | string;
};

type RentalOrderActionsProps = {
  orderId: string;
  status: RentalOrderStatus;
  userRole: "owner" | "renter" | null;
  handoverRecord?: { renterConfirmed: boolean; ownerConfirmed: boolean } | null;
  returnRecord?: { renterConfirmed: boolean; ownerConfirmed: boolean } | null;
  // 未决损坏索赔（resolvedAt 为空）：仅租客可同意/拒绝（respondDamageClaim 校验 renterId）
  pendingClaim?: PendingDamageClaim | null;
};

export function RentalOrderActions({
  orderId,
  status,
  userRole,
  pendingClaim = null,
}: RentalOrderActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  function submitAction(action: (formData: FormData) => Promise<unknown>, formData: FormData) {
    startTransition(async () => {
      const result = await action(formData) as { success?: boolean; message?: string } | null;
      if (result && !result.success && result.message) {
        setErrorMsg(result.message);
      }
    });
  }

  const renderButtons = () => {
    if (status === "PENDING_APPROVAL") {
      if (userRole === "owner") {
        return (
          <div className="flex gap-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitAction(rejectRentalOrder, new FormData(e.currentTarget));
              }}
            >
              <input type="hidden" name="orderId" value={orderId} />
              <button
                type="submit"
                disabled={isPending}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "拒绝请求"}
              </button>
            </form>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitAction(approveRentalOrder, new FormData(e.currentTarget));
              }}
            >
              <input type="hidden" name="orderId" value={orderId} />
              <button
                type="submit"
                disabled={isPending}
                className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "同意租用"}
              </button>
            </form>
          </div>
        );
      } else if (userRole === "renter") {
        return (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitAction(cancelRentalOrder, new FormData(e.currentTarget));
            }}
          >
            <input type="hidden" name="orderId" value={orderId} />
            <input type="hidden" name="cancellationReason" value="RENTER_CHANGED_PLAN" />
            <button
              type="submit"
              disabled={isPending}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "取消申请"}
            </button>
          </form>
        );
      }
    }

    if (status === "PENDING_PICKUP") {
      if (userRole === "owner") {
        return (
          <Link
            href={`/rental-orders/${orderId}/handover`}
            className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:from-indigo-700 hover:to-indigo-800"
          >
            前往取货验收
          </Link>
        );
      } else if (userRole === "renter") {
        return (
          <div className="flex gap-3 items-center">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitAction(cancelRentalOrder, new FormData(e.currentTarget));
              }}
            >
              <input type="hidden" name="orderId" value={orderId} />
              <input type="hidden" name="cancellationReason" value="RENTER_CHANGED_PLAN" />
              <button
                type="submit"
                disabled={isPending}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "取消订单"}
              </button>
            </form>
            <Link
              href={`/rental-orders/${orderId}/handover`}
              className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:from-indigo-700 hover:to-indigo-800"
            >
              确认取货
            </Link>
          </div>
        );
      }
    }

    // requestReturn 状态机允许租客在 IN_RENTAL / PICKED_UP / OVERDUE 发起归还；
    // 续租仅允许 IN_RENTAL / PICKED_UP，OVERDUE 不展示续租入口
    if (status === "IN_RENTAL" || status === "PICKED_UP" || status === "OVERDUE") {
      if (userRole === "renter") {
        return (
          <div className="flex gap-3">
            {status !== "OVERDUE" && (
              <Link
                href={`/rental-orders/${orderId}/extend`}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                申请续租
              </Link>
            )}
            <Link
              href={`/rental-orders/${orderId}/return`}
              className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:from-indigo-700 hover:to-indigo-800"
            >
              申请归还
            </Link>
          </div>
        );
      }
    }

    if (status === "PENDING_RETURN") {
      if (userRole === "owner") {
        return (
          <Link
            href={`/rental-orders/${orderId}/return`}
            className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:from-indigo-700 hover:to-indigo-800"
          >
            前往验收归还
          </Link>
        );
      }
    }

    if (status === "PENDING_INSPECTION") {
      if (userRole === "owner") {
        return (
          <div className="flex flex-wrap gap-3">
            <Link
              href={`/rental-orders/${orderId}/claim`}
              className="rounded-2xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-600 shadow-sm transition hover:bg-red-50"
            >
              提交损坏申诉
            </Link>
            <Link
              href={`/rental-orders/${orderId}/dispute`}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              发起纠纷
            </Link>
          </div>
        );
      }
    }

    if (status === "COMPLETED") {
      return (
        <Link
          href={`/rental-orders/${orderId}/review`}
          className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          撰写评价
        </Link>
      );
    }

    return null;
  };

  // 未决损坏索赔：respondDamageClaim 校验 resolvedAt 为空且操作者为订单租客，不限定订单状态
  const renderPendingClaim = () => {
    if (userRole !== "renter" || !pendingClaim) return null;

    return (
      <div className="w-full space-y-3 rounded-2xl border border-rose-200 bg-rose-50/60 p-3.5 dark:border-rose-900 dark:bg-rose-950/40">
        <div className="space-y-1">
          <p className="text-xs font-bold text-rose-700 dark:text-rose-300">
            出租者发起了损坏索赔，等待你处理
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {pendingClaim.damageDescription}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            申请扣除押金：
            <span className="font-bold text-rose-600">
              ¥{Number(pendingClaim.requestedDeduction).toFixed(2)}
            </span>
          </p>
        </div>
        <div className="flex gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitAction(respondDamageClaim, new FormData(e.currentTarget));
            }}
          >
            <input type="hidden" name="claimId" value={pendingClaim.id} />
            <input type="hidden" name="agreed" value="false" />
            <button
              type="submit"
              disabled={isPending}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "拒绝索赔"}
            </button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitAction(respondDamageClaim, new FormData(e.currentTarget));
            }}
          >
            <input type="hidden" name="claimId" value={pendingClaim.id} />
            <input type="hidden" name="agreed" value="true" />
            <button
              type="submit"
              disabled={isPending}
              className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "同意索赔"}
            </button>
          </form>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col items-start gap-3">
      {renderButtons()}
      {renderPendingClaim()}
      {errorMsg && (
        <p className="text-xs text-red-500">{errorMsg}</p>
      )}
    </div>
  );
}

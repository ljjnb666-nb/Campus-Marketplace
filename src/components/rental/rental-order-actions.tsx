"use client";

import React, { useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { RentalOrderStatus } from "./rental-status-badge";
import {
  approveRentalOrder,
  rejectRentalOrder,
  cancelRentalOrder,
} from "@/actions/rental-order";

type RentalOrderActionsProps = {
  orderId: string;
  status: RentalOrderStatus;
  userRole: "owner" | "renter" | null;
  handoverRecord?: { renterConfirmed: boolean; ownerConfirmed: boolean } | null;
  returnRecord?: { renterConfirmed: boolean; ownerConfirmed: boolean } | null;
};

export function RentalOrderActions({
  orderId,
  status,
  userRole,
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

    if (status === "IN_RENTAL" || status === "PICKED_UP") {
      if (userRole === "renter") {
        return (
          <div className="flex gap-3">
            <Link
              href={`/rental-orders/${orderId}/extend`}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              申请续租
            </Link>
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
              href={`/rental-orders/${orderId}/return`}
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

  return (
    <div className="flex flex-col items-start gap-3">
      {renderButtons()}
      {errorMsg && (
        <p className="text-xs text-red-500">{errorMsg}</p>
      )}
    </div>
  );
}

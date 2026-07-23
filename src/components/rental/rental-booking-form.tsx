"use client";

import React, { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { createRentalOrder } from "@/actions/rental-order";

type RentalBookingFormProps = {
  listingId: string;
  price: number;
  pricingUnit: "PER_HOUR" | "PER_DAY" | "PER_WEEK" | "PER_MONTH" | "PER_SESSION";
  depositAmount: number;
  requiresApproval: boolean;
};

const unitLabels = {
  PER_HOUR: "小时",
  PER_DAY: "天",
  PER_WEEK: "周",
  PER_MONTH: "月",
  PER_SESSION: "次",
};

export function RentalBookingForm({
  listingId,
  price,
  pricingUnit,
  depositAmount,
  requiresApproval,
}: RentalBookingFormProps) {
  const [state, formAction, isPending] = useActionState(
    createRentalOrder,
    { success: false, message: "" },
  );
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const { duration, rentalFee } = React.useMemo(() => {
    if (!startTime || !endTime) {
      return { duration: 0, rentalFee: 0 };
    }

    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();

    if (end <= start) {
      return { duration: 0, rentalFee: 0 };
    }

    const diffHours = Math.ceil((end - start) / (1000 * 60 * 60));
    let calcDuration = 0;

    switch (pricingUnit) {
      case "PER_HOUR":
        calcDuration = diffHours;
        break;
      case "PER_DAY":
        calcDuration = Math.ceil(diffHours / 24);
        break;
      case "PER_WEEK":
        calcDuration = Math.ceil(diffHours / (24 * 7));
        break;
      case "PER_MONTH":
        calcDuration = Math.ceil(diffHours / (24 * 30));
        break;
      case "PER_SESSION":
        calcDuration = 1;
        break;
    }

    return { duration: calcDuration, rentalFee: calcDuration * price };
  }, [startTime, endTime, price, pricingUnit]);

  return (
    <form action={formAction} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-md">
      <h3 className="mb-6 text-lg font-bold text-slate-900">预约租用</h3>
      
      <input type="hidden" name="listingId" value={listingId} />

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">开始时间</label>
          <input
            type="datetime-local"
            name="startTime"
            required
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
        
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">结束时间</label>
          <input
            type="datetime-local"
            name="endTime"
            required
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      </div>

      <div className="my-6 rounded-2xl bg-slate-50 p-4 space-y-2">
        <div className="flex justify-between text-sm text-slate-600">
          <span>租期时长</span>
          <span className="font-medium text-slate-900">
            {duration > 0 ? `${duration} ${unitLabels[pricingUnit]}` : "-"}
          </span>
        </div>
        <div className="flex justify-between text-sm text-slate-600">
          <span>租金小计</span>
          <span className="font-medium text-slate-900">¥{rentalFee.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-sm text-slate-600">
          <span>押金</span>
          <span className="font-medium text-slate-900">¥{Number(depositAmount).toFixed(2)}</span>
        </div>
        <hr className="border-slate-200 my-2" />
        <div className="flex justify-between text-base font-bold text-slate-900">
          <span>总计付款</span>
          <span className="text-indigo-600">¥{(rentalFee + Number(depositAmount)).toFixed(2)}</span>
        </div>
      </div>

      {!state.success && state.message && (
        <div className="mb-4 rounded-2xl bg-red-50 p-3 text-sm text-red-600">
          {state.message}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending || duration <= 0}
        className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-70"
      >
        {isPending ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        ) : requiresApproval ? (
          "提交预约请求"
        ) : (
          "立即预订"
        )}
      </button>

      {requiresApproval && (
        <p className="mt-3 text-center text-xs text-slate-500">
          房东开启了手动审核，提交后需等待确认
        </p>
      )}
    </form>
  );
}

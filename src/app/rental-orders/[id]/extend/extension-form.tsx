"use client";

import React, { useTransition, useState } from "react";
import { requestExtension } from "@/actions/rental-order";
import { Loader2 } from "lucide-react";

type ExtensionFormProps = {
  orderId: string;
  currentEndTime: string;
  price: number;
  pricingUnit: "PER_HOUR" | "PER_DAY" | "PER_WEEK" | "PER_MONTH" | "PER_SESSION";
};

const unitLabels: Record<string, string> = {
  PER_HOUR: "小时",
  PER_DAY: "天",
  PER_WEEK: "周",
  PER_MONTH: "月",
  PER_SESSION: "次",
};

export function RentalExtensionForm({ orderId, currentEndTime, price, pricingUnit }: ExtensionFormProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [newEndTime, setNewEndTime] = useState("");

  // Calculate derived state from newEndTime
  const { extraFee, extraDuration } = React.useMemo(() => {
    if (!newEndTime) {
      return { extraFee: 0, extraDuration: 0 };
    }

    const current = new Date(currentEndTime).getTime();
    const next = new Date(newEndTime).getTime();

    if (next <= current) {
      return { extraFee: 0, extraDuration: 0 };
    }

    const diffHours = Math.ceil((next - current) / (1000 * 60 * 60));
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

    return { extraFee: calcDuration * price, extraDuration: calcDuration };
  }, [newEndTime, currentEndTime, price, pricingUnit]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await requestExtension(formData) as { success?: boolean; message?: string } | null;
      if (result && !result.success && result.message) {
        setErrorMsg(result.message);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-8">
      <input type="hidden" name="orderId" value={orderId} />

      <div className="space-y-6">
        <div className="space-y-2 text-sm">
          <p className="text-slate-500">当前到期时间</p>
          <p className="text-lg font-bold text-slate-900">{new Date(currentEndTime).toLocaleString("zh-CN")}</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">
            期望续租至 <span className="text-red-500">*</span>
          </label>
          <input
            type="datetime-local"
            name="newEndTime"
            required
            min={new Date(currentEndTime).toISOString().slice(0, 16)}
            value={newEndTime}
            onChange={(e) => setNewEndTime(e.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        {extraDuration > 0 && (
          <div className="space-y-2 rounded-2xl bg-indigo-50/50 p-4">
            <div className="flex justify-between text-sm text-slate-600">
              <span>续租时长</span>
              <span className="font-medium text-slate-900">
                {extraDuration} {unitLabels[pricingUnit]}
              </span>
            </div>
            <div className="flex justify-between border-t border-indigo-100 pt-2 text-base font-bold text-slate-900">
              <span>预计额外费用</span>
              <span className="text-indigo-600">¥{extraFee.toFixed(2)}</span>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="rounded-2xl bg-red-50 p-3 text-sm text-red-600">
            {errorMsg}
          </div>
        )}

        <button
          type="submit"
          disabled={isPending || extraDuration <= 0}
          className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-70"
        >
          {isPending ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : "提交续租申请"}
        </button>
      </div>
    </form>
  );
}

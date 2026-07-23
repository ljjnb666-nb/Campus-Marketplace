"use client";

import React, { useState, useTransition } from "react";
import { Repeat, MapPin, X, CheckCircle2, Loader2, Calendar, ShieldCheck, AlertCircle } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";

interface RentalBookingDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: (formData: FormData) => Promise<{ success?: boolean; message?: string; redirectTo?: string } | void>;
  listing: {
    id: string;
    title: string;
    price: number | string;
    pricingUnit: string;
    depositAmount: number | string;
    minimumDuration: number;
    maximumDuration: number;
    pickupLocation: string;
    returnLocation: string;
    usageRules?: string | null;
    damagePolicy?: string | null;
    overduePolicy?: string | null;
    requiresApproval: boolean;
    images?: { url: string }[];
  };
}

const UNIT_LABELS: Record<string, string> = {
  PER_HOUR: "小时",
  PER_DAY: "天",
  PER_WEEK: "周",
  PER_MONTH: "月",
  PER_SESSION: "次",
};

export function RentalBookingDrawer({
  open,
  onOpenChange,
  action,
  listing,
}: RentalBookingDrawerProps) {
  const [isPending, startTransition] = useTransition();

  const now = new Date();
  const defaultStart = new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 16);
  const defaultEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString().slice(0, 16);

  const [startTime, setStartTime] = useState(defaultStart);
  const [endTime, setEndTime] = useState(defaultEnd);
  const [renterNote, setRenterNote] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  if (!open) return null;

  // 实时算价
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const validDates = !isNaN(startMs) && !isNaN(endMs) && endMs > startMs;

  let calculatedUnits = 1;
  if (validDates && listing.pricingUnit !== "PER_SESSION") {
    const diffMs = endMs - startMs;
    const unitMs =
      listing.pricingUnit === "PER_HOUR"
        ? 3600000
        : listing.pricingUnit === "PER_DAY"
        ? 86400000
        : listing.pricingUnit === "PER_WEEK"
        ? 604800000
        : 2592000000;
    calculatedUnits = Math.max(1, Math.ceil(diffMs / unitMs));
  }

  const estimatedRent = Number(listing.price) * calculatedUnits;
  const deposit = Number(listing.depositAmount);
  const estimatedTotal = estimatedRent + deposit;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!validDates) {
      setErrorMsg("结束时间必须晚于开始时间");
      return;
    }
    if (calculatedUnits < listing.minimumDuration) {
      setErrorMsg(`最短租期为 ${listing.minimumDuration} 个${UNIT_LABELS[listing.pricingUnit]}`);
      return;
    }
    if (calculatedUnits > listing.maximumDuration) {
      setErrorMsg(`最长租期为 ${listing.maximumDuration} 个${UNIT_LABELS[listing.pricingUnit]}`);
      return;
    }

    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      try {
        const res = await action(formData);
        if (res && res.success === false) {
          setErrorMsg(res.message || "提交租赁申请失败");
        } else {
          setIsSuccess(true);
          setTimeout(() => {
            onOpenChange(false);
            setIsSuccess(false);
            if (res && res.redirectTo) {
              window.location.href = res.redirectTo;
            } else {
              window.location.href = "/my/orders?type=rental-renter";
            }
          }, 1200);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "网络异常，请稍后重试";
        setErrorMsg(message);
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-t-3xl sm:rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-slide-up sm:animate-scale-in dark:border-slate-800 dark:bg-slate-900 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
              <Repeat className="size-4" />
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
              确认提交物品租赁订单
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <X className="size-4" />
          </button>
        </div>

        {isSuccess ? (
          <div className="flex flex-col items-center justify-center py-8 text-center animate-scale-in">
            <CheckCircle2 className="size-14 text-emerald-500" />
            <h4 className="mt-3 text-lg font-bold text-slate-900 dark:text-slate-100">
              租赁订单创建成功！
            </h4>
            <p className="mt-1 text-xs text-slate-500">正在为您跳转至租赁订单详情，请按照约定时间交接...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <input type="hidden" name="rentalListingId" value={listing.id} />

            {/* 物品快照 */}
            <div className="flex items-center gap-3.5 rounded-2xl bg-slate-50 p-3 border border-slate-100 dark:bg-slate-950/40 dark:border-slate-800">
              <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-800">
                {listing.images?.[0]?.url && (
                  <img
                    src={listing.images[0].url}
                    alt={listing.title}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-slate-900 truncate text-xs dark:text-slate-100">
                  {listing.title}
                </h4>
                <div className="mt-1 flex items-baseline gap-2">
                  <PriceDisplay price={listing.price} unit={UNIT_LABELS[listing.pricingUnit]} size="sm" />
                </div>
              </div>
            </div>

            {/* 租期时间选择 */}
            <div className="space-y-3 rounded-2xl bg-slate-50/70 p-3.5 border border-slate-100 dark:bg-slate-950/30 dark:border-slate-800">
              <div className="space-y-1">
                <label className="flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <Calendar className="size-3.5 text-indigo-500" />
                  起租时间 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="datetime-local"
                  name="startTime"
                  required
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>

              <div className="space-y-1">
                <label className="flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <Calendar className="size-3.5 text-emerald-500" />
                  归还时间 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="datetime-local"
                  name="endTime"
                  required
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
            </div>

            {/* 实时费用小计计算卡片 */}
            <div className="space-y-2 rounded-2xl border border-slate-200/80 p-3.5 text-xs dark:border-slate-800">
              <div className="flex justify-between text-slate-500">
                <span>预估时长小计</span>
                <span className="font-bold text-slate-900 dark:text-slate-100">
                  {calculatedUnits} 个{UNIT_LABELS[listing.pricingUnit]}
                </span>
              </div>
              <div className="flex justify-between text-slate-500">
                <span>租金预估 (¥{Number(listing.price).toFixed(0)} × {calculatedUnits})</span>
                <span className="font-semibold text-slate-900 dark:text-slate-100">¥{estimatedRent.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-slate-500">
                <span>物品押金 (验收归还后退还)</span>
                <span className="font-semibold text-slate-900 dark:text-slate-100">¥{deposit.toFixed(2)}</span>
              </div>
              <div className="border-t border-slate-100 pt-2 flex justify-between font-bold text-slate-900 dark:border-slate-800 dark:text-slate-100">
                <span>应付总计金额</span>
                <PriceDisplay price={estimatedTotal} size="md" />
              </div>
            </div>

            {/* 取还位置与留言 */}
            <div className="space-y-2 text-xs text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-1.5">
                <MapPin className="size-3.5 text-indigo-500 shrink-0" />
                <span>当面取货：{listing.pickupLocation}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <MapPin className="size-3.5 text-emerald-500 shrink-0" />
                <span>当面归还：{listing.returnLocation}</span>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                租客留言与交接备注 (选填)
              </label>
              <textarea
                name="renterNote"
                rows={2}
                value={renterNote}
                onChange={(e) => setRenterNote(e.target.value)}
                placeholder="告知出租者具体的接头地点偏好或配件需求..."
                className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>

            {errorMsg && (
              <div className="flex items-center gap-1.5 text-xs text-rose-600 font-medium">
                <AlertCircle className="size-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* 提交面板 */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-xs font-bold text-white shadow-md hover:bg-indigo-700 disabled:opacity-50"
              >
                {isPending && <Loader2 className="size-3.5 animate-spin" />}
                <ShieldCheck className="size-3.5" />
                <span>提交租赁订单</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

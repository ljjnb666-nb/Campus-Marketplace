"use client";

import React, { useState, useTransition } from "react";
import { ShoppingBag, MapPin, X, CheckCircle2, Loader2, AlertTriangle, ShieldCheck } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";

interface PurchaseDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: (formData: FormData) => Promise<{ success?: boolean; message?: string; redirectTo?: string } | void>;
  product: {
    id: string;
    title: string;
    price: number | string;
    originalPrice?: number | string | null;
    locationText: string;
    images?: { url: string }[];
  };
}

export function PurchaseDrawer({
  open,
  onOpenChange,
  action,
  product,
}: PurchaseDrawerProps) {
  const [isPending, startTransition] = useTransition();
  const [meetingLocation, setMeetingLocation] = useState(product.locationText || "");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      try {
        const res = await action(formData);
        if (res && res.success === false) {
          setErrorMsg(res.message || "下单失败，请稍后重试");
        } else {
          setIsSuccess(true);
          setTimeout(() => {
            onOpenChange(false);
            setIsSuccess(false);
            if (res && res.redirectTo) {
              window.location.href = res.redirectTo;
            } else {
              window.location.href = "/my/orders?type=product";
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
      {/* 遮罩 */}
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      {/* 抽屉/模态 */}
      <div className="relative w-full max-w-md overflow-hidden rounded-t-3xl sm:rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-slide-up sm:animate-scale-in dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
              <ShoppingBag className="size-4" />
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
              确认购买闲置商品
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
              订单创建成功！
            </h4>
            <p className="mt-1 text-xs text-slate-500">正在为您跳转至订单中心，请与卖家当面交易沟通...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <input type="hidden" name="productId" value={product.id} />

            {/* 商品摘要 */}
            <div className="flex items-center gap-3.5 rounded-2xl bg-slate-50 p-3 border border-slate-100 dark:bg-slate-950/40 dark:border-slate-800">
              <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-800">
                {product.images?.[0]?.url && (
                  <img
                    src={product.images[0].url}
                    alt={product.title}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-slate-900 truncate text-xs dark:text-slate-100">
                  {product.title}
                </h4>
                <div className="mt-1 flex items-baseline gap-2">
                  <PriceDisplay price={product.price} size="sm" />
                  {product.originalPrice && Number(product.originalPrice) > 0 && (
                    <span className="text-[10px] text-slate-400 line-through">
                      原价 ¥{Number(product.originalPrice).toFixed(0)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 交易地点与留言表单 */}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <MapPin className="size-3.5 text-indigo-500" />
                  约定交易面交地点 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  name="meetingLocation"
                  required
                  value={meetingLocation}
                  onChange={(e) => setMeetingLocation(e.target.value)}
                  placeholder="例如：图书馆门口 / 一食堂侧门..."
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  给卖家的备注/补充说明 (选填)
                </label>
                <textarea
                  name="note"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="如面交时间要求、测试仪器需求等..."
                  className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
            </div>

            {/* 安全告知 */}
            <div className="flex items-start gap-2 rounded-xl bg-indigo-50/70 p-3 text-[11px] text-indigo-800 border border-indigo-200/50 dark:bg-indigo-950/40 dark:text-indigo-300">
              <AlertTriangle className="size-4 shrink-0 text-indigo-600 mt-0.5" />
              <span>交易提醒：提交后将即时通知卖家。当面交易请务必当场核验商品质量无误后再确认付款。</span>
            </div>

            {errorMsg && <p className="text-xs text-rose-600 font-medium">{errorMsg}</p>}

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
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white shadow-md hover:bg-slate-800 disabled:opacity-50 dark:bg-indigo-600 dark:hover:bg-indigo-700"
              >
                {isPending && <Loader2 className="size-3.5 animate-spin" />}
                <ShieldCheck className="size-3.5" />
                <span>确认提交订单</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

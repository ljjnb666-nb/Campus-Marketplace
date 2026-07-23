"use client";

import React, { useState, useTransition } from "react";
import { Navigation, MapPin, X, CheckCircle2, Loader2, AlertTriangle, ShieldCheck } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";

interface ErrandClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: (formData: FormData) => Promise<{ success?: boolean; message?: string; redirectTo?: string } | void>;
  errand: {
    id: string;
    title: string;
    reward: number | string;
    pickupLocation: string;
    deliveryLocation: string;
    deadline: Date | string;
    needsAdvancePay: boolean;
    advanceAmount?: number | string | null;
  };
}

export function ErrandClaimDialog({
  open,
  onOpenChange,
  action,
  errand,
}: ErrandClaimDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  if (!open) return null;

  function formatDate(value: Date | string) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      try {
        const res = await action(formData);
        if (res && res.success === false) {
          setErrorMsg(res.message || "抢单失败，可能已被其他同学抢先接单");
        } else {
          setIsSuccess(true);
          setTimeout(() => {
            onOpenChange(false);
            setIsSuccess(false);
            if (res && res.redirectTo) {
              window.location.href = res.redirectTo;
            } else {
              window.location.href = "/my/orders?type=errand";
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
      {/* 遮罩背景 */}
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      {/* 对话框主体 */}
      <div className="relative w-full max-w-md overflow-hidden rounded-t-3xl sm:rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-slide-up sm:animate-scale-in dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400">
              <ShieldCheck className="size-4" />
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
              确认接受该跑腿任务
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
              接单成功！
            </h4>
            <p className="mt-1 text-xs text-slate-500">已成功抢单，请按照约定时间及时履约完成...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <input type="hidden" name="errandId" value={errand.id} />

            {/* 任务摘要与报酬 */}
            <div className="flex items-center justify-between rounded-2xl bg-slate-50 p-4 border border-slate-100 dark:bg-slate-950/40 dark:border-slate-800">
              <div className="space-y-1 min-w-0 pr-3">
                <p className="text-xs text-slate-400">任务标题</p>
                <h4 className="font-bold text-slate-900 truncate text-sm dark:text-slate-100">
                  {errand.title}
                </h4>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-slate-400">悬赏报酬</p>
                <PriceDisplay price={errand.reward} size="md" />
              </div>
            </div>

            {/* 路线与时间 */}
            <div className="space-y-2 rounded-2xl border border-slate-100 bg-white p-3.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950">
              <div className="flex items-center gap-2">
                <MapPin className="size-3.5 text-indigo-500 shrink-0" />
                <span className="font-semibold text-slate-900 dark:text-slate-200">取件位置：</span>
                <span className="truncate">{errand.pickupLocation}</span>
              </div>
              <div className="flex items-center gap-2">
                <Navigation className="size-3.5 text-emerald-500 shrink-0" />
                <span className="font-semibold text-slate-900 dark:text-slate-200">送达位置：</span>
                <span className="truncate">{errand.deliveryLocation}</span>
              </div>
              <div className="border-t border-slate-100 pt-2 flex items-center justify-between text-slate-500 dark:border-slate-800">
                <span>最迟送达时间：</span>
                <span className="font-semibold text-rose-600 dark:text-rose-400">{formatDate(errand.deadline)}</span>
              </div>
              {errand.needsAdvancePay && (
                <div className="rounded-xl bg-amber-50 p-2 text-amber-800 font-medium dark:bg-amber-950/40 dark:text-amber-300">
                  需要垫付：¥{errand.advanceAmount ? Number(errand.advanceAmount).toFixed(2) : "视实际情况而定"}
                </div>
              )}
            </div>

            {/* 安全提示 */}
            <div className="flex items-start gap-2 rounded-xl bg-indigo-50/70 p-3 text-[11px] text-indigo-800 border border-indigo-200/50 dark:bg-indigo-950/40 dark:text-indigo-300">
              <AlertTriangle className="size-4 shrink-0 text-indigo-600 mt-0.5" />
              <span>注意：抢单后请尽快通过私聊与发布者确认需求细节。请勿无故放弃接单。</span>
            </div>

            {errorMsg && <p className="text-xs text-rose-600 font-medium">{errorMsg}</p>}

            {/* 提交面板 */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
              >
                思考一下
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-600/20 hover:from-emerald-700 hover:to-emerald-800 disabled:opacity-50"
              >
                {isPending && <Loader2 className="size-3.5 animate-spin" />}
                <span>确认接单</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

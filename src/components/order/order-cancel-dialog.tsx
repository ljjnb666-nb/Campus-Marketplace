"use client";

import React, { useState, useTransition } from "react";
import { AlertCircle, X, Loader2 } from "lucide-react";

interface ActionResponse {
  success?: boolean;
  message?: string;
}

interface OrderCancelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: (formData: FormData) => Promise<ActionResponse | void>;
  orderId: string;
}

export function OrderCancelDialog({
  open,
  onOpenChange,
  action,
  orderId,
}: OrderCancelDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      try {
        const res = await action(formData);
        if (res && res.success === false) {
          setErrorMsg(res.message || "操作失败，当前订单状态可能已发生改变");
        } else {
          onOpenChange(false);
          window.location.reload();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "网络异常，请稍后重试";
        setErrorMsg(message);
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 遮罩 */}
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-scale-in dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-bold text-base">
            <AlertCircle className="size-5" />
            <span>确认取消该订单？</span>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-xl p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="status" value="CANCELLED" />

          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            订单取消后将不可恢复。如有押金或预付款，系统将按约定原路退回。
          </p>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              取消原因说明 (选填)
            </label>
            <input
              type="text"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：买家计划有变 / 时间冲突协商一致..."
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          {errorMsg && <p className="text-xs text-rose-600 font-medium">{errorMsg}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
            >
              再想想
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-5 py-2 text-xs font-bold text-white shadow-md hover:bg-amber-700 disabled:opacity-50"
            >
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
              <span>确认取消</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

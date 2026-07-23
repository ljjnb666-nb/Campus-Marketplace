"use client";

import React, { useState, useTransition } from "react";
import { ShieldAlert, X, Loader2 } from "lucide-react";

interface ActionResponse {
  success?: boolean;
  message?: string;
}

interface DisputeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: (formData: FormData) => Promise<ActionResponse | void>;
  orderId: string;
}

export function DisputeDialog({
  open,
  onOpenChange,
  action,
  orderId,
}: DisputeDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reason.trim()) {
      setErrorMsg("请填写申诉纠纷的具体原因与证据说明");
      return;
    }
    setErrorMsg(null);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      try {
        const res = await action(formData);
        if (res && res.success === false) {
          setErrorMsg(res.message || "提交申诉失败");
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
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-scale-in dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 font-bold text-base">
            <ShieldAlert className="size-5" />
            <span>发起订单维权申诉</span>
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

          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            申诉提交后订单将转入“纠纷处理中”状态，平台管理员与校区负责人将介入调查。
          </p>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              纠纷说明与具体事实 <span className="text-rose-500">*</span>
            </label>
            <textarea
              name="reason"
              rows={4}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="详细描述争议情况（如：物品与描述不符、未按时履约、设备存在隐蔽故障等）..."
              className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          {errorMsg && <p className="text-xs text-rose-600 font-medium">{errorMsg}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-2 text-xs font-bold text-white shadow-md hover:bg-rose-700 disabled:opacity-50"
            >
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
              <span>提交申诉</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

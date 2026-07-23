"use client";

import React, { useState, useTransition } from "react";
import { Flag, X, Loader2, ShieldAlert } from "lucide-react";

interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: (formData: FormData) => Promise<{ success?: boolean; message?: string } | void>;
  targetType: "PRODUCT" | "ERRAND" | "SERVICE" | "RENTAL" | "USER";
  productId?: string;
  errandTaskId?: string;
  serviceListingId?: string;
  rentalListingId?: string;
  targetUserId?: string;
}

const REPORT_REASONS = [
  "虚假信息 / 夸大宣传",
  "涉嫌违禁品 / 危险物品",
  "恶意毁约 / 拒不履约",
  "言语辱骂 / 骚扰他人",
  "价格欺诈 / 线下加价",
  "其他违法违规行为",
];

export function ReportDialog({
  open,
  onOpenChange,
  action,
  targetType,
  productId,
  errandTaskId,
  serviceListingId,
  rentalListingId,
  targetUserId,
}: ReportDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState(REPORT_REASONS[0]);
  const [detail, setDetail] = useState("");
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
          setErrorMsg(res.message || "提交举报失败");
        } else {
          setIsSuccess(true);
          setTimeout(() => {
            onOpenChange(false);
            setIsSuccess(false);
          }, 1200);
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
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-scale-in dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 font-bold text-base">
            <Flag className="size-5" />
            <span>发起违规举报</span>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-xl p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <X className="size-4" />
          </button>
        </div>

        {isSuccess ? (
          <div className="flex flex-col items-center justify-center py-8 text-center animate-scale-in">
            <ShieldAlert className="size-12 text-emerald-500" />
            <h4 className="mt-3 text-base font-bold text-slate-900 dark:text-slate-100">
              举报已成功提交
            </h4>
            <p className="mt-1 text-xs text-slate-500">平台客服与管理员将尽快完成核查并反馈结果...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <input type="hidden" name="targetType" value={targetType} />
            {productId && <input type="hidden" name="productId" value={productId} />}
            {errandTaskId && <input type="hidden" name="errandTaskId" value={errandTaskId} />}
            {serviceListingId && <input type="hidden" name="serviceListingId" value={serviceListingId} />}
            {rentalListingId && <input type="hidden" name="rentalListingId" value={rentalListingId} />}
            {targetUserId && <input type="hidden" name="targetUserId" value={targetUserId} />}

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                举报主要原因 <span className="text-rose-500">*</span>
              </label>
              <select
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
              >
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                具体事实说明与证据细节
              </label>
              <textarea
                name="detail"
                rows={3}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                placeholder="提供详细的聊天截图描述或违规细节，协助管理员快速处理..."
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
                <span>提交举报</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

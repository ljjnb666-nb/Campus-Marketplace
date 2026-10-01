"use client";

import React, { useActionState, useEffect } from "react";
import { ShieldAlert, X, Loader2 } from "lucide-react";

import { reportOrderMeetupNoShowAction, type OrderMeetupActionState } from "@/actions/order-meetup";

const initialState: OrderMeetupActionState = { success: false, message: "" };

interface NoShowDialogProps {
  orderId: string;
  meetupId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Phase 8D-02：报告对方未到场的确认 Dialog。
 *
 * 产品语义（冻结，§13F）：
 * - NO_SHOW_REPORTED = allegation / dispute trigger，绝不等于 guilt
 *   determination——文案必须写明"事实主张 ≠ 平台认定责任"；
 * - 禁止"举报成功 / 对方已违约 / 平台确认爽约"等判责措辞；
 * - reporter 恒为 session user，target 由 canonical service 从参与方
 *   结构推导，本表单不携带任何身份字段。
 */
export function NoShowDialog({ orderId, meetupId, open, onOpenChange }: NoShowDialogProps) {
  const [state, formAction, isPending] = useActionState(reportOrderMeetupNoShowAction, initialState);

  // 提交成功：canonical service 已同事务创建 dispute 并 revalidate，
  // 关闭 dialog 即可（页面经 server revalidation 刷新为新状态）
  useEffect(() => {
    if (state.success) {
      onOpenChange(false);
    }
  }, [state.success, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs animate-fade-in"
        onClick={() => onOpenChange(false)}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="no-show-dialog-title"
        className="relative w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl animate-scale-in dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-base font-bold text-rose-600 dark:text-rose-400">
            <ShieldAlert className="size-5" />
            <span id="no-show-dialog-title">报告对方未到场</span>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="关闭对话框"
            className="rounded-xl p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <X className="size-4" />
          </button>
        </div>

        <form action={formAction} className="mt-4 space-y-4">
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="meetupId" value={meetupId} />

          <div className="space-y-2 rounded-2xl bg-amber-50 p-4 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <p>提交「未到场报告」后，系统会创建订单纠纷并进入平台处理流程。</p>
            <p className="font-semibold">
              这只是你方提交的事实主张，不代表平台已经认定对方违约或判定责任。
            </p>
          </div>

          {state.message && !state.success && (
            <p className="text-xs font-medium text-rose-600" role="alert">
              {state.message}
            </p>
          )}

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
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-2 text-xs font-bold text-white shadow-md hover:bg-rose-700 disabled:opacity-50"
            >
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
              <span>提交未到场报告</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 触发按钮 + Dialog 状态组合（供 server 页面直接嵌入） */
export function NoShowSection({ orderId, meetupId }: { orderId: string; meetupId: string }) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <NoShowDialogTrigger onOpen={() => setOpen(true)} />
      <NoShowDialog
        orderId={orderId}
        meetupId={meetupId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/** 触发按钮（与 Dialog 拆开以便页面组合） */
export function NoShowDialogTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
    >
      <ShieldAlert className="size-3.5" />
      <span>报告对方未到场</span>
    </button>
  );
}

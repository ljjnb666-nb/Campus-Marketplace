"use client";

import React, { useActionState } from "react";
import { CheckCircle2, Loader2, XCircle, Footprints } from "lucide-react";

import {
  cancelOrderMeetupAction,
  confirmOrderMeetupAction,
  markOrderMeetupArrivalAction,
  type OrderMeetupActionState,
} from "@/actions/order-meetup";

const initialState: OrderMeetupActionState = { success: false, message: "" };

function ActionError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="text-xs font-medium text-rose-600" role="alert">
      {message}
    </p>
  );
}

/**
 * Phase 8D-02：确认 / 取消 / self-arrival 操作表单（stale-safe）。
 *
 * 页面按 server render 时刻的 policy 窗口谓词决定按钮是否展示
 * （convenience projection）；stale UI 提交（对方已取消 / 时间已到 /
 * 重复到场）由 canonical Tx service 锁内 FAIL CLOSED 并经 errors.ts
 * 映射为安全中文错误，本组件只负责展示。
 */

export function ConfirmMeetupForm({ orderId, meetupId }: { orderId: string; meetupId: string }) {
  const [state, formAction, isPending] = useActionState(confirmOrderMeetupAction, initialState);

  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="meetupId" value={meetupId} />
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-emerald-700 disabled:opacity-50"
      >
        {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
        <span>确认约定</span>
      </button>
      <ActionError message={state.success ? "" : state.message} />
    </form>
  );
}

export function CancelMeetupForm({ orderId, meetupId }: { orderId: string; meetupId: string }) {
  const [state, formAction, isPending] = useActionState(cancelOrderMeetupAction, initialState);

  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="meetupId" value={meetupId} />
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200/90 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
      >
        {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <XCircle className="size-3.5" />}
        <span>取消约定</span>
      </button>
      <ActionError message={state.success ? "" : state.message} />
    </form>
  );
}

export function ArrivalMeetupForm({ orderId, meetupId }: { orderId: string; meetupId: string }) {
  const [state, formAction, isPending] = useActionState(markOrderMeetupArrivalAction, initialState);

  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="meetupId" value={meetupId} />
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50"
      >
        {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Footprints className="size-3.5" />}
        <span>我已到达</span>
      </button>
      {/* 幂等成功（重复 self-arrival）也是 success 状态：按提示展示 */}
      <ActionError message={state.success ? "" : state.message} />
      {state.success && state.message && (
        <p className="text-xs font-medium text-emerald-600" role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}

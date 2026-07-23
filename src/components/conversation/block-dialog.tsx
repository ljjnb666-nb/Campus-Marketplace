"use client";

import { useActionState, useState } from "react";
import { ShieldAlert, UserX, Unlock } from "lucide-react";
import { blockUser, unblockUser } from "@/actions/trust";

interface BlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetUserId: string;
  targetUserName: string;
  isBlockedByMe: boolean;
  hasActiveOrder?: boolean;
}

export function BlockDialog({
  open,
  onOpenChange,
  targetUserId,
  targetUserName,
  isBlockedByMe,
  hasActiveOrder = false,
}: BlockDialogProps) {
  const actionToUse = isBlockedByMe ? unblockUser : blockUser;
  const [state, formAction, isPending] = useActionState(actionToUse, {
    success: false,
    message: "",
  });
  const [reason, setReason] = useState("消息打扰");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900 space-y-5">
        <div className="flex items-center gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
          <div className={`flex size-10 items-center justify-center rounded-2xl ${isBlockedByMe ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400" : "bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400"}`}>
            {isBlockedByMe ? <Unlock className="size-5" /> : <UserX className="size-5" />}
          </div>
          <div>
            <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base">
              {isBlockedByMe ? `解除拉黑 ${targetUserName}` : `拉黑用户 ${targetUserName}`}
            </h3>
            <p className="text-xs text-slate-500">
              {isBlockedByMe ? "解除后该同学将能够恢复与你发送私信沟通。" : "拉黑后该同学将无法继续向你发送私发消息。"}
            </p>
          </div>
        </div>

        {hasActiveOrder && !isBlockedByMe && (
          <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50/70 p-3.5 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
            <ShieldAlert className="size-4 shrink-0 text-amber-600 mt-0.5" />
            <p className="leading-relaxed">
              提示：你与该同学目前有正在履约中的订单或任务。拉黑后不会影响现有订单状态和交接确认，但可能导致必要交易沟通阻断，请谨慎操作。
            </p>
          </div>
        )}

        {state.message && (
          <div className={`rounded-xl p-3 text-xs font-semibold ${state.success ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"}`}>
            {state.message}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="targetUserId" value={targetUserId} />

          {!isBlockedByMe && (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                拉黑原因说明
              </label>
              <select
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
              >
                <option value="消息打扰">频繁发送无关营销或打扰消息</option>
                <option value="恶意言语">存在言语辱骂或不当言论</option>
                <option value="虚假交易">怀疑虚假交易或诈骗行为</option>
                <option value="其他原因">其他原因</option>
              </select>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isPending}
              className={`rounded-full px-5 py-2 text-xs font-bold text-white shadow-sm transition disabled:opacity-50 ${isBlockedByMe ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"}`}
            >
              {isPending ? "处理中..." : isBlockedByMe ? "确认解除拉黑" : "确认拉黑"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

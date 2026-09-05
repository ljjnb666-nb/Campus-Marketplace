"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  cancelPrivacyRequest,
  requestAccountDeletion,
  type PrivacyActionState,
} from "@/actions/privacy";
import { signOut } from "next-auth/react";

const initialState: PrivacyActionState = { success: false, message: "" };

function SubmitButton({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={
        danger
          ? "rounded-full bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-rose-300"
          : "rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
      }
    >
      {pending ? "处理中..." : label}
    </button>
  );
}

/**
 * 数据导出：一次点击直接触发唯一执行入口（GET /api/privacy/export）。
 * 该端点在一次请求内完成 REQUESTED→IN_PROGRESS→构建→COMPLETED 的完整
 * 生命周期（见 data-export.executeSynchronousDataExport）——点击即一条
 * COMPLETED 导出记录，不再产生孤儿 REQUESTED。
 */
export function ExportDataButton() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <a
        href="/api/privacy/export"
        data-testid="export-data-link"
        className="rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        导出我的数据（JSON）
      </a>
      <span className="text-xs text-slate-400">每次导出都会在隐私请求记录中留痕</span>
    </div>
  );
}

/** 账号注销：typed confirmation（需输入"注销账号"）→ 同步执行。 */
export function DeleteAccountForm() {
  const [state, formAction] = useActionState(requestAccountDeletion, initialState);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (state.signedOut) {
      const timer = setTimeout(() => {
        void signOut({ callbackUrl: "/" });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [state.signedOut]);

  return (
    <form action={formAction} className="space-y-3">
      <p className="text-sm leading-6 text-slate-600">
        注销后你的账号将无法登录，个人可识别信息将被删除或匿名化；历史订单与评价将以
        “已注销用户”的匿名形式保留，以维持交易记录完整性。存在进行中交易或治理冻结时，
        注销会被阻止且不会部分删除数据。
      </p>
      <label className="flex flex-col gap-2 text-sm">
        输入“注销账号”以确认
        <input
          name="confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="注销账号"
          autoComplete="off"
        />
      </label>
      <SubmitButton label="申请注销账号" danger />
      {state.message ? (
        <p
          className={`text-sm ${state.success ? "text-emerald-600" : "text-rose-600"}`}
          data-testid="deletion-result"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function CancelRequestForm({ requestId }: { requestId: string }) {
  const [state, formAction] = useActionState(cancelPrivacyRequest, initialState);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        className="text-xs text-slate-500 underline-offset-2 transition hover:text-slate-900 hover:underline"
      >
        {state.message && !state.success ? state.message : "取消"}
      </button>
    </form>
  );
}

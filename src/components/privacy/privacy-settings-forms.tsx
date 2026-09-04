"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  cancelPrivacyRequest,
  requestAccountDeletion,
  recordDataExportRequest,
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

/** 数据导出：先经 server action 留痕（含限流），再触发下载。 */
export function ExportDataButton() {
  const [state, formAction] = useActionState(async () => {
    return recordDataExportRequest();
  }, initialState);

  useEffect(() => {
    if (state.success) {
      window.open("/api/privacy/export", "_blank");
    }
  }, [state.success]);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <SubmitButton label="导出我的数据（JSON）" />
      {state.message ? (
        <span className={`text-sm ${state.success ? "text-emerald-600" : "text-rose-600"}`}>
          {state.message}
        </span>
      ) : null}
    </form>
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

"use client";

import { useActionState } from "react";
import Link from "next/link";
import { changePasswordAction, revokeSessionsAction, type AccountSecurityActionState } from "@/actions/account-sessions";

const initial: AccountSecurityActionState = { success: false, message: "" };
const inputClass = "block w-full rounded-lg border p-2";

export function PasswordChangeForm() {
  const [state, action, pending] = useActionState(changePasswordAction, initial);
  return <form action={action} className="space-y-3" aria-label="修改密码">
    <h2 className="text-lg font-semibold">修改密码</h2>
    <p className="text-sm text-slate-600">新密码需 8–64 位并包含大小写字母和数字。修改后所有设备将退出登录。</p>
    <label className="block">当前密码<input className={inputClass} name="currentPassword" type="password" autoComplete="current-password" required maxLength={72} /></label>
    <label className="block">新密码<input className={inputClass} name="newPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={64} /></label>
    <label className="block">确认新密码<input className={inputClass} name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={64} /></label>
    <button className="rounded-lg bg-indigo-600 px-4 py-2 text-white disabled:opacity-50" disabled={pending || state.signedOut}>
      {pending ? "正在修改…" : "修改密码并退出所有设备"}
    </button>
    {state.message && <p role="status">{state.message} {state.signedOut && <Link className="underline" href="/login">重新登录</Link>}</p>}
  </form>;
}

export function RevokeSessionForm({ mode, sessionId, label }: { mode: "ONE" | "OTHERS" | "ALL"; sessionId?: string; label: string }) {
  const [state, action, pending] = useActionState(revokeSessionsAction, initial);
  return <form action={action}>
    <input type="hidden" name="mode" value={mode} />
    {sessionId && <input type="hidden" name="sessionId" value={sessionId} />}
    <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={pending || state.signedOut}>{pending ? "正在处理…" : label}</button>
    {state.message && <p role="status" className="text-sm">{state.message} {state.signedOut && <Link className="underline" href="/login">重新登录</Link>}</p>}
  </form>;
}

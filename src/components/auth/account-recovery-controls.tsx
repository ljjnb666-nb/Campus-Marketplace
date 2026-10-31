"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { beginMfaAction, completeChallengeAction, confirmMfaAction, requestEmailVerificationAction, requestPasswordResetAction, type RecoveryState } from "@/actions/account-recovery";

const initial: RecoveryState = { success: false, message: "" };
const input = "block w-full rounded-lg border p-2";
const button = "rounded-lg bg-indigo-600 px-4 py-2 text-white disabled:opacity-50";

export function EmailVerificationControl({ verified }: { verified: boolean }) {
  const [state, action, pending] = useActionState(requestEmailVerificationAction, initial);
  return <section className="space-y-3"><h2 className="text-lg font-semibold">邮箱验证</h2>
    <p>{verified ? "邮箱已验证" : "请先验证邮箱，再发布信息、下单或发送消息。"}</p>
    {!verified && <form action={action}><button className={button} disabled={pending}>{pending ? "正在申请…" : "发送验证邮件"}</button></form>}
    {state.message && <p role="status">{state.message}</p>}
  </section>;
}

function MfaCodeForm({ mode, label }: { mode: "ENABLE" | "STEP_UP" | "DISABLE"; label: string }) {
  const [state, action, pending] = useActionState(confirmMfaAction, initial);
  return <form action={action} className="space-y-3" aria-label={label}>
    <input name="mode" type="hidden" value={mode} />
    <label className="block">验证器中的六位动态验证码<input className={input} name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" maxLength={6} required /></label>
    <button className={button} disabled={pending}>{label}</button>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}

export function MfaControls({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(beginMfaAction, initial);
  return <section className="space-y-4"><h2 className="text-lg font-semibold">验证器双重验证</h2>
    <p className="text-sm text-slate-600">管理操作必须启用并定期验证。登录及重置密码时需同时提供动态验证码。请备份验证器；遗失验证器后需要人工核验身份恢复。</p>
    {enabled ? <><MfaCodeForm mode="STEP_UP" label="验证以继续管理操作" /><MfaCodeForm mode="DISABLE" label="关闭双重验证" /></> : <>
      <form action={action} className="space-y-3"><label className="block">当前密码<input className={input} name="password" type="password" autoComplete="current-password" maxLength={72} required /></label>
        <button className={button} disabled={pending}>开始绑定验证器</button>
      </form>
      {state.message && <p role="status">{state.message}</p>}
      {state.setupSecret && <div className="space-y-3 rounded-lg border p-4"><p>验证器设置：TOTP，6 位，30 秒，SHA-1。</p><code className="block break-all select-all">{state.setupSecret}</code><MfaCodeForm mode="ENABLE" label="确认启用双重验证" /></div>}
    </>}
  </section>;
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, initial);
  return <form action={action} className="space-y-4"><label className="block">注册邮箱<input className={input} name="email" type="email" autoComplete="email" required maxLength={254} /></label>
    <button className={button} disabled={pending}>发送密码重置邮件</button>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}

export function ConfirmAccountChallengeForm() {
  const fragmentRead = useRef(false);
  const revision = useRef(0);
  const [link, setLink] = useState<{ params: URLSearchParams; revision: number } | null>(null);
  useEffect(() => {
    const readFragment = () => {
      // Strict Mode replays effects after we have removed the original hash.
      if (!window.location.hash && fragmentRead.current) return;
      fragmentRead.current = true;
      const params = new URLSearchParams(window.location.hash.slice(1));
      setLink({ params, revision: ++revision.current });
      window.history.replaceState(null, "", window.location.pathname);
    };
    // An external email can navigate to another hash on this same mounted page.
    // Each such navigation must reset the previous submission result as well.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    readFragment();
    window.addEventListener("hashchange", readFragment);
    return () => window.removeEventListener("hashchange", readFragment);
  }, []);
  if (!link) return <p>正在读取邮件链接…</p>;
  return <ChallengeSubmissionForm key={link.revision} params={link.params} />;
}

function ChallengeSubmissionForm({ params }: { params: URLSearchParams }) {
  const [state, action, pending] = useActionState(completeChallengeAction, initial);
  const purpose = params.get("purpose");
  if (!params.get("id") || !params.get("token") || !["VERIFY_EMAIL", "RESET_PASSWORD"].includes(purpose ?? "")) return <p>链接不完整，请重新打开邮件中的完整链接。</p>;
  return <form action={action} className="space-y-4">
    {["id", "token", "purpose"].map((name) => <input key={name} name={name} type="hidden" value={params.get(name) ?? ""} />)}
    {purpose === "RESET_PASSWORD" && <>
      <p>新密码需 8–64 位，含大小写字母和数字。重置后所有设备退出。</p>
      <label className="block">新密码<input name="newPassword" className={input} type="password" autoComplete="new-password" minLength={8} maxLength={64} required /></label>
      <label className="block">确认新密码<input name="confirmPassword" className={input} type="password" autoComplete="new-password" minLength={8} maxLength={64} required /></label>
      <label className="block">动态验证码（已启用双重验证时必填）<input name="mfaCode" className={input} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} /></label>
    </>}
    <button className={button} disabled={pending || state.success}>{purpose === "RESET_PASSWORD" ? "重置密码" : "确认验证邮箱"}</button>
    {state.message && <p role="status">{state.message}</p>}
    {state.success && <Link className="block underline" href={purpose === "RESET_PASSWORD" ? "/login" : "/my/security"}>继续</Link>}
  </form>;
}

"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useState, useSyncExternalStore } from "react";

// SSR and the initial hydration render must agree: submit stays disabled until
// React has attached the credentials onSubmit handler in the browser.
const subscribeToHydration = () => () => {};
const getClientHydration = () => true;
const getServerHydration = () => false;

export function LoginForm() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydration,
    getServerHydration,
  );

  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");

        const formData = new FormData(event.currentTarget);
        try {
          const result = await signIn("credentials", {
            email: formData.get("email"),
            password: formData.get("password"),
            // next-auth serializes options as form data: undefined becomes the
            // literal "undefined", which fails the server's credential schema.
            mfaCode: formData.get("mfaCode") ?? "",
            redirect: false,
            callbackUrl: "/",
          });

          // No response is not a successful authentication.
          if (!result) {
            setError("登录暂时不可用，请稍后重试");
            return;
          }
          if (result.error) {
            setError("邮箱、密码或动态验证码错误");
            return;
          }
          // A non-error object still needs a successful result and a target URL.
          if (result.ok === false || !result.url) {
            setError("登录暂时不可用，请稍后重试");
            return;
          }

          window.location.href = result.url;
        } catch {
          // A rejected auth request must not strand the form in the pending state.
          // Never surface raw exceptions or credential details to the UI/logs.
          setError("登录暂时不可用，请稍后重试");
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="flex flex-col gap-2 text-sm">
        邮箱
        <input
          name="email"
          type="email"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-slate-400"
          placeholder="student1@campus.local"
          required
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        密码
        <input
          name="password"
          type="password"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-slate-400"
          placeholder="Student123456"
          required
        />
      </label>

      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
      <label className="flex flex-col gap-2 text-sm">动态验证码（已启用双重验证时必填）
        <input name="mfaCode" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" className="rounded-2xl border border-slate-200 px-4 py-3" />
      </label>
      <Link href="/forgot-password" className="text-sm underline">忘记密码</Link>

      <div className="flex items-center justify-between gap-4">
        <button
          type="submit"
          disabled={pending || !hydrated}
          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {pending ? "登录中..." : "登录"}
        </button>
        <div className="flex flex-col items-end gap-2">
          <Link href="/register" className="text-sm text-slate-600 transition hover:text-slate-950">
            没有账号，去注册
          </Link>
          <Link href="/appeals" className="text-sm text-slate-600 underline hover:text-slate-950">
            账号受限？进入申诉
          </Link>
        </div>
      </div>
    </form>
  );
}

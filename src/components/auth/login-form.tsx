"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useState } from "react";

export function LoginForm() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");

        const formData = new FormData(event.currentTarget);
        const result = await signIn("credentials", {
          email: formData.get("email"),
          password: formData.get("password"),
          redirect: false,
          callbackUrl: "/",
        });

        setPending(false);

        if (result?.error) {
          setError("邮箱或密码错误");
          return;
        }

        window.location.href = result?.url ?? "/";
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

      <div className="flex items-center justify-between gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {pending ? "登录中..." : "登录"}
        </button>
        <Link href="/register" className="text-sm text-slate-600 transition hover:text-slate-950">
          没有账号，去注册
        </Link>
      </div>
    </form>
  );
}

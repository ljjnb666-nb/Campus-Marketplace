import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "登录 | 校园集市",
};

export default function LoginPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl px-4 py-16 sm:px-6">
      <div className="grid w-full gap-10 rounded-[32px] border border-slate-200 bg-white p-8 shadow-sm lg:grid-cols-[0.9fr_1.1fr] lg:p-10">
        <div className="space-y-4">
          <p className="text-sm font-medium text-sky-700">欢迎回来</p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">登录校园集市</h1>
          <p className="text-sm leading-7 text-slate-600">
            当前阶段已启用本地凭证登录。测试学生账号：
            <br />
            <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
              student1@campus.local / Student123456
            </code>
          </p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}

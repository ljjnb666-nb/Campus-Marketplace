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
            使用你的校园集市账号登录。若已启用双重验证，请同时填写验证器中的动态验证码。
            遇到账号访问问题时，可通过密码找回或受限账号申诉入口继续处理。
          </p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}

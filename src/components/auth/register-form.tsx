"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { registerUser, type ActionState } from "@/actions/auth";

const initialState: ActionState = {
  success: false,
  message: "",
};

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
    >
      {pending ? "提交中..." : "注册账户"}
    </button>
  );
}

export function RegisterForm({
  campuses,
}: {
  campuses: { id: string; name: string; schoolName: string }[];
}) {
  const [state, formAction] = useActionState(registerUser, initialState);
  const [campusId, setCampusId] = useState(campuses[0]?.id ?? "");
  const selectedCampus = campuses.find((campus) => campus.id === campusId) ?? campuses[0] ?? null;

  useEffect(() => {
    if (state.success) {
      const form = document.getElementById("register-form") as HTMLFormElement | null;
      form?.reset();
    }
  }, [state.success]);

  return (
    <form id="register-form" action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          昵称
          <input
            name="name"
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-slate-400"
            placeholder="例如：小林"
            required
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          学校
          <input
            name="schoolName"
            value={selectedCampus?.schoolName ?? ""}
            readOnly
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-slate-400"
            required
          />
        </label>
      </div>

      <label className="flex flex-col gap-2 text-sm">
        邮箱
        <input
          name="email"
          type="email"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-slate-400"
          placeholder="student@campus.local"
          required
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        校区
        <select
          name="campusId"
          value={campusId}
          onChange={(event) => setCampusId(event.target.value)}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
        >
          {campuses.map((campus) => (
            <option key={campus.id} value={campus.id}>
              {campus.schoolName} · {campus.name}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          密码
          <input
            name="password"
            type="password"
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-slate-400"
            required
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          确认密码
          <input
            name="confirmPassword"
            type="password"
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none ring-0 transition focus:border-slate-400"
            required
          />
        </label>
      </div>

      {state.message ? (
        <p className={state.success ? "text-sm text-emerald-600" : "text-sm text-rose-600"}>
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-4">
        <SubmitButton />
        <Link href="/login" className="text-sm text-slate-600 transition hover:text-slate-950">
          已有账号，去登录
        </Link>
      </div>
    </form>
  );
}

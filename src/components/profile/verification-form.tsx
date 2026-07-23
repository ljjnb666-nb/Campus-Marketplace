"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import type { UserActionState } from "@/actions/user";

type VerificationFormValues = {
  schoolName: string;
  campusName?: string | null;
  studentIdLast4?: string | null;
  studentCardImage?: string | null;
};

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
    >
      {pending ? "提交中..." : "提交认证"}
    </button>
  );
}

export function VerificationForm({
  action,
  initialValues,
}: {
  action: (
    state: UserActionState,
    formData: FormData,
  ) => Promise<UserActionState>;
  initialValues: VerificationFormValues;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, {
    success: false,
    message: "",
  });

  useEffect(() => {
    if (state.success && state.redirectTo) {
      router.push(state.redirectTo);
      router.refresh();
    }
  }, [router, state.redirectTo, state.success]);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          学校名称
          <input
            name="schoolName"
            defaultValue={initialValues.schoolName}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          校区名称
          <input
            name="campusName"
            defaultValue={initialValues.campusName ?? ""}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          学号后四位
          <input
            name="studentIdLast4"
            defaultValue={initialValues.studentIdLast4 ?? ""}
            required
            maxLength={4}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="例如 2048"
          />
        </label>
        <div className="flex flex-col gap-2 text-sm">
          <span>学生证图片</span>
          <input
            name="studentCardImage"
            defaultValue={initialValues.studentCardImage ?? ""}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="也可以填写外部图片 URL"
          />
          <input
            name="studentCardImageFile"
            type="file"
            accept="image/*"
            className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-600"
          />
        </div>
      </div>

      {state.message ? (
        <p className={state.success ? "text-sm text-emerald-600" : "text-sm text-rose-600"}>
          {state.message}
        </p>
      ) : null}

      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}

"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import type { TrustActionState } from "@/actions/trust";

const initialState: TrustActionState = {
  success: false,
  message: "",
};

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
    >
      {pending ? "提交中..." : "提交评价"}
    </button>
  );
}

export function ReviewForm({
  action,
  orderId,
  targetUserId,
}: {
  action: (
    state: TrustActionState,
    formData: FormData,
  ) => Promise<TrustActionState>;
  orderId: string;
  targetUserId: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, initialState);

  useEffect(() => {
    if (state.success && state.redirectTo) {
      router.push(state.redirectTo);
      router.refresh();
    }
  }, [router, state.redirectTo, state.success]);

  return (
    <form action={formAction} className="space-y-3 rounded-[24px] border border-slate-200 bg-slate-50 p-4">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="targetUserId" value={targetUserId} />

      <p className="text-sm font-medium text-slate-950">提交评价</p>

      <label className="flex flex-col gap-2 text-sm">
        评分
        <select
          name="rating"
          defaultValue="5"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
        >
          <option value="5">5 分</option>
          <option value="4">4 分</option>
          <option value="3">3 分</option>
          <option value="2">2 分</option>
          <option value="1">1 分</option>
        </select>
      </label>

      <label className="flex flex-col gap-2 text-sm">
        标签
        <input
          name="tags"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="例如：回复及时, 守时, 沟通顺畅"
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        评价内容
        <textarea
          name="content"
          rows={3}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="补充评价内容"
        />
      </label>

      {state.message ? (
        <p className={state.success ? "text-sm text-emerald-600" : "text-sm text-rose-600"}>
          {state.message}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}

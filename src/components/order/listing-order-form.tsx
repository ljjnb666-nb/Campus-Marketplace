"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import type { OrderActionState } from "@/actions/order";

const initialState: OrderActionState = {
  success: false,
  message: "",
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
    >
      {pending ? "提交中..." : label}
    </button>
  );
}

export function ListingOrderForm({
  action,
  targetFieldName,
  targetId,
  title,
  description,
  submitLabel,
  defaultMeetingLocation,
  notePlaceholder,
}: {
  action: (
    state: OrderActionState,
    formData: FormData,
  ) => Promise<OrderActionState>;
  targetFieldName: "productId" | "serviceId";
  targetId: string;
  title: string;
  description: string;
  submitLabel: string;
  defaultMeetingLocation?: string;
  notePlaceholder: string;
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
    <form action={formAction} className="space-y-4 rounded-[24px] border border-slate-200 bg-slate-50 p-5">
      <input type="hidden" name={targetFieldName} value={targetId} />
      <div>
        <p className="text-sm font-medium text-slate-950">{title}</p>
        <p className="mt-1 text-sm text-slate-600">{description}</p>
      </div>

      <label className="flex flex-col gap-2 text-sm">
        见面地点
        <input
          name="meetingLocation"
          defaultValue={defaultMeetingLocation}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="例如：图书馆一楼大厅 / 南门咖啡店"
          required
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        备注说明
        <textarea
          name="note"
          rows={4}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder={notePlaceholder}
        />
      </label>

      {state.message ? (
        <p className={state.success ? "text-sm text-emerald-600" : "text-sm text-rose-600"}>
          {state.message}
        </p>
      ) : null}

      <SubmitButton label={submitLabel} />
    </form>
  );
}

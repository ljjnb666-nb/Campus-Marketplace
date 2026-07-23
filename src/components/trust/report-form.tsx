"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { TrustActionState } from "@/actions/trust";
import { REPORT_REASON_LABELS } from "@/constants/report";

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
      className="rounded-full border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "提交中..." : "提交举报"}
    </button>
  );
}

export function ReportForm({
  action,
  targetType,
  productId,
  errandTaskId,
  serviceListingId,
  targetUserId,
  messageId,
  compact = false,
}: {
  action: (
    state: TrustActionState,
    formData: FormData,
  ) => Promise<TrustActionState>;
  targetType: "PRODUCT" | "ERRAND_TASK" | "SERVICE_LISTING" | "USER" | "MESSAGE";
  productId?: string;
  errandTaskId?: string;
  serviceListingId?: string;
  targetUserId?: string;
  messageId?: string;
  compact?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialState);

  return (
    <form
      action={formAction}
      className={`space-y-3 rounded-[24px] border border-rose-100 bg-rose-50 ${
        compact ? "p-4" : "p-5"
      }`}
    >
      <input type="hidden" name="targetType" value={targetType} />
      {productId ? <input type="hidden" name="productId" value={productId} /> : null}
      {errandTaskId ? <input type="hidden" name="errandTaskId" value={errandTaskId} /> : null}
      {serviceListingId ? (
        <input type="hidden" name="serviceListingId" value={serviceListingId} />
      ) : null}
      {targetUserId ? <input type="hidden" name="targetUserId" value={targetUserId} /> : null}
      {messageId ? <input type="hidden" name="messageId" value={messageId} /> : null}

      <p className="text-sm font-medium text-rose-900">举报内容</p>

      <label className="flex flex-col gap-2 text-sm">
        举报原因
        <select
          name="reason"
          defaultValue="FAKE_INFO"
          className="rounded-2xl border border-rose-100 bg-white px-4 py-3 outline-none transition focus:border-rose-300"
        >
          {Object.entries(REPORT_REASON_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-2 text-sm">
        补充说明
        <textarea
          name="detail"
          rows={compact ? 2 : 4}
          className="rounded-2xl border border-rose-100 bg-white px-4 py-3 outline-none transition focus:border-rose-300"
          placeholder="补充描述问题细节，便于后续处理。"
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

"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { GovernanceVerificationActionState } from "@/actions/governance-verifications";

const initialState: GovernanceVerificationActionState = { success: false };

function SubmitButton({
  label,
  pendingLabel,
  variant,
  name,
  value,
  disabled,
}: {
  label: string;
  pendingLabel: string;
  variant: "primary" | "secondary" | "danger";
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending || disabled}
      className={
        variant === "primary"
          ? "rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          : variant === "danger"
            ? "rounded-full border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 transition hover:border-red-300 disabled:cursor-not-allowed disabled:text-red-300"
            : "rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:text-slate-400"
      }
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Feedback({ state }: { state: GovernanceVerificationActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        审核决定已提交。
      </p>
    );
  }
  return null;
}

/**
 * 认证审核操作表单：PENDING → VERIFIED/REJECTED、VERIFIED → REVOKED。
 * 流转合法性由 canonical decideMembershipVerification 锁内断言（UI 过期 →
 * 统一错误反馈）；不复制 transition table 到表单。
 */
export function VerificationReviewForm({
  action,
  verificationId,
  status,
}: {
  action: (formData: FormData) => Promise<GovernanceVerificationActionState>;
  verificationId: string;
  status: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceVerificationActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="认证审核">
      <input type="hidden" name="verificationId" value={verificationId} />
      <label className="flex flex-col gap-2 text-sm">
        审核备注
        <textarea
          name="reviewNote"
          rows={4}
          maxLength={200}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="补充审核说明"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <SubmitButton
          label="通过认证"
          pendingLabel="提交中..."
          variant="primary"
          name="decision"
          value="VERIFIED"
          disabled={status !== "PENDING"}
        />
        <SubmitButton
          label="驳回申请"
          pendingLabel="提交中..."
          variant="secondary"
          name="decision"
          value="REJECTED"
          disabled={status !== "PENDING"}
        />
        <SubmitButton
          label="吊销认证"
          pendingLabel="提交中..."
          variant="danger"
          name="decision"
          value="REVOKED"
          disabled={status !== "VERIFIED"}
        />
      </div>
      <Feedback state={state} />
    </form>
  );
}

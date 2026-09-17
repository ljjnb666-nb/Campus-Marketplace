"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { GovernanceReportActionState } from "@/actions/governance-reports";

const initialState: GovernanceReportActionState = { success: false };

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
  variant: "primary" | "secondary";
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
          : "rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:text-slate-400"
      }
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Feedback({ state }: { state: GovernanceReportActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.success && state.outcome) {
    const copy =
      state.outcome === "CLAIMED"
        ? "已领用该举报 case"
        : state.outcome === "RELEASED"
          ? "已释放该举报 case"
          : state.outcome === "ALREADY_YOURS"
            ? "你已领用该举报 case"
            : "该举报 case 当前未被领用";
    return (
      <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        {copy}
      </p>
    );
  }
  if (state.success) {
    return (
      <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        操作已提交。
      </p>
    );
  }
  return null;
}

/** case 领用（self claim）。已被他人领用时由域服务 fail closed 并回传文案。 */
export function ClaimCaseForm({
  action,
  reportId,
}: {
  action: (formData: FormData) => Promise<GovernanceReportActionState>;
  reportId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceReportActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="领用 case">
      <input type="hidden" name="reportId" value={reportId} />
      <SubmitButton label="领用 case" pendingLabel="提交中..." variant="primary" />
      <Feedback state={state} />
    </form>
  );
}

/** case 释放（self release）。 */
export function ReleaseCaseForm({
  action,
  reportId,
}: {
  action: (formData: FormData) => Promise<GovernanceReportActionState>;
  reportId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceReportActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="释放 case">
      <input type="hidden" name="reportId" value={reportId} />
      <SubmitButton label="释放 case" pendingLabel="提交中..." variant="secondary" />
      <Feedback state={state} />
    </form>
  );
}

/**
 * 审核操作表单：IN_REVIEW / RESOLVED / REJECTED（OPEN 无客户端路径）。
 * 流转合法性由 canonical 服务在行锁内断言（UI 过期 → 统一错误反馈）。
 */
export function ReportReviewForm({
  action,
  reportId,
  showReviewAction,
}: {
  action: (formData: FormData) => Promise<GovernanceReportActionState>;
  reportId: string;
  showReviewAction: boolean;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceReportActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="举报审核">
      <input type="hidden" name="reportId" value={reportId} />
      <label className="flex flex-col gap-2 text-sm">
        处理备注
        <textarea
          name="handledNote"
          rows={4}
          maxLength={300}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="填写处理说明"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <SubmitButton
          label="标记处理中"
          pendingLabel="提交中..."
          variant="secondary"
          name="status"
          value="IN_REVIEW"
          disabled={!showReviewAction}
        />
        <SubmitButton
          label="处理完成"
          pendingLabel="提交中..."
          variant="primary"
          name="status"
          value="RESOLVED"
          disabled={!showReviewAction}
        />
        <SubmitButton
          label="驳回举报"
          pendingLabel="提交中..."
          variant="secondary"
          name="status"
          value="REJECTED"
          disabled={!showReviewAction}
        />
      </div>
      <Feedback state={state} />
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { DECISION_REASON_LABELS } from "@/constants/governance";
import type { GovernanceAppealActionState } from "@/actions/governance-appeals";

const initialState: GovernanceAppealActionState = { success: false };

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

function Feedback({ state }: { state: GovernanceAppealActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.success && state.outcome) {
    const reason =
      state.reasonCode && state.reasonCode in DECISION_REASON_LABELS
        ? DECISION_REASON_LABELS[state.reasonCode as keyof typeof DECISION_REASON_LABELS]
        : null;
    return (
      <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        决定已提交，处理结果：
        {state.outcome === "GRANTED"
          ? "申诉通过，处罚已解除"
          : state.outcome === "UPHELD"
            ? "原处罚维持不变"
            : "已按平台流程处理完毕"}
        {reason ? `（${reason}）` : ""}
      </p>
    );
  }
  return null;
}

/**
 * W1「开始审核」表单（SUBMITTED 态呈现）。IN_REVIEW 仅是 workflow 状态、
 * 无 claimant 语义：不渲染任何"已分配/已认领/被锁定"文案（§23 冻结）。
 */
export function BeginReviewForm({
  action,
  appealId,
}: {
  action: (formData: FormData) => Promise<GovernanceAppealActionState>;
  appealId: string;
}) {
  const [state, formAction] = useActionState(async (_prev: GovernanceAppealActionState, formData: FormData) => action(formData), initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="appealId" value={appealId} />
      <SubmitButton label="开始审核" pendingLabel="提交中..." variant="primary" />
      <Feedback state={state} />
    </form>
  );
}

/**
 * 终局决定表单（IN_REVIEW 态呈现）。人工输入仅 GRANTED | UPHELD——
 * 程序性 DISMISSED 由 canonical 域服务计算并以成功结局回传展示（§28）。
 * canGrant=false 时（有审核权、无恢复权）不渲染"通过申诉"：
 * 伪造提交仍会被 canonical seam 权限复核拒绝并整体回滚（A-15）。
 */
export function DecideReviewForm({
  action,
  appealId,
  canGrant,
}: {
  action: (formData: FormData) => Promise<GovernanceAppealActionState>;
  appealId: string;
  canGrant: boolean;
}) {
  const [state, formAction] = useActionState(async (_prev: GovernanceAppealActionState, formData: FormData) => action(formData), initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="appealId" value={appealId} />
      <label className="flex flex-col gap-2 text-sm">
        审核备注（可选）
        <textarea
          name="decisionNote"
          rows={4}
          maxLength={1000}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="记录本次决定的审核依据"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <SubmitButton
          label="维持处罚"
          pendingLabel="提交中..."
          variant="secondary"
          name="decision"
          value="UPHELD"
        />
        <SubmitButton
          label="通过申诉"
          pendingLabel="提交中..."
          variant="primary"
          name="decision"
          value="GRANTED"
          disabled={!canGrant}
        />
      </div>
      <Feedback state={state} />
    </form>
  );
}

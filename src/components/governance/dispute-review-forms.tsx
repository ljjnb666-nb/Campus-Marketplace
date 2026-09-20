"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { GovernanceDisputeActionState } from "@/actions/governance-disputes";
import {
  DISPUTE_RESOLUTION_ACTION_LABELS,
  DISPUTE_RESOLUTION_CODE_LABELS,
} from "@/constants/dispute";

const initialState: GovernanceDisputeActionState = { success: false };

function SubmitButton({
  label,
  pendingLabel,
  variant,
}: {
  label: string;
  pendingLabel: string;
  variant: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
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

function Feedback({ state }: { state: GovernanceDisputeActionState }) {
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
        ? "已领用该纠纷"
        : state.outcome === "RELEASED"
          ? "已释放该纠纷"
          : state.outcome === "ALREADY_YOURS"
            ? "你已领用该纠纷"
            : "该纠纷当前未被领用";
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

/** 纠纷领用（self claim）。已被他人领用时由域服务 fail closed 并回传文案。 */
export function ClaimDisputeForm({
  action,
  disputeId,
}: {
  action: (formData: FormData) => Promise<GovernanceDisputeActionState>;
  disputeId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceDisputeActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="领用纠纷">
      <input type="hidden" name="disputeId" value={disputeId} />
      <SubmitButton label="领用处理" pendingLabel="提交中..." variant="primary" />
      <Feedback state={state} />
    </form>
  );
}

/** 纠纷释放（self release）。 */
export function ReleaseDisputeForm({
  action,
  disputeId,
}: {
  action: (formData: FormData) => Promise<GovernanceDisputeActionState>;
  disputeId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceDisputeActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="释放纠纷">
      <input type="hidden" name="disputeId" value={disputeId} />
      <SubmitButton label="释放领用" pendingLabel="提交中..." variant="secondary" />
      <Feedback state={state} />
    </form>
  );
}

function ResolutionActionSelect() {
  return (
    <label className="flex flex-col gap-2 text-sm">
      订单收敛动作
      <select
        name="resolutionAction"
        required
        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
      >
        {Object.entries(DISPUTE_RESOLUTION_ACTION_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AdminNoteInput() {
  return (
    <label className="flex flex-col gap-2 text-sm">
      操作备注（内部）
      <textarea
        name="adminNote"
        rows={3}
        maxLength={500}
        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
        placeholder="填写处理说明（可选）"
      />
    </label>
  );
}

/**
 * 终局操作表单：解决（resolutionCode + 收敛动作）与关闭（收敛动作）分开
 * 提交。流转合法性 / RESTORE_PREVIOUS 可用性（openedFromOrderStatus 缺失
 * → DENY）由 canonical 服务在行锁内断言（UI 过期 → 统一错误反馈）。
 */
export function DisputeDecisionForms({
  resolveAction,
  closeAction,
  disputeId,
}: {
  resolveAction: (formData: FormData) => Promise<GovernanceDisputeActionState>;
  closeAction: (formData: FormData) => Promise<GovernanceDisputeActionState>;
  disputeId: string;
}) {
  const [resolveState, resolveFormAction] = useActionState(
    async (_prev: GovernanceDisputeActionState, formData: FormData) => resolveAction(formData),
    initialState,
  );
  const [closeState, closeFormAction] = useActionState(
    async (_prev: GovernanceDisputeActionState, formData: FormData) => closeAction(formData),
    initialState,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form
        action={resolveFormAction}
        className="space-y-3 rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="解决纠纷"
      >
        <h3 className="text-sm font-semibold text-slate-900">解决纠纷</h3>
        <input type="hidden" name="disputeId" value={disputeId} />
        <label className="flex flex-col gap-2 text-sm">
          处理结果
          <select
            name="resolutionCode"
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          >
            {Object.entries(DISPUTE_RESOLUTION_CODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <ResolutionActionSelect />
        <AdminNoteInput />
        <SubmitButton label="标记已解决" pendingLabel="提交中..." variant="primary" />
        <Feedback state={resolveState} />
      </form>
      <form
        action={closeFormAction}
        className="space-y-3 rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="关闭纠纷"
      >
        <h3 className="text-sm font-semibold text-slate-900">关闭纠纷</h3>
        <input type="hidden" name="disputeId" value={disputeId} />
        <ResolutionActionSelect />
        <AdminNoteInput />
        <SubmitButton label="关闭纠纷" pendingLabel="提交中..." variant="secondary" />
        <Feedback state={closeState} />
      </form>
    </div>
  );
}

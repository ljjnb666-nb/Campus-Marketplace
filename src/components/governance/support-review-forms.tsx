"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { GovernanceSupportActionState } from "@/actions/governance-support";
import { SUPPORT_RESOLUTION_CODE_LABELS } from "@/constants/support";

const initialState: GovernanceSupportActionState = { success: false };

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

function Feedback({ state }: { state: GovernanceSupportActionState }) {
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
        ? "已领用该工单"
        : state.outcome === "RELEASED"
          ? "已释放该工单"
          : state.outcome === "ALREADY_YOURS"
            ? "你已领用该工单"
            : "该工单当前未被领用";
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

/** 工单领用（self claim）。已被他人领用时由域服务 fail closed 并回传文案。 */
export function ClaimTicketForm({
  action,
  ticketId,
}: {
  action: (formData: FormData) => Promise<GovernanceSupportActionState>;
  ticketId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceSupportActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="领用工单">
      <input type="hidden" name="ticketId" value={ticketId} />
      <SubmitButton label="领用处理" pendingLabel="提交中..." variant="primary" />
      <Feedback state={state} />
    </form>
  );
}

/** 工单释放（self release）。 */
export function ReleaseTicketForm({
  action,
  ticketId,
}: {
  action: (formData: FormData) => Promise<GovernanceSupportActionState>;
  ticketId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceSupportActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="释放工单">
      <input type="hidden" name="ticketId" value={ticketId} />
      <SubmitButton label="释放领用" pendingLabel="提交中..." variant="secondary" />
      <Feedback state={state} />
    </form>
  );
}

/**
 * 终局操作表单：解决（resolutionCode + USER_VISIBLE 说明 + OPERATOR_ONLY
 * 内部备注）与关闭（内部备注）。字段分离冻结：resolutionMessage 为用户可见、
 * internalNote 仅操作员——requester 读面结构性不返回 internalNote。
 */
export function TicketDecisionForms({
  resolveAction,
  closeAction,
  ticketId,
}: {
  resolveAction: (formData: FormData) => Promise<GovernanceSupportActionState>;
  closeAction: (formData: FormData) => Promise<GovernanceSupportActionState>;
  ticketId: string;
}) {
  const [resolveState, resolveFormAction] = useActionState(
    async (_prev: GovernanceSupportActionState, formData: FormData) => resolveAction(formData),
    initialState,
  );
  const [closeState, closeFormAction] = useActionState(
    async (_prev: GovernanceSupportActionState, formData: FormData) => closeAction(formData),
    initialState,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form
        action={resolveFormAction}
        className="space-y-3 rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="解决工单"
      >
        <h3 className="text-sm font-semibold text-slate-900">解决工单</h3>
        <input type="hidden" name="ticketId" value={ticketId} />
        <label className="flex flex-col gap-2 text-sm">
          处理结果
          <select
            name="resolutionCode"
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          >
            {Object.entries(SUPPORT_RESOLUTION_CODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          处理结果说明（用户可见）
          <textarea
            name="resolutionMessage"
            rows={3}
            maxLength={500}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="将展示给提交者（可选）"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          内部备注（仅操作员）
          <textarea
            name="internalNote"
            rows={3}
            maxLength={500}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="仅运营内部可见（可选）"
          />
        </label>
        <SubmitButton label="标记已解决" pendingLabel="提交中..." variant="primary" />
        <Feedback state={resolveState} />
      </form>
      <form
        action={closeFormAction}
        className="space-y-3 rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="关闭工单"
      >
        <h3 className="text-sm font-semibold text-slate-900">关闭工单</h3>
        <input type="hidden" name="ticketId" value={ticketId} />
        <label className="flex flex-col gap-2 text-sm">
          内部备注（仅操作员）
          <textarea
            name="internalNote"
            rows={3}
            maxLength={500}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
            placeholder="仅运营内部可见（可选）"
          />
        </label>
        <SubmitButton label="关闭工单" pendingLabel="提交中..." variant="secondary" />
        <Feedback state={closeState} />
      </form>
    </div>
  );
}

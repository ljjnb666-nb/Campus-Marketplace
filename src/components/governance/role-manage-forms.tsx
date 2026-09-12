"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { GovernanceRoleActionState } from "@/actions/governance-roles";
import { GOVERNANCE_ROLE_GRANT_HINT } from "@/constants/governance-roles";

const initialState: GovernanceRoleActionState = { success: false };

function SubmitButton({
  label,
  pendingLabel,
  variant,
  disabled,
}: {
  label: string;
  pendingLabel: string;
  variant: "primary" | "secondary";
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
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

function StateFeedback({ state }: { state: GovernanceRoleActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.success && state.message) {
    return (
      <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        {state.message}
      </p>
    );
  }
  return null;
}

function CampusSelect({ campuses }: { campuses: { id: string; name: string }[] }) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      校区
      <select
        name="campusId"
        required
        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
      >
        {campuses.map((campus) => (
          <option key={campus.id} value={campus.id}>
            {campus.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmailInput() {
  return (
    <label className="flex flex-col gap-2 text-sm">
      用户邮箱
      <input
        type="email"
        name="email"
        required
        placeholder="user@campus.edu"
        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
      />
    </label>
  );
}

/**
 * 授予表单（两步：先查找候选展示 displayName，再确认授予）。
 * campus/email 字段为唯一客户端输入；roleKey/actorId/targetUserId 均为
 * 服务器所有——disabled/hidden 永远不是授权，伪造提交由 server action
 * 独立拒绝（§22）。
 */
export function CampusRoleGrantForm({
  campuses,
  grantAction,
  lookupAction,
}: {
  campuses: { id: string; name: string }[];
  grantAction: (formData: FormData) => Promise<GovernanceRoleActionState>;
  lookupAction: (formData: FormData) => Promise<GovernanceRoleActionState>;
}) {
  const [lookupState, lookupFormAction] = useActionState(
    async (_prev: GovernanceRoleActionState, formData: FormData) => lookupAction(formData),
    initialState,
  );
  const [grantState, grantFormAction] = useActionState(
    async (_prev: GovernanceRoleActionState, formData: FormData) => grantAction(formData),
    initialState,
  );

  if (campuses.length === 0) {
    return (
      <p className="rounded-[28px] border border-slate-200 bg-white p-6 text-sm text-slate-500">
        当前没有可授予新角色的校区。
      </p>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form action={lookupFormAction} className="space-y-3 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">第一步：查找候选用户</h3>
        <CampusSelect campuses={campuses} />
        <EmailInput />
        <SubmitButton label="查找用户" pendingLabel="查找中..." variant="secondary" />
        {lookupState.error ? (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {lookupState.error}
          </p>
        ) : null}
        {lookupState.success && lookupState.displayName ? (
          <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            找到用户：{lookupState.displayName}
          </p>
        ) : null}
      </form>
      <form action={grantFormAction} className="space-y-3 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">第二步：确认授予</h3>
        <CampusSelect campuses={campuses} />
        <EmailInput />
        <p className="text-xs text-slate-500">{GOVERNANCE_ROLE_GRANT_HINT}</p>
        <SubmitButton label="确认授予" pendingLabel="提交中..." variant="primary" />
        <StateFeedback state={grantState} />
      </form>
    </div>
  );
}

/** 撤回按钮（唯一客户端输入 = assignmentId；per-row 反馈）。 */
export function RevokeRoleButton({
  action,
  assignmentId,
}: {
  action: (formData: FormData) => Promise<GovernanceRoleActionState>;
  assignmentId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceRoleActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <SubmitButton label="撤回" pendingLabel="撤回中..." variant="secondary" />
      {state.error ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.success && state.message ? (
        <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

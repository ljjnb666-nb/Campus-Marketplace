"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { GovernanceUserActionState } from "@/actions/governance-users";

const initialState: GovernanceUserActionState = { success: false };

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

function Feedback({ state }: { state: GovernanceUserActionState }) {
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
        操作已提交。
      </p>
    );
  }
  return null;
}

/** 停用账号（canonical authority = suspendAccount；privileged/self 由域 fail closed）。 */
export function SuspendUserForm({
  action,
  userId,
}: {
  action: (formData: FormData) => Promise<GovernanceUserActionState>;
  userId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceUserActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="停用账号">
      <input type="hidden" name="userId" value={userId} />
      <SubmitButton label="停用账号" pendingLabel="提交中..." variant="primary" />
      <Feedback state={state} />
    </form>
  );
}

/** 恢复账号（canonical authority = reinstateAccount）。 */
export function ReinstateUserForm({
  action,
  userId,
}: {
  action: (formData: FormData) => Promise<GovernanceUserActionState>;
  userId: string;
}) {
  const [state, formAction] = useActionState(
    async (_prev: GovernanceUserActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3" aria-label="恢复账号">
      <input type="hidden" name="userId" value={userId} />
      <SubmitButton label="恢复账号" pendingLabel="提交中..." variant="secondary" />
      <Feedback state={state} />
    </form>
  );
}

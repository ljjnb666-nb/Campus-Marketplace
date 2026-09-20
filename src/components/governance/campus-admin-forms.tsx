"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { GovernanceCampusActionState } from "@/actions/governance-campus";

const initialState: GovernanceCampusActionState = { success: false };

function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  name,
  value,
}: {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={
        variant === "primary"
          ? "rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          : variant === "danger"
            ? "rounded-full border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 transition hover:border-red-300 disabled:cursor-not-allowed disabled:text-slate-400"
            : "rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:text-slate-400"
      }
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Feedback({ state }: { state: GovernanceCampusActionState }) {
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

const inputClassName =
  "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-400";

/** 创建校区表单（§26：slug 仅此处可填，create 后不可变）。 */
export function CreateCampusForm({
  action,
}: {
  action: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
}) {
  const [state, formAction] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          校区名称
          <input name="name" required maxLength={64} className={inputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          校区标识符（slug，创建后不可修改）
          <input
            name="slug"
            required
            maxLength={64}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            className={inputClassName}
            placeholder="例如 qinghua-main-campus"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          学校名称
          <input name="schoolName" required maxLength={80} className={inputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          所在区域（可选）
          <input name="district" maxLength={80} className={inputClassName} />
        </label>
      </div>
      <SubmitButton label="创建校区" pendingLabel="提交中..." />
      <Feedback state={state} />
    </form>
  );
}

/** 校区元数据编辑表单（§27：name/schoolName/district；结构性无 slug 字段）。 */
export function UpdateCampusMetadataForm({
  action,
  campusId,
  name,
  schoolName,
  district,
}: {
  action: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
  campusId: string;
  name: string;
  schoolName: string;
  district: string | null;
}) {
  const [state, formAction] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="campusId" value={campusId} />
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          校区名称
          <input name="name" defaultValue={name} maxLength={64} className={inputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          学校名称
          <input name="schoolName" defaultValue={schoolName} maxLength={80} className={inputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          所在区域
          <input name="district" defaultValue={district ?? ""} maxLength={80} className={inputClassName} />
        </label>
      </div>
      <SubmitButton label="保存修改" pendingLabel="提交中..." variant="secondary" />
      <Feedback state={state} />
    </form>
  );
}

/** 启用/停用切换表单（§28：same-state 幂等；deactivate 不级联任何义务）。 */
export function CampusToggleForm({
  action,
  campusId,
  nextIsActive,
}: {
  action: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
  campusId: string;
  nextIsActive: boolean;
}) {
  const [state, formAction] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="campusId" value={campusId} />
      {nextIsActive ? (
        <SubmitButton label="启用校区" pendingLabel="提交中..." />
      ) : (
        <SubmitButton label="停用校区" pendingLabel="提交中..." variant="danger" />
      )}
      <Feedback state={state} />
    </form>
  );
}

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 创建认证策略草稿表单（§33：version 服务器锁内分配，客户端不指定）。 */
export function CreatePolicyDraftForm({
  action,
  campusId,
}: {
  action: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
  campusId: string;
}) {
  const [state, formAction] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="campusId" value={campusId} />
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        策略标题
        <input name="title" required maxLength={120} className={inputClassName} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        认证说明（发布后不可修改）
        <textarea name="instructions" required rows={6} maxLength={5000} className={inputClassName} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        生效时间（可选，默认立即）
        <input type="datetime-local" name="effectiveAt" className={inputClassName} />
      </label>
      <SubmitButton label="创建草稿" pendingLabel="提交中..." />
      <Feedback state={state} />
    </form>
  );
}

/** 草稿编辑 + 发布/退役操作（§34：仅 DRAFT 可编辑；PUBLISHED/RETIRED 结构性不渲染本表单）。 */
export function DraftPolicyForm({
  updateAction,
  publishAction,
  retireAction,
  campusId,
  policy,
}: {
  updateAction: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
  publishAction: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
  retireAction: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
  campusId: string;
  policy: {
    id: string;
    version: number;
    title: string;
    draftInstructions?: string;
    effectiveAt: string;
  };
}) {
  const [updateState, updateFormAction] = useActionState(updateAction, initialState);
  const [publishState, publishFormAction] = useActionState(publishAction, initialState);
  const [retireState, retireFormAction] = useActionState(retireAction, initialState);

  return (
    <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
      <form action={updateFormAction} className="space-y-3">
        <input type="hidden" name="campusId" value={campusId} />
        <input type="hidden" name="policyId" value={policy.id} />
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          策略标题
          <input name="title" defaultValue={policy.title} maxLength={120} className={inputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          认证说明（保存将重算内容指纹）
          <textarea
            name="instructions"
            rows={5}
            maxLength={5000}
            defaultValue={policy.draftInstructions ?? ""}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          生效时间
          <input
            type="datetime-local"
            name="effectiveAt"
            defaultValue={toDatetimeLocalValue(policy.effectiveAt)}
            className={inputClassName}
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <SubmitButton label="保存草稿" pendingLabel="提交中..." variant="secondary" />
        </div>
        <Feedback state={updateState} />
      </form>
      <div className="flex flex-wrap gap-3">
        <form action={publishFormAction}>
          <input type="hidden" name="campusId" value={campusId} />
          <input type="hidden" name="policyId" value={policy.id} />
          <SubmitButton label="发布" pendingLabel="提交中..." />
        </form>
        <form action={retireFormAction}>
          <input type="hidden" name="campusId" value={campusId} />
          <input type="hidden" name="policyId" value={policy.id} />
          <SubmitButton label="退役" pendingLabel="提交中..." variant="danger" />
        </form>
      </div>
      <Feedback state={publishState} />
      <Feedback state={retireState} />
    </div>
  );
}

/** 已发布/已退役策略的退役操作（已发布内容不可修改——发布即不可变）。 */
export function PublishedPolicyActions({
  retireAction,
  campusId,
  policyId,
}: {
  retireAction: (
    prevState: GovernanceCampusActionState,
    formData: FormData,
  ) => Promise<GovernanceCampusActionState>;
  campusId: string;
  policyId: string;
}) {
  const [retireState, retireFormAction] = useActionState(retireAction, initialState);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
      <form action={retireFormAction}>
        <input type="hidden" name="campusId" value={campusId} />
        <input type="hidden" name="policyId" value={policyId} />
        <SubmitButton label="退役" pendingLabel="提交中..." variant="danger" />
      </form>
      <span className="text-xs text-slate-400">已发布策略内容不可修改（发布即不可变）</span>
      <Feedback state={retireState} />
    </div>
  );
}

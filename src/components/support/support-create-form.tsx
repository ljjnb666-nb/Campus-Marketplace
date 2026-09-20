"use client";

import { useActionState } from "react";

import type { SupportCreateActionState } from "@/actions/support";
import { SUPPORT_TICKET_CATEGORY_LABELS } from "@/constants/support";

const initialState: SupportCreateActionState = { success: false };

/**
 * Phase 7G：用户面创建支持工单表单（最小面；不做 Phase 11 UX polish）。
 * category/subject/description + 可选校区 scope；附件结构性不存在
 * （SUPPORT_ATTACHMENTS = OUT_OF_SCOPE 冻结）。
 */
export function SupportTicketCreateForm({
  action,
  campuses,
}: {
  action: (formData: FormData) => Promise<SupportCreateActionState>;
  campuses: Array<{ id: string; name: string }>;
}) {
  const [state, formAction] = useActionState(
    async (_prev: SupportCreateActionState, formData: FormData) => action(formData),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4" aria-label="提交支持工单">
      <label className="flex flex-col gap-2 text-sm">
        问题类型
        <select
          name="category"
          required
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
        >
          {Object.entries(SUPPORT_TICKET_CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {campuses.length > 0 ? (
        <label className="flex flex-col gap-2 text-sm">
          关联校区（可选）
          <select
            name="campusId"
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          >
            <option value="">不关联校区</option>
            {campuses.map((campus) => (
              <option key={campus.id} value={campus.id}>
                {campus.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex flex-col gap-2 text-sm">
        主题
        <input
          type="text"
          name="subject"
          required
          minLength={2}
          maxLength={100}
          placeholder="一句话描述你的问题"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
        />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        问题描述
        <textarea
          name="description"
          required
          minLength={10}
          maxLength={2000}
          rows={6}
          placeholder="请描述问题的具体情况（10-2000 字）"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
        />
      </label>
      <button
        type="submit"
        className="rounded-full bg-slate-950 px-6 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        提交工单
      </button>
      {state.error ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.success && state.ticketId ? (
        <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          工单已提交，
          <a href={`/support/${state.ticketId}`} className="underline">
            查看工单详情
          </a>
          。
        </p>
      ) : null}
    </form>
  );
}

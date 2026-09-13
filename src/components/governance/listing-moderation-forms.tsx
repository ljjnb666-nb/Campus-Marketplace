"use client";

import { useActionState } from "react";

import type { ListingModerationActionState } from "@/actions/governance-listings";
import { LISTING_MODERATION_REASON_LABELS } from "@/constants/governance-listings";

const INITIAL_STATE: ListingModerationActionState = { success: false };

const REASON_OPTIONS = Object.entries(LISTING_MODERATION_REASON_LABELS);

/**
 * 治理下架表单（queue row / governance detail 双入口共用）。
 * 客户端只提交 { listingId, reasonCode, note? }——type 由服务器 typed action
 * 绑定；身份/campus/owner 全部服务器解析。
 */
export function ListingTakedownForm({
  action,
  listingId,
}: {
  action: (formData: FormData) => Promise<ListingModerationActionState>;
  listingId: string;
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ListingModerationActionState, formData: FormData) => action(formData),
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="listingId" value={listingId} />
      <label className="block text-xs font-medium text-slate-500" htmlFor={`reason-${listingId}`}>
        处置原因
      </label>
      <select
        id={`reason-${listingId}`}
        name="reasonCode"
        required
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
      >
        {REASON_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <textarea
        name="note"
        maxLength={500}
        rows={2}
        placeholder="内部备注（≤500 字，仅治理侧可见）"
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
      >
        {pending ? "处理中…" : "强制下架（治理隐藏）"}
      </button>
      {state.message ? (
        <p className={`text-xs ${state.success ? "text-emerald-700" : "text-rose-700"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 恢复表单：只提交 { moderationId, expectedListingUpdatedAt }（R2-03 精确
 * 身份 + 新鲜内容 token）。收到 STALE 反馈时提示刷新（UI 绝不自动重试，
 * R2-06）。
 */
export function ListingRestoreForm({
  action,
  moderationId,
  listingUpdatedAt,
}: {
  action: (formData: FormData) => Promise<ListingModerationActionState>;
  moderationId: string;
  listingUpdatedAt: string;
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ListingModerationActionState, formData: FormData) => action(formData),
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="moderationId" value={moderationId} />
      <input type="hidden" name="expectedListingUpdatedAt" value={listingUpdatedAt} />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
      >
        {pending ? "处理中…" : "恢复公开展示"}
      </button>
      {state.message ? (
        <p className={`text-xs ${state.success ? "text-emerald-700" : "text-rose-700"}`}>
          {state.stale ? `${state.message}（请刷新本页后重检内容）` : state.message}
        </p>
      ) : null}
    </form>
  );
}

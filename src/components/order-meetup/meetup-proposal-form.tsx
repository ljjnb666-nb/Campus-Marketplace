"use client";

import React, { useActionState, useState } from "react";
import { MapPin, Loader2 } from "lucide-react";

import { proposeOrderMeetupAction, type OrderMeetupActionState } from "@/actions/order-meetup";
import {
  MEETUP_LOCATION_MAX_LENGTH,
  MEETUP_LOCATION_MIN_LENGTH,
} from "@/lib/meetups/meetup-policy";
import type { MeetupPointOption } from "@/lib/meetups/order-meetup-query";

const initialState: OrderMeetupActionState = { success: false, message: "" };

/** datetime-local 的本地时间格式（YYYY-MM-DDTHH:mm；浏览器本地时区） */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

interface MeetupProposalFormProps {
  orderId: string;
  /** authoritative campus 的 active MeetupPoint 候选（server 投影） */
  meetupPointOptions: MeetupPointOption[];
  /** server render 时刻的时间快照（UX min / 默认值；非 authority） */
  minAt: Date;
  defaultAt: Date;
}

/**
 * Phase 8D-02：发起见面约定表单（buyer / seller 均可，Order ACCEPTED 且
 * 无 active meetup 时由页面渲染）。
 *
 * UX 约束（min / required / 长度提示）只是客户端体验；服务器 authority
 * 恒为 canonical proposeOrderMeetupTx 锁内 fresh revalidate——时间窗、
 * point 存在性 / active / campus 匹配、custom 长度（复用 meetup-policy
 * 常量，无第二套 2..80）、active meetup 唯一性全部由领域裁决。
 */
export function MeetupProposalForm({
  orderId,
  meetupPointOptions,
  minAt,
  defaultAt,
}: MeetupProposalFormProps) {
  const [state, formAction, isPending] = useActionState(proposeOrderMeetupAction, initialState);
  const [source, setSource] = useState<"MEETUP_POINT" | "CUSTOM">(
    meetupPointOptions.length > 0 ? "MEETUP_POINT" : "CUSTOM",
  );

  return (
    <form action={formAction} className="space-y-4" aria-label="发起见面约定">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="locationSource" value={source} />

      <div className="space-y-1.5">
        <label htmlFor="meetup-scheduled-at" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
          约定时间 <span className="text-rose-500">*</span>
        </label>
        <input
          id="meetup-scheduled-at"
          name="scheduledAt"
          type="datetime-local"
          required
          min={toLocalInputValue(minAt)}
          defaultValue={toLocalInputValue(defaultAt)}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
        />
        <p className="text-[11px] text-slate-400">请选择一个未来的时间</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          见面地点来源 <span className="text-rose-500">*</span>
        </legend>

        {meetupPointOptions.length > 0 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800">
            <input
              type="radio"
              value="MEETUP_POINT"
              checked={source === "MEETUP_POINT"}
              onChange={() => setSource("MEETUP_POINT")}
              className="mt-0.5 size-3.5 accent-indigo-600"
            />
            <span className="font-semibold text-slate-700 dark:text-slate-300">校内推荐见面点</span>
          </label>
        )}

        {source === "MEETUP_POINT" && (
          <div className="space-y-1 pl-1">
            <label htmlFor="meetup-point-select" className="sr-only">
              选择校内推荐见面点
            </label>
            <select
              id="meetup-point-select"
              name="meetupPointId"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            >
              {meetupPointOptions.map((point) => (
                <option key={point.id} value={point.id}>
                  {point.name}（{point.locationText}）
                </option>
              ))}
            </select>
          </div>
        )}

        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800">
          <input
            type="radio"
            value="CUSTOM"
            checked={source === "CUSTOM"}
            onChange={() => setSource("CUSTOM")}
            className="mt-0.5 size-3.5 accent-indigo-600"
          />
          <span className="font-semibold text-slate-700 dark:text-slate-300">自定义地点</span>
        </label>

        {source === "CUSTOM" && (
          <div className="space-y-1 pl-1">
            <label htmlFor="meetup-location-text" className="sr-only">
              自定义见面地点
            </label>
            <input
              id="meetup-location-text"
              name="locationText"
              type="text"
              minLength={MEETUP_LOCATION_MIN_LENGTH}
              maxLength={MEETUP_LOCATION_MAX_LENGTH}
              placeholder="例如：东门快递柜旁"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
            <p className="text-[11px] text-slate-400">
              {MEETUP_LOCATION_MIN_LENGTH}-{MEETUP_LOCATION_MAX_LENGTH} 个字
            </p>
          </div>
        )}
      </fieldset>

      {state.message && !state.success && (
        <p className="text-xs font-medium text-rose-600" role="alert">
          {state.message}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50 sm:w-auto"
      >
        {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <MapPin className="size-3.5" />}
        <span>发起见面约定</span>
      </button>
    </form>
  );
}

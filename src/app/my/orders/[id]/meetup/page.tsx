import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  MapPin,
  ShieldAlert,
  History,
  CircleCheck,
} from "lucide-react";

import {
  ArrivalMeetupForm,
  CancelMeetupForm,
  ConfirmMeetupForm,
} from "@/components/order-meetup/meetup-actions";
import { MeetupProposalForm } from "@/components/order-meetup/meetup-proposal-form";
import { NoShowSection } from "@/components/order-meetup/no-show-dialog";
import {
  orderMeetupLocationSourceLabel,
  orderMeetupStatusLabel,
} from "@/lib/meetups/order-meetup-labels";
import { getOrderMeetupView } from "@/lib/meetups/order-meetup-query";
import {
  ACTIVE_MEETUP_STATUSES,
  isMeetupArrivalWindowOpen,
  isMeetupCancelWindowOpen,
  isMeetupNoShowWindowOpen,
  MEETUP_NO_SHOW_GRACE_MS,
} from "@/lib/meetups/meetup-policy";
import { requireUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

/**
 * Phase 8D-02：见面约定用户操作页（/my/orders/[id]/meetup，PRODUCT /
 * SERVICE 专属）。
 *
 * 冻结边界：
 * - 参与方授权 / type authority / 历史 location snapshot 全部由
 *   getOrderMeetupView read projection 决定（非参与方统一 notFound）；
 * - 本页所有"按钮是否展示"只是 server render 时刻的 convenience
 *   projection（复用 meetup-policy 窗口谓词，零规则复制）；stale UI
 *   提交由 canonical Tx service 锁内 FAIL CLOSED；
 * - Meetup COMPLETED ≠ Order COMPLETED（页面明确标注，不触发任何
 *   订单完成语义）；NO_SHOW_REPORTED = allegation，不是判责。
 */
export default async function OrderMeetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const view = await getOrderMeetupView(id, user.id).catch(() => null);

  if (!view) {
    notFound();
  }

  // server render 时刻快照（convenience projection；非 authority）
  const now = new Date();
  const current =
    view.meetups.find((m) => (ACTIVE_MEETUP_STATUSES as readonly string[]).includes(m.status)) ??
    null;
  const latest = view.meetups[0] ?? null;

  const isBuyer = view.viewerRole === "buyer";
  const selfArrived = current
    ? isBuyer
      ? current.buyerArrivedAt !== null
      : current.sellerArrivedAt !== null
    : false;
  const counterpartArrived = current
    ? isBuyer
      ? current.sellerArrivedAt !== null
      : current.buyerArrivedAt !== null
    : false;
  const isProposer = current ? current.proposedById === user.id : false;

  const orderAccepted = view.order.status === "ACCEPTED";
  const orderInDispute = view.order.status === "IN_DISPUTE";
  const canPropose = orderAccepted && !current;

  const arrivalWindowOpen =
    current?.status === "CONFIRMED" && isMeetupArrivalWindowOpen(current.scheduledAt, now);
  const cancelWindowOpen =
    (current?.status === "PROPOSED" || current?.status === "CONFIRMED") &&
    current &&
    isMeetupCancelWindowOpen(current.scheduledAt, now);
  const noShowWindowOpen =
    current?.status === "CONFIRMED" &&
    selfArrived &&
    !counterpartArrived &&
    isMeetupNoShowWindowOpen(current.scheduledAt, now);
  const waitingCounterpartInGrace =
    current?.status === "CONFIRMED" &&
    selfArrived &&
    !counterpartArrived &&
    !isMeetupNoShowWindowOpen(current.scheduledAt, now);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <Link
        href="/my/orders"
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft className="size-3.5" />
        <span>返回订单中心</span>
      </Link>

      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold text-slate-950 dark:text-slate-50">见面约定</h1>
        <p className="text-xs text-slate-500">
          与 {view.order.counterpartyName} 的正式见面时间与地点（{view.order.title} · #
          {view.order.orderNo.slice(-8)}）
        </p>
      </div>

      {/* 订单摘要 */}
      <section className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-0.5 text-[11px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {view.order.type === "PRODUCT" ? "二手商品" : "技能服务"}
          </span>
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            ¥{view.order.amount}
          </span>
        </div>
        <p className="mt-2 text-sm font-bold text-slate-900 dark:text-slate-100">{view.order.title}</p>
        <p className="mt-1 text-xs text-slate-500">交易对方：{view.order.counterpartyName}</p>
        {view.order.initialMeetingLocation && (
          <p className="mt-1 text-xs text-slate-400">
            下单时初始偏好地点：{view.order.initialMeetingLocation}
            （仅供参考，正式约定以本页为准）
          </p>
        )}
      </section>

      {orderInDispute && (
        <div className="mb-6 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs font-semibold text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>订单已进入纠纷处理，平台将按纠纷流程跟进。</span>
        </div>
      )}

      {/* 当前见面约定（§13 状态机） */}
      {current && (
        <section className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">当前约定</h2>
            <span className="rounded-full bg-indigo-50 px-3 py-0.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
              {orderMeetupStatusLabel(current.status)}
            </span>
          </div>

          <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
            <p className="flex items-center gap-1.5">
              <CalendarClock className="size-3.5 text-indigo-500" />
              <span>约定时间：{formatDateTime(current.scheduledAt)}</span>
            </p>
            <p className="flex items-center gap-1.5">
              <MapPin className="size-3.5 text-indigo-500" />
              <span>
                约定地点：{current.locationTextSnapshot}（
                {orderMeetupLocationSourceLabel(current.locationSource)}）
              </span>
            </p>
            <p className="text-slate-400">
              发起人：{isProposer ? "你" : "对方"}
              {current.status !== "PROPOSED" ? " · 对方已确认" : ""}
            </p>
          </div>

          {/* A/B：PROPOSED */}
          {current.status === "PROPOSED" && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                {isProposer ? "等待对方确认这次见面约定。" : "对方发起了见面约定，请确认是否按约定时间地点见面。"}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {!isProposer && (
                  <ConfirmMeetupForm orderId={view.order.id} meetupId={current.id} />
                )}
                {cancelWindowOpen && (
                  <CancelMeetupForm orderId={view.order.id} meetupId={current.id} />
                )}
              </div>
            </div>
          )}

          {/* C/D：CONFIRMED（时间未到 → 可取消；时间已到 → self check-in） */}
          {current.status === "CONFIRMED" && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              {!arrivalWindowOpen && (
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  双方已确认这次见面约定。约定时间到达前可以取消；到达约定时间后可在此登记到场。
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {cancelWindowOpen && (
                  <CancelMeetupForm orderId={view.order.id} meetupId={current.id} />
                )}
                {arrivalWindowOpen && !selfArrived && (
                  <ArrivalMeetupForm orderId={view.order.id} meetupId={current.id} />
                )}
              </div>
              {arrivalWindowOpen && selfArrived && (
                <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                  <CircleCheck className="size-3.5" />
                  <span>你已登记到场</span>
                </p>
              )}
            </div>
          )}

          {/* E/F：自己已到，对方未到 */}
          {current.status === "CONFIRMED" && selfArrived && !counterpartArrived && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                你已到达，等待对方到场。
              </p>
              {waitingCounterpartInGrace && (
                <p className="text-xs text-slate-400">
                  约定时间后 15 分钟才可报告未到场（约{" "}
                  {formatDateTime(new Date(current.scheduledAt.getTime() + MEETUP_NO_SHOW_GRACE_MS))}{" "}
                  开放）。
                </p>
              )}
              {noShowWindowOpen && (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500">
                    已超过约定时间 15 分钟且对方仍未登记到场，你可以提交未到场报告。
                  </p>
                  <NoShowSection orderId={view.order.id} meetupId={current.id} />
                </div>
              )}
            </div>
          )}

          {/* G：双方已到（COMPLETED ≠ Order COMPLETED） */}
          {current.status === "COMPLETED" && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                <CircleCheck className="size-3.5" />
                <span>双方均已登记到场，见面约定完成。</span>
              </p>
              <p className="text-xs text-slate-400">
                见面约定完成不等于订单完成；订单完成请回到订单中心按原有流程操作。
              </p>
            </div>
          )}

          {/* I：NO_SHOW_REPORTED（allegation，不是判责） */}
          {current.status === "NO_SHOW_REPORTED" && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <p className="flex items-start gap-1.5 text-xs font-semibold text-rose-600">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {current.noShowReportedById === user.id
                    ? "你已报告对方未到场，订单已进入纠纷处理。"
                    : "对方报告你未到场，订单已进入纠纷处理。"}
                </span>
              </p>
              <p className="text-xs text-slate-400">
                该报告是一方提交的事实主张，平台将按纠纷处理流程跟进认定，不代表已作出责任判定。
              </p>
            </div>
          )}
        </section>
      )}

      {/* H：无 active meetup —— 最近一次为 CANCELLED 的说明 + 重新发起 */}
      {!current && latest && latest.status === "CANCELLED" && (
        <section className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">最近一次约定</h2>
            <span className="rounded-full bg-slate-100 px-3 py-0.5 text-[11px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {orderMeetupStatusLabel(latest.status)}
            </span>
          </div>
          <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
            <p>该次见面约定已取消，历史记录保留如下。</p>
            <p>原约定时间：{formatDateTime(latest.scheduledAt)}</p>
            <p>
              原约定地点：{latest.locationTextSnapshot}（
              {orderMeetupLocationSourceLabel(latest.locationSource)}）
            </p>
          </div>
        </section>
      )}

      {/* A/H：无 active meetup + Order ACCEPTED → 双方均可发起 */}
      {canPropose && (
        <section className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-1 text-sm font-bold text-slate-900 dark:text-slate-100">发起见面约定</h2>
          <p className="mb-4 text-xs text-slate-500">
            与对方约定见面时间与地点；对方确认后约定生效。
          </p>
          <MeetupProposalForm
            orderId={view.order.id}
            meetupPointOptions={view.meetupPointOptions}
            minAt={now}
            defaultAt={new Date(now.getTime() + 60 * 60 * 1000)}
          />
        </section>
      )}

      {/* 订单因 no-show 进入纠纷后（非 ACCEPTED）且无 active meetup 的提示 */}
      {!current && !canPropose && !(latest && latest.status === "CANCELLED") && (
        <section className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-5 text-xs text-slate-500 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <p>当前订单状态不支持发起新的见面约定，历史约定记录保留如下。</p>
        </section>
      )}

      {/* 历史（§14：OrderMeetup 行内 snapshot 权威，倒序，≤10 条） */}
      {view.meetups.length > 0 && (
        <section className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-slate-100">
            <History className="size-4 text-slate-400" />
            <span>历史记录</span>
          </h2>
          <ul className="space-y-3">
            {view.meetups.map((meetup) => (
              <li
                key={meetup.id}
                className="rounded-2xl border border-slate-100 p-3 text-xs dark:border-slate-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-700 dark:text-slate-300">
                    {orderMeetupStatusLabel(meetup.status)}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {formatDateTime(meetup.scheduledAt)}
                  </span>
                </div>
                <p className="mt-1 text-slate-500">
                  {meetup.locationTextSnapshot}（
                  {orderMeetupLocationSourceLabel(meetup.locationSource)}）
                </p>
              </li>
            ))}
          </ul>
          {view.meetups.length >= 10 && (
            <p className="mt-3 text-[11px] text-slate-400">仅显示最近 10 条约定记录。</p>
          )}
        </section>
      )}
    </div>
  );
}

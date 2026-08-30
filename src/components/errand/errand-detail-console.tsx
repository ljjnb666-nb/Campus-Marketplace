"use client";

import React, { useState } from "react";
import Link from "next/link";
import { MessageSquare, Flag, Edit3, Trash2, MapPin, Navigation, Clock, CreditCard, ShieldCheck } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { StatusBadge, StatusBadgeVariant } from "@/components/ui/status-badge";
import { UserSummaryCard } from "@/components/ui/user-summary-card";
import { ErrandClaimDialog } from "@/components/errand/errand-claim-dialog";
import { ReportDialog } from "@/components/ui/report-dialog";
import { MobileActionBar } from "@/components/ui/mobile-action-bar";
import { ErrandStatusActions } from "@/components/errand/errand-status-actions";
import { ERRAND_STATUS_LABELS } from "@/constants/errand";
import { createOrOpenErrandConversation } from "@/actions/conversation";
import { claimErrand, deleteErrand, updateErrandStatus } from "@/actions/errand";
import { createReport } from "@/actions/trust";
import type { ErrandTaskStatus } from "@prisma/client";

interface ErrandUserSummary {
  id: string;
  name: string;
  avatarUrl?: string | null;
  schoolName: string;
  completedOrdersCount: number;
  positiveReviewRate?: number | null;
  verificationStatus?: string;
  createdAt: Date | string;
}

interface ErrandDetailConsoleProps {
  errand: {
    id: string;
    title: string;
    description: string;
    reward: number | string;
    status: ErrandTaskStatus;
    pickupLocation: string;
    deliveryLocation: string;
    deadline: Date | string;
    needsAdvancePay: boolean;
    advanceAmount?: number | string | null;
    contactNote?: string | null;
    publisherId: string;
    publisher: ErrandUserSummary;
    accepterId?: string | null;
    accepter?: ErrandUserSummary | null;
    category: { name: string };
    campus: { schoolName: string; name: string };
  };
  isPublisher: boolean;
  isAccepter: boolean;
  isLoggedIn: boolean;
  availableActions: { status: ErrandTaskStatus; label: string }[];
}

export function ErrandDetailConsole({
  errand,
  isPublisher,
  isLoggedIn,
  availableActions,
}: ErrandDetailConsoleProps) {
  const [claimOpen, setClaimOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const isOpen = errand.status === "OPEN";

  function formatDate(value: Date | string) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  const badgeVariant: StatusBadgeVariant = isOpen
    ? "warning"
    : errand.status === "COMPLETED"
    ? "success"
    : errand.status === "CANCELLED"
    ? "neutral"
    : "primary";

  return (
    <>
      <div className="lg:sticky lg:top-24 space-y-6">
        <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-6">
          {/* 1. 顶部分类与状态 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-slate-800">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {errand.category.name}
              </span>
              <StatusBadge
                label={(ERRAND_STATUS_LABELS as Record<string, string>)[errand.status] || errand.status}
                variant={badgeVariant}
                dot
              />
            </div>
            <span className="text-xs text-slate-400">
              {errand.campus.schoolName} · {errand.campus.name}
            </span>
          </div>

          {/* 2. 标题与悬赏报酬 */}
          <div className="space-y-2">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-snug dark:text-slate-100">
              {errand.title}
            </h1>
            <div className="flex items-baseline justify-between pt-1">
              <span className="text-xs text-slate-400 font-medium">跑腿赏金</span>
              <PriceDisplay price={errand.reward} size="lg" />
            </div>
          </div>

          {/* 3. 起终点路线图示 */}
          <div className="rounded-2xl bg-slate-50/80 p-4 border border-slate-100 space-y-3 dark:bg-slate-950/40 dark:border-slate-800">
            <div className="flex items-start gap-3">
              <div className="flex flex-col items-center mt-1">
                <MapPin className="size-4 text-indigo-600 shrink-0" />
                <div className="h-6 w-0.5 border-l-2 border-dashed border-slate-300 my-1 dark:border-slate-700" />
                <Navigation className="size-4 text-emerald-600 shrink-0" />
              </div>
              <div className="space-y-3 flex-1 min-w-0">
                <div>
                  <p className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">起点（取件位置）</p>
                  <p className="text-xs font-bold text-slate-900 truncate dark:text-slate-100">{errand.pickupLocation}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider">终点（送达位置）</p>
                  <p className="text-xs font-bold text-slate-900 truncate dark:text-slate-100">{errand.deliveryLocation}</p>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-200/60 pt-2.5 flex items-center justify-between text-xs dark:border-slate-800">
              <span className="text-slate-500 flex items-center gap-1">
                <Clock className="size-3.5 text-slate-400" />
                最迟送达时间
              </span>
              <span className="font-semibold text-rose-600 dark:text-rose-400">{formatDate(errand.deadline)}</span>
            </div>

            {errand.needsAdvancePay && (
              <div className="flex items-center gap-1.5 text-xs text-amber-800 bg-amber-50 p-2 rounded-xl border border-amber-200/50 dark:bg-amber-950/40 dark:text-amber-300">
                <CreditCard className="size-3.5 text-amber-600 shrink-0" />
                <span>需接单人垫付费用（¥{errand.advanceAmount ? Number(errand.advanceAmount).toFixed(2) : "实际计算"}）</span>
              </div>
            )}
          </div>

          {/* 4. 发布者/接单者卡片 */}
          <div>
            <p className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              {errand.accepter ? "任务参与者" : "发布者信息"}
            </p>
            <UserSummaryCard user={errand.publisher} />
            {errand.accepter && (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-semibold text-slate-400">接单同学</p>
                <UserSummaryCard user={errand.accepter} compact />
              </div>
            )}
          </div>

          {/* 5. 核心操作控制阵列 */}
          {isPublisher ? (
            /* 发布者本人控制区 */
            <div className="space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-3">
                {isOpen && (
                  <Link
                    href={`/errands/${errand.id}/edit`}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-xs font-bold text-white shadow-sm transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                  >
                    <Edit3 className="size-4" />
                    <span>编辑任务</span>
                  </Link>
                )}
                {(isOpen || errand.status === "CANCELLED") && (
                  <form action={deleteErrand}>
                    <input type="hidden" name="errandId" value={errand.id} />
                    <button
                      type="submit"
                      className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700 transition hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                    >
                      <Trash2 className="size-4" />
                      <span>删除任务</span>
                    </button>
                  </form>
                )}
              </div>

              {availableActions.length > 0 && (
                <ErrandStatusActions errandId={errand.id} actions={availableActions} />
              )}
            </div>
          ) : (
            /* 其它普通用户/接单者控制区 */
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2.5">
                {/* 私聊联系 */}
                {isLoggedIn && (
                  <form action={createOrOpenErrandConversation} className="flex-1">
                    <input type="hidden" name="errandId" value={errand.id} />
                    <button
                      type="submit"
                      className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-slate-200/90 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-xs transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <MessageSquare className="size-4 text-indigo-600 dark:text-indigo-400" />
                      <span>私聊发布者</span>
                    </button>
                  </form>
                )}

                {/* 举报按键 */}
                {isLoggedIn && (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="rounded-full p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                    title="举报此任务"
                  >
                    <Flag className="size-4" />
                  </button>
                )}
              </div>

              {/* 核心抢单/操作按键 */}
              {isOpen ? (
                isLoggedIn ? (
                  <button
                    type="button"
                    onClick={() => setClaimOpen(true)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-700 py-3.5 text-sm font-bold text-white shadow-lg shadow-emerald-500/25 transition hover:from-emerald-700 hover:to-emerald-800 active:scale-[0.99]"
                  >
                    <ShieldCheck className="size-4" />
                    <span>立即接单</span>
                  </button>
                ) : (
                  <Link
                    href="/login"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3.5 text-sm font-bold text-white shadow-md transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                  >
                    <span>登录后接单</span>
                  </Link>
                )
              ) : availableActions.length > 0 ? (
                <ErrandStatusActions errandId={errand.id} actions={availableActions} />
              ) : (
                <div className="rounded-2xl bg-slate-100 p-3.5 text-center text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  当前任务为“{(ERRAND_STATUS_LABELS as Record<string, string>)[errand.status] || errand.status}”状态，不可抢单
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 移动端固定底栏 */}
      {!isPublisher && isOpen && (
        <MobileActionBar>
          {isLoggedIn && (
            <form action={createOrOpenErrandConversation}>
              <input type="hidden" name="errandId" value={errand.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-700"
              >
                <MessageSquare className="size-3.5 text-indigo-600" />
                <span>私聊</span>
              </button>
            </form>
          )}

          <button
            type="button"
            onClick={() => (isLoggedIn ? setClaimOpen(true) : (window.location.href = "/login"))}
            className="flex-1 max-w-[220px] inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-600 to-emerald-700 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-600/20 active:scale-95"
          >
            <ShieldCheck className="size-3.5" />
            <span>立即接单</span>
          </button>
        </MobileActionBar>
      )}

      {/* 弹窗抽屉 */}
      <ErrandClaimDialog
        open={claimOpen}
        onOpenChange={setClaimOpen}
        action={claimErrand}
        errand={{
          id: errand.id,
          title: errand.title,
          reward: errand.reward,
          pickupLocation: errand.pickupLocation,
          deliveryLocation: errand.deliveryLocation,
          deadline: errand.deadline,
          needsAdvancePay: errand.needsAdvancePay,
          advanceAmount: errand.advanceAmount,
        }}
      />

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        action={async (formData) => {
          return createReport({ success: false, message: "" }, formData);
        }}
        targetType="ERRAND"
        errandTaskId={errand.id}
      />
    </>
  );
}

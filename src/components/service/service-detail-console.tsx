"use client";

import React, { useState } from "react";
import Link from "next/link";
import { MessageSquare, Calendar, Flag, Edit3, Trash2, MapPin, Star, CheckSquare } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { StatusBadge } from "@/components/ui/status-badge";
import { UserSummaryCard } from "@/components/ui/user-summary-card";
import { ServiceBookingDrawer } from "@/components/service/service-booking-drawer";
import { ReportDialog } from "@/components/ui/report-dialog";
import { MobileActionBar } from "@/components/ui/mobile-action-bar";
import { ServiceStatusActions } from "@/components/service/service-status-actions";
import { SERVICE_PRICING_UNIT_LABELS, SERVICE_STATUS_LABELS } from "@/constants/service";
import { createOrOpenServiceConversation } from "@/actions/conversation";
import { createServiceOrder } from "@/actions/order";
import { deleteService } from "@/actions/service";
import { createReport } from "@/actions/trust";
type ServiceListingStatus = "ACTIVE" | "PAUSED" | "OFFLINE" | string;

interface ServiceUserSummary {
  id: string;
  name: string;
  avatarUrl?: string | null;
  schoolName: string;
  completedOrdersCount: number;
  positiveReviewRate?: number | null;
  verificationStatus?: string;
  createdAt: Date | string;
}

interface ServiceDetailConsoleProps {
  service: {
    id: string;
    title: string;
    description: string;
    price: number | string;
    pricingUnit: keyof typeof SERVICE_PRICING_UNIT_LABELS;
    status: ServiceListingStatus;
    locationText: string;
    availableSchedule?: string | null;
    completedOrderCount: number;
    averageRating: number;
    createdAt: Date | string;
    category: { name: string };
    campus: { schoolName: string; name: string };
    providerId: string;
    provider: ServiceUserSummary;
    coverImageUrl?: string | null;
  };
  isOwner: boolean;
  isLoggedIn: boolean;
}

export function ServiceDetailConsole({
  service,
  isOwner,
  isLoggedIn,
}: ServiceDetailConsoleProps) {
  const [bookingOpen, setBookingOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const isStatusActive = service.status === "ACTIVE";

  return (
    <>
      <div className="lg:sticky lg:top-24 space-y-6">
        <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-6">
          {/* 1. 顶部分类与状态 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-slate-800">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {service.category.name}
              </span>
              <StatusBadge
                label={(SERVICE_STATUS_LABELS as Record<string, string>)[service.status] || service.status}
                variant={isStatusActive ? "success" : "neutral"}
                dot
              />
            </div>
            <span className="text-xs text-slate-400">
              {service.campus.schoolName} · {service.campus.name}
            </span>
          </div>

          {/* 2. 标题与定价 */}
          <div className="space-y-2">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-snug dark:text-slate-100">
              {service.title}
            </h1>
            <div className="pt-1">
              <PriceDisplay
                price={service.price}
                unit={SERVICE_PRICING_UNIT_LABELS[service.pricingUnit]}
                size="lg"
              />
            </div>
          </div>

          {/* 3. 关键履约参数 */}
          <div className="space-y-2.5 rounded-2xl bg-slate-50/80 p-4 text-xs text-slate-600 dark:bg-slate-950/40 dark:text-slate-400">
            <div className="flex items-center gap-2">
              <MapPin className="size-4 shrink-0 text-indigo-500" />
              <span className="font-semibold text-slate-900 dark:text-slate-200">服务地点：</span>
              <span className="truncate">{service.locationText}</span>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="size-4 shrink-0 text-indigo-500" />
              <span className="font-semibold text-slate-900 dark:text-slate-200">可预约时间：</span>
              <span className="truncate">{service.availableSchedule || "弹性协商"}</span>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 dark:border-slate-800">
              <span className="flex items-center gap-1">
                <CheckSquare className="size-3.5 text-emerald-500" />
                已接成单 {service.completedOrderCount} 单
              </span>
              <span className="flex items-center gap-1 font-bold text-slate-900 dark:text-slate-100">
                <Star className="size-3.5 fill-amber-400 text-amber-400" />
                {service.averageRating > 0 ? service.averageRating.toFixed(1) : "暂无评分"}
              </span>
            </div>
          </div>

          {/* 4. 服务者卡片 */}
          <div>
            <p className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              服务者信息
            </p>
            <UserSummaryCard user={service.provider} />
          </div>

          {/* 5. 核心操作区 */}
          {isOwner ? (
            /* 服务者本人操作 */
            <div className="space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-3">
                <Link
                  href={`/services/${service.id}/edit`}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-xs font-bold text-white shadow-sm transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                >
                  <Edit3 className="size-4" />
                  <span>编辑服务</span>
                </Link>
                <form action={deleteService}>
                  <input type="hidden" name="serviceId" value={service.id} />
                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700 transition hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    <Trash2 className="size-4" />
                    <span>删除服务</span>
                  </button>
                </form>
              </div>
              <ServiceStatusActions
                serviceId={service.id}
                currentStatus={service.status as "ACTIVE" | "PAUSED" | "OFFLINE"}
              />
            </div>
          ) : (
            /* 买家预约控制区 */
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2.5">
                {/* 私聊联系 */}
                {isLoggedIn && (
                  <form action={createOrOpenServiceConversation} className="flex-1">
                    <input type="hidden" name="serviceId" value={service.id} />
                    <button
                      type="submit"
                      className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-slate-200/90 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-xs transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <MessageSquare className="size-4 text-indigo-600 dark:text-indigo-400" />
                      <span>私聊服务者</span>
                    </button>
                  </form>
                )}

                {/* 举报 */}
                {isLoggedIn && (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="rounded-full p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                    title="举报此服务"
                  >
                    <Flag className="size-4" />
                  </button>
                )}
              </div>

              {/* 预约服务主按键 */}
              {isStatusActive ? (
                isLoggedIn ? (
                  <button
                    type="button"
                    onClick={() => setBookingOpen(true)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-700 hover:to-indigo-800 active:scale-[0.99]"
                  >
                    <Calendar className="size-4" />
                    <span>预约服务</span>
                  </button>
                ) : (
                  <Link
                    href="/login"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3.5 text-sm font-bold text-white shadow-md transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                  >
                    <span>登录后预约</span>
                  </Link>
                )
              ) : (
                <div className="rounded-2xl bg-slate-100 p-3.5 text-center text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  当前服务为“{(SERVICE_STATUS_LABELS as Record<string, string>)[service.status] || service.status}”状态，暂无法预约
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 移动端固定底栏 */}
      {!isOwner && isStatusActive && (
        <MobileActionBar>
          {isLoggedIn && (
            <form action={createOrOpenServiceConversation}>
              <input type="hidden" name="serviceId" value={service.id} />
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
            onClick={() => (isLoggedIn ? setBookingOpen(true) : (window.location.href = "/login"))}
            className="flex-1 max-w-[220px] inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-indigo-600 to-indigo-700 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 active:scale-95"
          >
            <Calendar className="size-3.5" />
            <span>预约服务</span>
          </button>
        </MobileActionBar>
      )}

      {/* 弹窗抽屉 */}
      <ServiceBookingDrawer
        open={bookingOpen}
        onOpenChange={setBookingOpen}
        action={async (formData) => {
          return createServiceOrder({ success: false, message: "" }, formData);
        }}
        service={{
          id: service.id,
          title: service.title,
          price: service.price,
          pricingUnit: service.pricingUnit,
          locationText: service.locationText,
          coverImageUrl: service.coverImageUrl,
        }}
      />

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        action={async (formData) => {
          return createReport({ success: false, message: "" }, formData);
        }}
        targetType="SERVICE"
        serviceListingId={service.id}
      />
    </>
  );
}


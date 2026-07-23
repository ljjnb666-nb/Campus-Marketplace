"use client";

import React, { useState } from "react";
import Link from "next/link";
import { MessageSquare, Repeat, Flag, Edit3, Trash2, MapPin, Eye } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { UserSummaryCard } from "@/components/ui/user-summary-card";
import { RentalBookingDrawer } from "@/components/rental/rental-booking-drawer";
import { ReportDialog } from "@/components/ui/report-dialog";
import { RentalFavoriteButton } from "@/components/rental/rental-favorite-button";
import { MobileActionBar } from "@/components/ui/mobile-action-bar";
import { RentalListingStatusBadge } from "@/components/rental/rental-status-badge";
import { createOrOpenRentalConversation } from "@/actions/conversation";
import { createRentalOrder } from "@/actions/rental-order";
import { deleteRentalListing } from "@/actions/rental-listing";
import { createReport } from "@/actions/trust";
import type { RentalListingStatus } from "@prisma/client";

interface RentalUserSummary {
  id: string;
  name: string;
  avatarUrl?: string | null;
  schoolName: string;
  completedOrdersCount: number;
  positiveReviewRate?: number | null;
  verificationStatus?: string;
  createdAt: Date | string;
}

interface RentalDetailConsoleProps {
  listing: {
    id: string;
    title: string;
    description: string;
    price: number | string;
    pricingUnit: string;
    depositAmount: number | string;
    referenceValue?: number | string | null;
    minimumDuration: number;
    maximumDuration: number;
    pickupLocation: string;
    returnLocation: string;
    usageRules?: string | null;
    damagePolicy?: string | null;
    overduePolicy?: string | null;
    requiresApproval: boolean;
    status: RentalListingStatus;
    viewCount: number;
    favoriteCount: number;
    ownerId: string;
    owner: RentalUserSummary;
    category: { name: string };
    campus: { schoolName: string; name: string };
    images?: { url: string }[];
  };
  isOwner: boolean;
  isFavorited: boolean;
  isLoggedIn: boolean;
}

const UNIT_LABELS: Record<string, string> = {
  PER_HOUR: "小时",
  PER_DAY: "天",
  PER_WEEK: "周",
  PER_MONTH: "月",
  PER_SESSION: "次",
};

export function RentalDetailConsole({
  listing,
  isOwner,
  isFavorited,
  isLoggedIn,
}: RentalDetailConsoleProps) {
  const [bookingOpen, setBookingOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const isStatusAvailable = listing.status === "AVAILABLE";
  const isFreeDeposit = Number(listing.depositAmount) === 0;

  return (
    <>
      <div className="lg:sticky lg:top-24 space-y-6">
        <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-6">
          {/* 1. 分类与状态 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-slate-800">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {listing.category.name}
              </span>
              <RentalListingStatusBadge status={listing.status} />
              {isFreeDeposit && (
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700 border border-indigo-200/60 dark:bg-indigo-950/40 dark:text-indigo-300">
                  免押金
                </span>
              )}
            </div>
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Eye className="size-3.5" />
              {listing.viewCount + 1}
            </span>
          </div>

          {/* 2. 标题与租金 */}
          <div className="space-y-2">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-snug dark:text-slate-100">
              {listing.title}
            </h1>
            <div className="flex items-baseline justify-between pt-1">
              <PriceDisplay
                price={listing.price}
                unit={UNIT_LABELS[listing.pricingUnit]}
                size="lg"
              />
              <span className="text-xs text-slate-500 font-medium">
                {isFreeDeposit ? "免押金" : `押金 ¥${Number(listing.depositAmount).toFixed(0)}`}
              </span>
            </div>
          </div>

          {/* 3. 租还位置与租期规则 */}
          <div className="space-y-2.5 rounded-2xl bg-slate-50/80 p-4 text-xs text-slate-600 dark:bg-slate-950/40 dark:text-slate-400">
            <div className="flex items-center gap-2">
              <MapPin className="size-4 shrink-0 text-indigo-500" />
              <span className="font-semibold text-slate-900 dark:text-slate-200">取货位置：</span>
              <span className="truncate">{listing.pickupLocation}</span>
            </div>
            <div className="flex items-center gap-2">
              <MapPin className="size-4 shrink-0 text-emerald-500" />
              <span className="font-semibold text-slate-900 dark:text-slate-200">归还位置：</span>
              <span className="truncate">{listing.returnLocation}</span>
            </div>
            <div className="border-t border-slate-100 pt-2 flex items-center justify-between text-slate-500 dark:border-slate-800">
              <span>起租与最大限制：</span>
              <span className="font-semibold text-slate-900 dark:text-slate-200">
                {listing.minimumDuration} ~ {listing.maximumDuration} 个{UNIT_LABELS[listing.pricingUnit]}
              </span>
            </div>
          </div>

          {/* 4. 出租者信息 */}
          <div>
            <p className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              出租者信息
            </p>
            <UserSummaryCard user={listing.owner} />
          </div>

          {/* 5. 核心操作区 */}
          {isOwner ? (
            /* 出租者本人管理 */
            <div className="space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-3">
                <Link
                  href={`/rentals/${listing.id}/edit`}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-xs font-bold text-white shadow-sm transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                >
                  <Edit3 className="size-4" />
                  <span>编辑物品</span>
                </Link>
                <form action={deleteRentalListing}>
                  <input type="hidden" name="listingId" value={listing.id} />
                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700 transition hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    <Trash2 className="size-4" />
                    <span>删除物品</span>
                  </button>
                </form>
              </div>
            </div>
          ) : (
            /* 租客买家控制阵列 */
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2.5">
                {/* 收藏 */}
                <RentalFavoriteButton
                  rentalListingId={listing.id}
                  isFavorited={isFavorited}
                  count={listing.favoriteCount}
                  isLoggedIn={isLoggedIn}
                />

                {/* 私聊 */}
                {isLoggedIn && (
                  <form action={createOrOpenRentalConversation} className="flex-1">
                    <input type="hidden" name="rentalListingId" value={listing.id} />
                    <button
                      type="submit"
                      className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-slate-200/90 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-xs transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <MessageSquare className="size-4 text-indigo-600 dark:text-indigo-400" />
                      <span>私聊出租者</span>
                    </button>
                  </form>
                )}

                {/* 举报 */}
                {isLoggedIn && (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="rounded-full p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                    title="举报此物品"
                  >
                    <Flag className="size-4" />
                  </button>
                )}
              </div>

              {/* 立即租用按键 */}
              {isStatusAvailable ? (
                isLoggedIn ? (
                  <button
                    type="button"
                    onClick={() => setBookingOpen(true)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-700 hover:to-indigo-800 active:scale-[0.99]"
                  >
                    <Repeat className="size-4" />
                    <span>立即租用</span>
                  </button>
                ) : (
                  <Link
                    href="/login"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3.5 text-sm font-bold text-white shadow-md transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                  >
                    <span>登录后预约租赁</span>
                  </Link>
                )
              ) : (
                <div className="rounded-2xl bg-slate-100 p-3.5 text-center text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  当前物品不可租
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 移动端固定底栏 */}
      {!isOwner && isStatusAvailable && (
        <MobileActionBar>
          <div className="flex items-center gap-2">
            <RentalFavoriteButton
              rentalListingId={listing.id}
              isFavorited={isFavorited}
              count={listing.favoriteCount}
              isLoggedIn={isLoggedIn}
            />
            {isLoggedIn && (
              <form action={createOrOpenRentalConversation}>
                <input type="hidden" name="rentalListingId" value={listing.id} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700"
                >
                  <MessageSquare className="size-3.5 text-indigo-600" />
                  <span>私聊</span>
                </button>
              </form>
            )}
          </div>

          <button
            type="button"
            onClick={() => (isLoggedIn ? setBookingOpen(true) : (window.location.href = "/login"))}
            className="flex-1 max-w-[200px] inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-indigo-600 to-indigo-700 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 active:scale-95"
          >
            <Repeat className="size-3.5" />
            <span>立即租用</span>
          </button>
        </MobileActionBar>
      )}

      {/* 弹窗抽屉 */}
      <RentalBookingDrawer
        open={bookingOpen}
        onOpenChange={setBookingOpen}
        action={async (formData) => {
          return createRentalOrder({ success: false, message: "" }, formData);
        }}
        listing={{
          id: listing.id,
          title: listing.title,
          price: listing.price,
          pricingUnit: listing.pricingUnit,
          depositAmount: listing.depositAmount,
          minimumDuration: listing.minimumDuration,
          maximumDuration: listing.maximumDuration,
          pickupLocation: listing.pickupLocation,
          returnLocation: listing.returnLocation,
          usageRules: listing.usageRules,
          damagePolicy: listing.damagePolicy,
          overduePolicy: listing.overduePolicy,
          requiresApproval: listing.requiresApproval,
          images: listing.images,
        }}
      />

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        action={async (formData) => {
          return createReport({ success: false, message: "" }, formData);
        }}
        targetType="RENTAL"
        rentalListingId={listing.id}
      />
    </>
  );
}

"use client";

import React, { useState } from "react";
import Link from "next/link";
import { MessageSquare, ShoppingBag, Flag, Edit3, Trash2, MapPin, Eye } from "lucide-react";
import { PriceDisplay } from "@/components/ui/price-display";
import { StatusBadge } from "@/components/ui/status-badge";
import { UserSummaryCard } from "@/components/ui/user-summary-card";
import { FavoriteButton } from "@/components/product/favorite-button";
import { PurchaseDrawer } from "@/components/ui/purchase-drawer";
import { ReportDialog } from "@/components/ui/report-dialog";
import { MobileActionBar } from "@/components/ui/mobile-action-bar";
import { ProductStatusActions } from "@/components/product/product-status-actions";
import { PRODUCT_CONDITION_LABELS, PRODUCT_STATUS_LABELS } from "@/constants/product";
import { createOrOpenProductConversation } from "@/actions/conversation";
import { createProductOrder } from "@/actions/order";
import { deleteProduct } from "@/actions/product";
import { createReport } from "@/actions/trust";
type ProductStatus = "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" | "PAUSED" | string;
type ProductCondition = "NEW" | "LIKE_NEW" | "LIGHTLY_USED" | "NORMAL_USED" | "HEAVILY_USED" | string;

interface ProductUserSummary {
  id: string;
  name: string;
  avatarUrl?: string | null;
  schoolName: string;
  completedOrdersCount: number;
  positiveReviewRate?: number | null;
  verificationStatus?: string;
  createdAt: Date | string;
}

interface ProductDetailConsoleProps {
  product: {
    id: string;
    title: string;
    description: string;
    price: number | string;
    originalPrice?: number | string | null;
    condition: ProductCondition;
    status: ProductStatus;
    locationText: string;
    viewCount: number;
    favoriteCount: number;
    sellerId: string;
    seller: ProductUserSummary;
    category: { name: string };
    campus: { schoolName: string; name: string };
    images?: { url: string }[];
  };
  isSeller: boolean;
  isFavorited: boolean;
  isLoggedIn: boolean;
}

export function ProductDetailConsole({
  product,
  isSeller,
  isFavorited,
  isLoggedIn,
}: ProductDetailConsoleProps) {
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const isStatusActive = product.status === "ACTIVE";

  return (
    <>
      <div className="lg:sticky lg:top-24 space-y-6">
        <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-6">
          {/* 1. 顶部分类与状态 */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-slate-800">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {product.category.name}
              </span>
              <StatusBadge
                label={PRODUCT_CONDITION_LABELS[product.condition] || product.condition}
                variant="primary"
              />
              <StatusBadge
                label={(PRODUCT_STATUS_LABELS as Record<string, string>)[product.status] || product.status}
                variant={isStatusActive ? "success" : "neutral"}
                dot
              />
            </div>
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Eye className="size-3.5" />
              {product.viewCount + 1}
            </span>
          </div>

          {/* 2. 标题与价格 */}
          <div className="space-y-2">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-snug dark:text-slate-100">
              {product.title}
            </h1>
            <div className="flex items-baseline justify-between pt-1">
              <PriceDisplay price={product.price} size="lg" />
              {product.originalPrice && Number(product.originalPrice) > 0 && (
                <span className="text-xs text-slate-400 line-through">
                  原价 ¥{Number(product.originalPrice).toFixed(0)}
                </span>
              )}
            </div>
          </div>

          {/* 3. 交易位置说明 */}
          <div className="flex items-center gap-2 rounded-2xl bg-slate-50/80 p-3.5 text-xs text-slate-600 dark:bg-slate-950/40 dark:text-slate-400">
            <MapPin className="size-4 text-indigo-500 shrink-0" />
            <span className="font-semibold text-slate-900 dark:text-slate-200">交易地点：</span>
            <span className="truncate">{product.locationText}</span>
          </div>

          {/* 4. 卖家信息卡片 */}
          <div>
            <p className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              卖家信息
            </p>
            <UserSummaryCard user={product.seller} />
          </div>

          {/* 5. 核心操作阵列 */}
          {isSeller ? (
            /* 卖家本人操作面板 */
            <div className="space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-3">
                <Link
                  href={`/products/${product.id}/edit`}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-xs font-bold text-white shadow-sm transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                >
                  <Edit3 className="size-4" />
                  <span>编辑商品</span>
                </Link>
                <form action={deleteProduct}>
                  <input type="hidden" name="productId" value={product.id} />
                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700 transition hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    <Trash2 className="size-4" />
                    <span>删除商品</span>
                  </button>
                </form>
              </div>

              <ProductStatusActions productId={product.id} currentStatus={product.status as "ACTIVE" | "PAUSED" | "SOLD" | "RESERVED" | "OFFLINE"} />
            </div>
          ) : (
            /* 普通买家控制阵列 */
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2.5">
                {/* 收藏按钮 */}
                <FavoriteButton
                  productId={product.id}
                  isFavorited={isFavorited}
                  count={product.favoriteCount}
                />

                {/* 私聊卖家 */}
                {isLoggedIn && (
                  <form action={createOrOpenProductConversation} className="flex-1">
                    <input type="hidden" name="productId" value={product.id} />
                    <button
                      type="submit"
                      className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-slate-200/90 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-xs transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <MessageSquare className="size-4 text-indigo-600 dark:text-indigo-400" />
                      <span>私聊卖家</span>
                    </button>
                  </form>
                )}

                {/* 举报悬浮 */}
                {isLoggedIn && (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="rounded-full p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                    title="举报商品"
                  >
                    <Flag className="size-4" />
                  </button>
                )}
              </div>

              {/* 核心下单按键 */}
              {isStatusActive ? (
                isLoggedIn ? (
                  <button
                    type="button"
                    onClick={() => setPurchaseOpen(true)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-700 hover:to-indigo-800 active:scale-[0.99]"
                  >
                    <ShoppingBag className="size-4" />
                    <span>立即购买</span>
                  </button>
                ) : (
                  <Link
                    href="/login"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3.5 text-sm font-bold text-white shadow-md transition hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
                  >
                    <span>登录后购买</span>
                  </Link>
                )
              ) : (
                <div className="rounded-2xl bg-slate-100 p-3.5 text-center text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  当前商品为“{(PRODUCT_STATUS_LABELS as Record<string, string>)[product.status] || product.status}”状态，不可购买
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 移动端固定底栏 */}
      {!isSeller && isStatusActive && (
        <MobileActionBar>
          <div className="flex items-center gap-2">
            <FavoriteButton
              productId={product.id}
              isFavorited={isFavorited}
              count={product.favoriteCount}
            />
            {isLoggedIn && (
              <form action={createOrOpenProductConversation}>
                <input type="hidden" name="productId" value={product.id} />
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
            onClick={() => (isLoggedIn ? setPurchaseOpen(true) : (window.location.href = "/login"))}
            className="flex-1 max-w-[200px] inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-indigo-600 to-indigo-700 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 active:scale-95"
          >
            <ShoppingBag className="size-3.5" />
            <span>立即购买</span>
          </button>
        </MobileActionBar>
      )}

      {/* 弹窗抽屉 */}
      <PurchaseDrawer
        open={purchaseOpen}
        onOpenChange={setPurchaseOpen}
        action={async (formData) => {
          return createProductOrder({ success: false, message: "" }, formData);
        }}
        product={{
          id: product.id,
          title: product.title,
          price: product.price,
          originalPrice: product.originalPrice,
          locationText: product.locationText,
          images: product.images,
        }}
      />

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        action={async (formData) => {
          return createReport({ success: false, message: "" }, formData);
        }}
        targetType="PRODUCT"
        productId={product.id}
      />
    </>
  );
}

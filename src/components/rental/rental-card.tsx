import React from "react";
import Link from "next/link";
import { MapPin, ShieldCheck, Heart } from "lucide-react";
import { RentalListingStatusBadge, RentalListingStatus } from "./rental-status-badge";
import { PriceDisplay } from "@/components/ui/price-display";

type RentalCardProps = {
  id: string;
  title: string;
  price: string | number;
  pricingUnit: "PER_HOUR" | "PER_DAY" | "PER_WEEK" | "PER_MONTH" | "PER_SESSION";
  depositAmount: string | number;
  pickupLocation: string;
  status: RentalListingStatus;
  imageUrl?: string;
  ownerName: string;
  ownerVerified: boolean;
  favoriteCount: number;
  categoryName: string;
};

const unitMapping = {
  PER_HOUR: "小时",
  PER_DAY: "天",
  PER_WEEK: "周",
  PER_MONTH: "月",
  PER_SESSION: "次",
};

export function RentalCard({
  id,
  title,
  price,
  pricingUnit,
  depositAmount,
  pickupLocation,
  status,
  imageUrl,
  ownerName,
  ownerVerified,
  favoriteCount,
  categoryName,
}: RentalCardProps) {
  const isFreeDeposit = Number(depositAmount) === 0;

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xs transition-all duration-300 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <Link href={`/rentals/${id}`} className="flex flex-col h-full">
        {/* 封面图 */}
        <div className="relative aspect-4/3 w-full overflow-hidden bg-slate-100 dark:bg-slate-800">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={title}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
              无物品图片
            </div>
          )}

          <div className="absolute right-2.5 top-2.5 z-10">
            <RentalListingStatusBadge status={status} />
          </div>

          {isFreeDeposit && (
            <div className="absolute left-2.5 top-2.5 z-10">
              <span className="inline-block rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-xs">
                免押金
              </span>
            </div>
          )}

          <div className="absolute bottom-2.5 left-2.5 z-10">
            <span className="inline-block rounded-md bg-slate-900/60 backdrop-blur-xs px-2 py-0.5 text-[10px] font-semibold text-white">
              {categoryName}
            </span>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex flex-1 flex-col p-3.5 space-y-2">
          <h3 className="text-sm sm:text-base font-bold text-slate-900 line-clamp-1 group-hover:text-indigo-600 transition duration-200 dark:text-slate-100 dark:group-hover:text-indigo-400">
            {title}
          </h3>

          <div className="flex items-baseline justify-between">
            <PriceDisplay
              price={price}
              unit={unitMapping[pricingUnit]}
              size="sm"
            />
            {!isFreeDeposit && (
              <span className="text-[10px] text-slate-400">
                押金 ¥{Number(depositAmount).toFixed(0)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 text-xs text-slate-500 truncate pt-1">
            <MapPin className="size-3.5 text-indigo-500 shrink-0" />
            <span className="truncate">{pickupLocation}</span>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 dark:border-slate-800">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-700">
                {ownerName.charAt(0).toUpperCase()}
              </div>
              <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">{ownerName}</span>
              {ownerVerified && (
                <ShieldCheck className="size-3.5 shrink-0 text-emerald-500" />
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0 text-[10px] text-slate-400">
              <Heart className={`size-3 ${favoriteCount > 0 ? "fill-rose-500 text-rose-500" : ""}`} />
              <span>{favoriteCount}</span>
            </div>
          </div>
        </div>
      </Link>
    </article>
  );
}

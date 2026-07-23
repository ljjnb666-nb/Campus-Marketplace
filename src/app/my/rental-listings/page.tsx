import React from "react";
import Link from "next/link";
import Image from "next/image";
import { requireUser } from "@/lib/server-auth";
import { getMyRentalListings } from "@/repositories/rental-listing-repository";
import { RentalListingStatusBadge } from "@/components/rental/rental-status-badge";
import { updateRentalListingStatus } from "@/actions/rental-listing";
import type { RentalListingStatus } from "@prisma/client";
import type { Decimal } from "@prisma/client/runtime/library";

export const dynamic = "force-dynamic";

type RentalListing = {
  id: string;
  title: string;
  price: Decimal;
  status: string;
  depositAmount: Decimal;
  images: Array<{ url: string }>;
  pricingUnit: string;
  availableQuantity: number;
  totalQuantity: number;
};

export default async function MyRentalListingsPage() {
  const user = await requireUser();
  const listings = await getMyRentalListings(user.id);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold text-slate-950">出租物品管理</h1>
          <p className="text-sm text-slate-600">
            管理您发布的租赁物品，调整状态或修改信息
          </p>
        </div>
        <Link
          href="/rentals/new"
          className="rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800"
        >
          发布新物品
        </Link>
      </div>

      {listings.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          您还没有发布过租赁物品，赶快发布一个试试吧。
        </div>
      ) : (
        <div className="space-y-4">
          {listings.map((item: RentalListing) => (
            <div
              key={item.id}
              className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center"
            >
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-slate-100">
                {item.images?.[0]?.url ? (
                  <Image
                    src={item.images[0].url}
                    alt={item.title}
                    width={80}
                    height={80}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-400">无图</div>
                )}
              </div>
              
              <div className="flex-1 min-w-0">
                <Link href={`/rentals/${item.id}`} className="block truncate text-lg font-bold text-slate-900 hover:text-indigo-600 transition">
                  {item.title}
                </Link>
                <div className="mt-1 flex flex-wrap gap-2 text-sm text-slate-500">
                  <span className="font-semibold text-indigo-600">¥{Number(item.price).toFixed(2)}</span>
                  <span className="text-xs">/ {item.pricingUnit}</span>
                  <span className="mx-1 text-slate-300">|</span>
                  <span>库存: {item.availableQuantity}/{item.totalQuantity}</span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <RentalListingStatusBadge status={item.status as RentalListingStatus} />
                
                <div className="flex flex-col gap-2 border-l border-slate-100 pl-4 sm:flex-row sm:items-center">
                  <form action={updateRentalListingStatus} className="flex gap-2">
                    <input type="hidden" name="id" value={item.id} />
                    {item.status === "AVAILABLE" && (
                      <>
                        <button type="submit" name="status" value="PAUSED" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                          暂停
                        </button>
                        <button type="submit" name="status" value="OFFLINE" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                          下架
                        </button>
                      </>
                    )}
                    {item.status === "PAUSED" && (
                      <button type="submit" name="status" value="AVAILABLE" className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">
                        恢复
                      </button>
                    )}
                    {item.status === "OFFLINE" && (
                      <button type="submit" name="status" value="AVAILABLE" className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">
                        重新上架
                      </button>
                    )}
                  </form>
                  <Link
                    href={`/rentals/${item.id}/edit`}
                    className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800"
                  >
                    编辑
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

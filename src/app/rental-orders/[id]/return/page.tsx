import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { confirmReturn, requestReturn } from "@/actions/rental-order";
import { RentalActionForm } from "@/components/rental/rental-action-form";
import { Camera } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ReturnVerificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order || (order.ownerId !== user.id && order.renterId !== user.id)) {
    notFound();
  }

  const isRenter = user.id === order.renterId;
  // requestReturn 状态机允许租客在 IN_RENTAL / OVERDUE / PICKED_UP 发起归还
  const isRequestingReturn =
    isRenter && ["IN_RENTAL", "OVERDUE", "PICKED_UP"].includes(order.status);

  // PENDING_RETURN / PENDING_INSPECTION 走 confirmReturn 双向确认；租客发起归还走 requestReturn
  if (order.status !== "IN_RENTAL" && order.status !== "PENDING_RETURN" && !isRequestingReturn) {
    redirect(`/rental-orders/${id}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">{isRenter ? "申请归还物品" : "确认收到归还"}</h1>
        <p className="text-sm text-slate-600">
          {isRequestingReturn ? "提交后请与出租者约定时间当面归还物品" : "拍照留存物品归还时的状态，避免纠纷"}
        </p>
      </div>

      <RentalActionForm
        action={isRequestingReturn ? requestReturn : confirmReturn}
        submitLabel={isRenter ? "提交归还申请" : "确认完好归还"}
        className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-8"
      >
        <input type="hidden" name="orderId" value={id} />
        <input type="hidden" name="role" value={isRenter ? "renter" : "owner"} />

        <div className="rounded-2xl bg-indigo-50 p-4 mb-6">
          <h3 className="font-bold text-indigo-900 mb-1">{order.rentalListing.title}</h3>
          <p className="text-sm text-indigo-700">归还地点：{order.rentalListing.returnLocation}</p>
        </div>

        {isRequestingReturn ? (
          <p className="rounded-2xl bg-slate-50 p-4 text-xs text-slate-500">
            提交归还申请后订单将进入“待归还”状态，由出租者当面验收物品；如需拍照留存，可在验收时补充。
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">物品归还照片 <span className="text-slate-400">（选填，最多5张）</span></label>
              <div className="flex flex-wrap gap-4">
                <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:border-indigo-400 hover:text-indigo-500">
                  <Camera className="h-6 w-6 mb-1" />
                  <span className="text-[10px]">拍摄/上传</span>
                  <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple className="hidden" />
                </label>
              </div>
              <p className="text-xs text-slate-500">请重点拍摄物品外观，证明物品完好无损</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">归还备注（选填）</label>
              <textarea
                name="inspectionNote"
                rows={4}
                placeholder="例如：物品一切正常，配件齐全..."
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>
        )}
      </RentalActionForm>
    </div>
  );
}

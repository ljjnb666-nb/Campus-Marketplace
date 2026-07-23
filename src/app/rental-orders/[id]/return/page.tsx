import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { confirmReturn } from "@/actions/rental-order";
import { Camera } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ReturnVerificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order || (order.ownerId !== user.id && order.renterId !== user.id)) {
    notFound();
  }

  // PENDING_RETURN is for owner confirming return, IN_RENTAL is for renter requesting return
  if (order.status !== "IN_RENTAL" && order.status !== "PENDING_RETURN") {
    redirect(`/rental-orders/${id}`);
  }

  const isRenter = user.id === order.renterId;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">{isRenter ? "申请归还物品" : "确认收到归还"}</h1>
        <p className="text-sm text-slate-600">
          拍照留存物品归还时的状态，避免纠纷
        </p>
      </div>

      <form action={confirmReturn} className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-8">
        <input type="hidden" name="orderId" value={id} />

        <div className="rounded-2xl bg-indigo-50 p-4 mb-6">
          <h3 className="font-bold text-indigo-900 mb-1">{order.rentalListing.title}</h3>
          <p className="text-sm text-indigo-700">归还地点：{order.rentalListing.returnLocation}</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">物品归还照片 <span className="text-slate-400">（必填，最多4张）</span></label>
            <div className="flex flex-wrap gap-4">
              <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:border-indigo-400 hover:text-indigo-500">
                <Camera className="h-6 w-6 mb-1" />
                <span className="text-[10px]">拍摄/上传</span>
                <input type="file" accept="image/*" multiple className="hidden" />
              </label>
              <input type="hidden" name="returnImages" value="mock-return-url.jpg" />
            </div>
            <p className="text-xs text-slate-500">请重点拍摄物品外观，证明物品完好无损</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">归还备注（选填）</label>
            <textarea
              name="returnNotes"
              rows={4}
              placeholder="例如：物品一切正常，配件齐全..."
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        </div>

        <button
          type="submit"
          className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800"
        >
          {isRenter ? "提交归还申请" : "确认完好归还"}
        </button>
      </form>
    </div>
  );
}

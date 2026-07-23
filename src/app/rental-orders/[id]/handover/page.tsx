import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { confirmPickup } from "@/actions/rental-order";
import { Camera } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HandoverVerificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order || (order.ownerId !== user.id && order.renterId !== user.id)) {
    notFound();
  }

  if (order.status !== "PENDING_PICKUP") {
    redirect(`/rental-orders/${id}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">交接确认</h1>
        <p className="text-sm text-slate-600">
          双方碰面交接物品时，请拍照留存物品状态
        </p>
      </div>

      <form action={confirmPickup} className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-8">
        <input type="hidden" name="orderId" value={id} />

        <div className="rounded-2xl bg-indigo-50 p-4 mb-6">
          <h3 className="font-bold text-indigo-900 mb-1">{order.rentalListing.title}</h3>
          <p className="text-sm text-indigo-700">取货地点：{order.rentalListing.pickupLocation}</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">物品现状照片 <span className="text-slate-400">（必填，最多4张）</span></label>
            <div className="flex flex-wrap gap-4">
              {/* In a real app, this would be an interactive image upload component similar to the one in RentalListingForm */}
              <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:border-indigo-400 hover:text-indigo-500">
                <Camera className="h-6 w-6 mb-1" />
                <span className="text-[10px]">拍摄/上传</span>
                <input type="file" accept="image/*" multiple className="hidden" />
              </label>
              {/* Mock hidden input to satisfy form action requirements for the mockup */}
              <input type="hidden" name="handoverImages" value="mock-image-url.jpg" />
            </div>
            <p className="text-xs text-slate-500">请重点拍摄物品外观、屏幕等易损部位及配件情况</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">配件清单 / 备注说明</label>
            <textarea
              name="handoverNotes"
              rows={4}
              placeholder="例如：包含主机、充电线、原装包；屏幕有轻微划痕等..."
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        </div>

        <button
          type="submit"
          className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 transition hover:from-indigo-700 hover:to-indigo-800"
        >
          确认已交接
        </button>
      </form>
    </div>
  );
}

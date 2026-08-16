import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { submitRentalReview } from "@/actions/rental-order";
import { RentalActionForm } from "@/components/rental/rental-action-form";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order || (order.ownerId !== user.id && order.renterId !== user.id)) {
    notFound();
  }

  // submitRentalReview 仅允许 COMPLETED 订单的评价方提交
  if (order.status !== "COMPLETED") {
    redirect(`/rental-orders/${id}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">评价本次租赁</h1>
        <p className="text-sm text-slate-600">你的评价将帮助其他同学了解对方的租赁信用</p>
      </div>

      <RentalActionForm
        action={submitRentalReview}
        submitLabel="提交评价"
        className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-8"
      >
        <input type="hidden" name="orderId" value={id} />

        <div className="rounded-2xl bg-indigo-50 p-4 mb-6">
          <h3 className="font-bold text-indigo-900 mb-1">{order.rentalListing.title}</h3>
        </div>

        <div className="space-y-2">
          <label htmlFor="overallRating" className="text-sm font-medium text-slate-700">整体评分（必填）</label>
          <select
            name="overallRating"
            id="overallRating"
            required
            defaultValue="5"
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          >
            <option value="5">★★★★★ 非常满意</option>
            <option value="4">★★★★ 满意</option>
            <option value="3">★★★ 一般</option>
            <option value="2">★★ 不满意</option>
            <option value="1">★ 很不满意</option>
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor="content" className="text-sm font-medium text-slate-700">评价内容（选填，最多500字）</label>
          <textarea
            name="content"
            id="content"
            rows={4}
            maxLength={500}
            placeholder="例如：物品状况良好，交接顺利，出租者很守时..."
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      </RentalActionForm>
    </div>
  );
}

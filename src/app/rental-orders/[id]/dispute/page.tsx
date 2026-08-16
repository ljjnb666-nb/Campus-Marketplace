import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { initiateDispute } from "@/actions/rental-order";
import { isDisputableStatus } from "@/lib/rental-order-machine";
import { RentalActionForm } from "@/components/rental/rental-action-form";

export const dynamic = "force-dynamic";

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order || (order.ownerId !== user.id && order.renterId !== user.id)) {
    notFound();
  }

  if (!isDisputableStatus(order.status)) {
    redirect(`/rental-orders/${id}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">发起纠纷</h1>
        <p className="text-sm text-slate-600">
          提交后订单将进入纠纷处理流程，请如实描述问题经过
        </p>
      </div>

      <RentalActionForm
        action={initiateDispute}
        submitLabel="提交纠纷申请"
        className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-8"
      >
        <input type="hidden" name="orderId" value={id} />

        <div className="rounded-2xl bg-amber-50 p-4 mb-6">
          <h3 className="font-bold text-amber-900 mb-1">{order.rentalListing.title}</h3>
          <p className="text-sm text-amber-700">纠纷将由平台管理员介入处理</p>
        </div>

        <div className="space-y-2">
          <label htmlFor="reason" className="text-sm font-medium text-slate-700">纠纷原因（必填，至少5个字）</label>
          <textarea
            name="reason"
            id="reason"
            rows={5}
            required
            minLength={5}
            maxLength={1000}
            placeholder="例如：归还的物品与出租时不符，租客拒绝沟通..."
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      </RentalActionForm>
    </div>
  );
}

import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { submitDamageClaim } from "@/actions/rental-order";
import { RentalActionForm } from "@/components/rental/rental-action-form";
import { Camera } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DamageClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order || (order.ownerId !== user.id && order.renterId !== user.id)) {
    notFound();
  }

  // submitDamageClaim 仅允许出租者在 PENDING_INSPECTION 提交
  if (order.ownerId !== user.id || order.status !== "PENDING_INSPECTION") {
    redirect(`/rental-orders/${id}`);
  }

  const depositAmount = Number(order.depositAmount);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">提交损坏索赔</h1>
        <p className="text-sm text-slate-600">
          描述物品损坏情况并申请扣除押金，租客确认后将从押金中扣除相应金额
        </p>
      </div>

      <RentalActionForm
        action={submitDamageClaim}
        submitLabel="提交索赔"
        className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-md md:p-8"
      >
        <input type="hidden" name="orderId" value={id} />

        <div className="rounded-2xl bg-rose-50 p-4 mb-6">
          <h3 className="font-bold text-rose-900 mb-1">{order.rentalListing.title}</h3>
          <p className="text-sm text-rose-700">押金金额：¥{depositAmount.toFixed(2)}</p>
        </div>

        <div className="space-y-2">
          <label htmlFor="damageDescription" className="text-sm font-medium text-slate-700">损坏描述（必填，至少5个字）</label>
          <textarea
            name="damageDescription"
            id="damageDescription"
            rows={4}
            required
            minLength={5}
            maxLength={1000}
            placeholder="例如：相机镜头有明显划痕，影响成像..."
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="requestedDeduction" className="text-sm font-medium text-slate-700">申请扣除金额（元）</label>
          <input
            type="number"
            name="requestedDeduction"
            id="requestedDeduction"
            required
            min={0}
            max={depositAmount}
            step="0.01"
            defaultValue={depositAmount.toFixed(2)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <p className="text-xs text-slate-500">最高可申请扣除全部押金 ¥{depositAmount.toFixed(2)}</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">损坏照片 <span className="text-slate-400">（选填，最多5张）</span></label>
          <div className="flex flex-wrap gap-4">
            <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:border-indigo-400 hover:text-indigo-500">
              <Camera className="h-6 w-6 mb-1" />
              <span className="text-[10px]">拍摄/上传</span>
              <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple className="hidden" />
            </label>
          </div>
          <p className="text-xs text-slate-500">请拍摄损坏部位，作为索赔凭证</p>
        </div>
      </RentalActionForm>
    </div>
  );
}

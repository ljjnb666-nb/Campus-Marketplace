import React from "react";
import Link from "next/link";
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
  const pendingClaim = order.damageClaims?.find(claim => !claim.resolvedAt && !claim.supersededAt);
  if (pendingClaim || depositAmount <= 0) return <div className="mx-auto max-w-2xl space-y-4 p-8">
    <h1 className="text-2xl font-bold">{pendingClaim ? "已有待处理索赔" : "本订单未约定押金"}</h1>
    <p>{pendingClaim ? "请等待租客处理现有申请，不必重复提交。" : "如需进一步协助，可在订单详情发起纠纷；也可以结束验收。"}</p>
    <Link href={`/rental-orders/${id}/return`} className="text-indigo-600 underline">返回验收处理</Link>
  </div>;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">提交损坏索赔</h1>
        <p className="text-sm text-slate-600">
          如实说明验收问题并申请线下补偿。租客同意仅记录协商结果，平台不托管押金，也不会自动扣款或退款。
        </p>
      </div>

      <RentalActionForm
        uploadCategory="report"
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
          <label htmlFor="requestedDeduction" className="text-sm font-medium text-slate-700">申请线下补偿金额（元）</label>
          <input
            type="number"
            name="requestedDeduction"
            id="requestedDeduction"
            required
            min={0.01}
            max={depositAmount}
            step="0.01"
            defaultValue={depositAmount.toFixed(2)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <p className="text-xs text-slate-500">申请上限为约定押金 ¥{depositAmount.toFixed(2)}；收付情况由双方线下核对。</p>
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

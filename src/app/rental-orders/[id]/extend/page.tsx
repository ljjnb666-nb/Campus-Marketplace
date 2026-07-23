import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { getRentalOrderDetail } from "@/repositories/rental-order-repository";
import { RentalExtensionForm } from "./extension-form";

export const dynamic = "force-dynamic";

export default async function ExtendRentalOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const order = await getRentalOrderDetail(id, user.id).catch(() => null);

  if (!order || order.renterId !== user.id) {
    notFound();
  }

  if (order.status !== "IN_RENTAL") {
    redirect(`/rental-orders/${id}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">申请续租</h1>
        <p className="text-sm text-slate-600">
          延长租用时间，续租成功后将自动扣除相应费用
        </p>
      </div>

      <RentalExtensionForm 
        orderId={id} 
        currentEndTime={new Date(order.endTime).toISOString()} 
        price={Number(order.rentalListing.price)} 
        pricingUnit={order.rentalListing.pricingUnit} 
      />
    </div>
  );
}

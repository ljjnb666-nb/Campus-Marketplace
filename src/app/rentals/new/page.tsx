import React from "react";
import { requireUser } from "@/lib/server-auth";
import { RentalListingForm } from "@/components/rental/rental-listing-form";
import { getRentalFormMeta } from "@/repositories/rental-listing-repository";
import { createRentalListing } from "@/actions/rental-listing";

export const dynamic = "force-dynamic";

export default async function NewRentalListingPage() {
  await requireUser();
  const meta = await getRentalFormMeta();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">发布租赁物品</h1>
        <p className="text-sm text-slate-600">
          闲置物品租给校友，轻松赚取额外收益
        </p>
      </div>

      <RentalListingForm
        categories={meta.categories}
        currentCampusName="当前校区"
        action={createRentalListing}
      />
    </div>
  );
}

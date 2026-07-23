import React from "react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/server-auth";
import { RentalListingForm } from "@/components/rental/rental-listing-form";
import { getRentalFormMeta, getRentalListingForEdit } from "@/repositories/rental-listing-repository";
import { updateRentalListing } from "@/actions/rental-listing";

export const dynamic = "force-dynamic";

export default async function EditRentalListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const [meta, listing] = await Promise.all([
    getRentalFormMeta(),
    getRentalListingForEdit(id, user.id).catch(() => null),
  ]);

  if (!listing) {
    notFound();
  }

  if (listing.ownerId !== user.id) {
    redirect(`/rentals/${id}`);
  }

  // Convert decimal to number/string for form
  const defaultValues = {
    ...listing,
    price: Number(listing.price),
    depositAmount: Number(listing.depositAmount),
    referenceValue: listing.referenceValue ? Number(listing.referenceValue) : undefined,
    images: listing.images?.map((img: { url: string }) => img.url) || [],
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 space-y-2 text-center">
        <h1 className="text-3xl font-bold text-slate-950">编辑租赁物品</h1>
        <p className="text-sm text-slate-600">
          修改您的租赁物品信息
        </p>
      </div>

      <RentalListingForm
        categories={meta.categories}
        currentCampusName="当前校区"
        defaultValues={defaultValues}
        action={updateRentalListing}
        listingId={id}
      />
    </div>
  );
}

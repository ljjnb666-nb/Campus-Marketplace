import { cleanup, render, screen, within } from "@testing-library/react";
import type { RentalReturnRecord } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RentalEvidenceRecords } from "./rental-evidence-records";

vi.mock("@/components/shared/private-asset-viewer", () => ({
  PrivateAssetViewer: ({ value }: { value: string }) => <span>{value}</span>,
}));
afterEach(cleanup);

function returned(overrides = {}): RentalReturnRecord {
  return {
    id: "return", orderId: "order", photos: [], ownerPhotos: [], renterPhotos: [],
    hasDamage: false, needsCleaning: false, accessoriesComplete: true, inspectionNote: null,
    renterHasDamage: null, renterNeedsCleaning: null, renterAccessoriesComplete: null, renterInspectionNote: null,
    ownerConfirmed: false, renterConfirmed: false, ownerConfirmedAt: null, renterConfirmedAt: null,
    ownerInspectionRecordedAt: null, isOverdue: false, overdueDuration: null, createdAt: new Date(), updatedAt: new Date(),
    legacyInspectionNote: null, legacyHasDamage: null, legacyNeedsCleaning: null, legacyAccessoriesComplete: null,
    ...overrides,
  };
}

describe("rental participant evidence", () => {
  it("shows independent owner inspection and renter statement without merging authors", () => {
    render(<RentalEvidenceRecords handover={null} returned={returned({
      ownerConfirmedAt: new Date(), ownerInspectionRecordedAt: new Date(), renterConfirmedAt: new Date(),
      hasDamage: true, inspectionNote: "owner scratch", ownerPhotos: ["asset:owner"],
      renterHasDamage: false, renterNeedsCleaning: false, renterAccessoriesComplete: true,
      renterInspectionNote: "renter denies", renterPhotos: ["asset:renter"], photos: ["asset:owner", "asset:renter"],
    })} />);
    const owner = screen.getByText("归还：出租者验收").closest("section")!;
    const renter = screen.getByText("归还：租客陈述").closest("section")!;
    expect(within(owner).getByText("owner scratch")).toBeTruthy();
    expect(within(owner).queryByText("renter denies")).toBeNull();
    expect(within(renter).getByText("renter denies")).toBeTruthy();
    expect(within(renter).queryByText("owner scratch")).toBeNull();
    expect(screen.queryByText("历史归还记录（未区分提交者）")).toBeNull();
  });

  it("does not attribute legacy overwritten inspection to owner despite old confirmation timestamp", () => {
    render(<RentalEvidenceRecords handover={null} returned={returned({
      ownerConfirmed: true, renterConfirmed: true, ownerConfirmedAt: new Date(), renterConfirmedAt: new Date(),
      hasDamage: true, inspectionNote: "legacy shared note", photos: ["asset:legacy"],
      legacyHasDamage: true, legacyNeedsCleaning: false, legacyAccessoriesComplete: true, legacyInspectionNote: "legacy shared note",
    })} />);
    expect(screen.getByText("历史归还记录（未区分提交者）")).toBeTruthy();
    expect(screen.getByText("legacy shared note")).toBeTruthy();
    expect(screen.queryByText("归还：出租者验收")).toBeNull();
    expect(screen.queryByText("归还：租客陈述")).toBeNull();
  });

  it("renter-first submission does not display default owner values as legacy inspection", () => {
    render(<RentalEvidenceRecords handover={null} returned={returned({ renterConfirmedAt: new Date(),
      renterHasDamage: false, renterNeedsCleaning: false, renterAccessoriesComplete: true,
      renterPhotos: ["asset:renter"], photos: ["asset:renter"],
    })} />);
    expect(screen.getByText("归还：租客陈述")).toBeTruthy();
    expect(screen.queryByText("历史归还记录（未区分提交者）")).toBeNull();
    expect(screen.queryByText("归还：出租者验收")).toBeNull();
  });

  it("keeps legacy evidence visible after the owner adds a different inspection", () => {
    render(<RentalEvidenceRecords handover={null} returned={returned({ ownerConfirmedAt: new Date(), ownerInspectionRecordedAt: new Date(),
      hasDamage: false, inspectionNote: "new owner inspection", legacyInspectionNote: "legacy disputed damage",
      legacyHasDamage: true, legacyNeedsCleaning: true, legacyAccessoriesComplete: false,
    })} />);
    const legacy = screen.getByText("历史归还记录（未区分提交者）").closest("section")!;
    const owner = screen.getByText("归还：出租者验收").closest("section")!;
    expect(within(legacy).getByText("legacy disputed damage")).toBeTruthy();
    expect(within(legacy).getByText("有损坏 · 需清洁 · 配件缺失")).toBeTruthy();
    expect(within(owner).getByText("new owner inspection")).toBeTruthy();
    expect(within(owner).queryByText("legacy disputed damage")).toBeNull();
  });
});

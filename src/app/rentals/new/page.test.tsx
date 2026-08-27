import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalFormMeta, getRentalListingForEdit, RentalListingForm, notFound } =
  vi.hoisted(() => ({
    requireUser: vi.fn(),
    getRentalFormMeta: vi.fn(),
    getRentalListingForEdit: vi.fn(),
    RentalListingForm: vi.fn(() => <div data-testid="rental-listing-form" />),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  }));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/repositories/rental-listing-repository", () => ({
  getRentalFormMeta,
  getRentalListingForEdit,
}));
vi.mock("@/components/rental/rental-listing-form", () => ({
  RentalListingForm,
}));
vi.mock("next/navigation", () => ({
  notFound,
  redirect: vi.fn((location: string) => {
    throw new Error(`REDIRECT:${location}`);
  }),
}));

import NewRentalListingPage from "@/app/rentals/new/page";
import EditRentalListingPage from "@/app/rentals/[id]/edit/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewRentalListingPage", () => {
  it("requires login and renders the create form with categories", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getRentalFormMeta.mockResolvedValue({ categories: [{ id: "cat-1" }], campuses: [] });

    render(await NewRentalListingPage());

    expect(screen.getByText("发布租赁物品")).toBeInTheDocument();
    expect(RentalListingForm).toHaveBeenCalledWith(
      expect.objectContaining({ categories: [{ id: "cat-1" }], currentCampusName: "当前校区" }),
      undefined,
    );
  });
});

describe("EditRentalListingPage", () => {
  it("renders the edit form with numeric defaults for the owner", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getRentalFormMeta.mockResolvedValue({ categories: [], campuses: [] });
    getRentalListingForEdit.mockResolvedValue({
      id: "listing-1",
      ownerId: "user-1",
      title: "相机",
      price: { toString: () => "50" },
      depositAmount: { toString: () => "100" },
      referenceValue: { toString: () => "3000" },
      images: [{ url: "/uploads/a.webp" }, { url: "/uploads/b.webp" }],
    });

    render(await EditRentalListingPage({ params: Promise.resolve({ id: "listing-1" }) }));

    expect(screen.getByText("编辑租赁物品")).toBeInTheDocument();
    expect(RentalListingForm).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "listing-1",
        defaultValues: expect.objectContaining({
          price: 50,
          depositAmount: 100,
          referenceValue: 3000,
          images: ["/uploads/a.webp", "/uploads/b.webp"],
        }),
      }),
      undefined,
    );
  });

  it("renders notFound when the listing is missing or owned by someone else", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getRentalFormMeta.mockResolvedValue({ categories: [], campuses: [] });
    getRentalListingForEdit.mockResolvedValue(null);

    await expect(
      EditRentalListingPage({ params: Promise.resolve({ id: "listing-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    // 其他人持有时的删除场景已在 repository 层覆盖 notFound；
    // ownerId 不匹配时页面同样保护
    getRentalListingForEdit.mockResolvedValue({ id: "listing-1", ownerId: "user-2", images: [] });
    await expect(
      EditRentalListingPage({ params: Promise.resolve({ id: "listing-1" }) }),
    ).rejects.toThrow("REDIRECT:/rentals/listing-1");
  });
});

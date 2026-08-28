import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  redirect,
  requireUser,
  containsBannedKeyword,
  uploadImageAsset,
  resolveImageTokens,
  markAssetsForValuesPendingDelete,
  rentalCategoryFindUnique,
  userFindUnique,
  rentalListingFindFirst,
  rentalListingCreate,
  rentalListingUpdate,
  rentalListingImageFindMany,
  rentalListingImageDeleteMany,
  rentalListingImageCreateMany,
  rentalOrderCount,
  transactionMock,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  requireUser: vi.fn(),
  containsBannedKeyword: vi.fn(),
  uploadImageAsset: vi.fn(),
  resolveImageTokens: vi.fn(),
  markAssetsForValuesPendingDelete: vi.fn(),
  rentalCategoryFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  rentalListingFindFirst: vi.fn(),
  rentalListingCreate: vi.fn(),
  rentalListingUpdate: vi.fn(),
  rentalListingImageFindMany: vi.fn(),
  rentalListingImageDeleteMany: vi.fn(),
  rentalListingImageCreateMany: vi.fn(),
  rentalOrderCount: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect,
  notFound: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/moderation", () => ({ containsBannedKeyword }));
vi.mock("@/lib/upload", () => ({
  buildAssetReference: (assetId: string) => `asset:${assetId}`,
  uploadImageAsset,
  resolveImageTokens,
  markAssetsForValuesPendingDelete,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    rentalCategory: { findUnique: rentalCategoryFindUnique },
    user: { findUnique: userFindUnique },
    rentalListing: {
      findFirst: rentalListingFindFirst,
      create: rentalListingCreate,
      update: rentalListingUpdate,
    },
    rentalListingImage: {
      findMany: rentalListingImageFindMany,
      deleteMany: rentalListingImageDeleteMany,
      createMany: rentalListingImageCreateMany,
    },
    rentalOrder: { count: rentalOrderCount },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import {
  createRentalListing,
  deleteRentalListing,
  updateRentalListing,
  updateRentalListingStatus,
} from "@/actions/rental-listing";

function buildListingFormData(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  const base: Record<string, string> = {
    title: "佳能相机出租",
    description: "95新佳能相机，适合拍毕业照，含电池和充电器。",
    categoryId: "cat-1",
    condition: "LIKE_NEW",
    brand: "Canon",
    model: "M50",
    referenceValue: "3000",
    price: "50",
    pricingUnit: "PER_DAY",
    depositAmount: "200",
    minimumDuration: "1",
    maximumDuration: "7",
    totalQuantity: "2",
    pickupLocation: "东门快递点",
    returnLocation: "东门快递点",
    usageRules: "",
    damagePolicy: "",
    overduePolicy: "",
    requiresApproval: "false",
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) {
    formData.set(key, value);
  }
  formData.append("imageUrls", "https://example.com/a.jpg");
  return formData;
}

describe("rental listing actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    containsBannedKeyword.mockResolvedValue(null);
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-1",
      access: "PUBLIC",
      url: "http://localhost:9100/campus-public/public/rentals/user-1/new.webp",
      mimeType: "image/webp",
      sizeBytes: 1024,
    });
    // token 解析 mock：asset 引用 → 公开 URL；其余透传
    resolveImageTokens.mockImplementation(async ({ tokens }: { tokens: string[] }) =>
      tokens.map((token) =>
        token === "asset:asset-1"
          ? "http://localhost:9100/campus-public/public/rentals/user-1/new.webp"
          : token,
      ),
    );
    markAssetsForValuesPendingDelete.mockResolvedValue(0);
    rentalCategoryFindUnique.mockResolvedValue({ id: "cat-1", isActive: true });
    userFindUnique.mockResolvedValue({ campusId: "campus-1" });
    rentalListingCreate.mockResolvedValue({ id: "listing-1" });
    rentalListingUpdate.mockResolvedValue({});
    rentalListingFindFirst.mockResolvedValue({ id: "listing-1", status: "AVAILABLE" });
    rentalListingImageFindMany.mockResolvedValue([]);
    rentalListingImageDeleteMany.mockResolvedValue({ count: 1 });
    rentalListingImageCreateMany.mockResolvedValue({ count: 1 });
    rentalOrderCount.mockResolvedValue(0);
    // withTransaction 使用回调形式，传入共享的 mock 委托
    transactionMock.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return arg({
          rentalListing: { create: rentalListingCreate, update: rentalListingUpdate },
          rentalListingImage: {
            deleteMany: rentalListingImageDeleteMany,
            createMany: rentalListingImageCreateMany,
          },
        });
      }
      for (const op of arg as unknown[]) await op;
    });
  });

  describe("createRentalListing", () => {
    it("creates a listing with parsed numeric fields and images", async () => {
      const result = await createRentalListing(null, buildListingFormData());

      expect(result.success).toBe(true);
      expect(result.redirectTo).toBe("/rentals/listing-1");
      expect(rentalListingCreate).toHaveBeenCalledTimes(1);
      const data = rentalListingCreate.mock.calls[0][0].data;
      expect(data.campusId).toBe("campus-1");
      expect(data.totalQuantity).toBe(2);
      expect(data.availableQuantity).toBe(2);
      expect(data.minimumDuration).toBe(1);
      expect(data.maximumDuration).toBe(7);
      // 图片 token 在事务内解析为 URL 后单独写入图片表
      expect(rentalListingImageCreateMany).toHaveBeenCalledWith({
        data: [
          { rentalListingId: "listing-1", url: "https://example.com/a.jpg", sortOrder: 0 },
        ],
      });
    });

    it("returns a validation error for invalid form data", async () => {
      const result = await createRentalListing(
        null,
        buildListingFormData({ price: "abc" }),
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe("租金格式不正确");
      expect(rentalListingCreate).not.toHaveBeenCalled();
    });

    it("rejects minimum duration greater than maximum", async () => {
      const result = await createRentalListing(
        null,
        buildListingFormData({ minimumDuration: "8", maximumDuration: "7" }),
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe("最短租期不能大于最长租期");
    });

    it("blocks banned keywords", async () => {
      containsBannedKeyword.mockResolvedValue("违禁词");

      const result = await createRentalListing(null, buildListingFormData());

      expect(result.success).toBe(false);
      expect(result.message).toContain("违禁词");
    });

    it("rejects inactive or missing category", async () => {
      rentalCategoryFindUnique.mockResolvedValue(null);

      const result = await createRentalListing(null, buildListingFormData());

      expect(result.success).toBe(false);
      expect(result.message).toBe("物品分类不存在或已停用");
    });

    it("rejects when owner record disappeared", async () => {
      userFindUnique.mockResolvedValue(null);

      const result = await createRentalListing(null, buildListingFormData());

      expect(result.success).toBe(false);
      expect(result.message).toBe("用户不存在");
    });

    it("returns a friendly message on unexpected errors", async () => {
      rentalListingCreate.mockRejectedValue(new Error("db down"));

      const result = await createRentalListing(null, buildListingFormData());

      expect(result.success).toBe(false);
      expect(result.message).toBeTruthy();
    });

    it("uploads new image files, replacing the url at the same index", async () => {
      const formData = buildListingFormData();
      formData.append("imageUrls", "https://example.com/keep.jpg");
      formData.append("imageFiles", new File(["x"], "new.png", { type: "image/png" }));

      await createRentalListing(null, formData);

      expect(uploadImageAsset).toHaveBeenCalledTimes(1);
      // 文件按索引替换原有 url：index 0 为新上传（token 解析为 URL），index 1 保留外链
      expect(rentalListingImageCreateMany).toHaveBeenCalledWith({
        data: [
          {
            rentalListingId: "listing-1",
            url: "http://localhost:9100/campus-public/public/rentals/user-1/new.webp",
            sortOrder: 0,
          },
          { rentalListingId: "listing-1", url: "https://example.com/keep.jpg", sortOrder: 1 },
        ],
      });
    });
  });

  describe("updateRentalListing", () => {
    it("updates the listing and replaces images in one transaction", async () => {
      const formData = buildListingFormData();
      formData.set("listingId", "listing-1");

      const result = await updateRentalListing(null, formData);

      expect(result.success).toBe(true);
      expect(result.redirectTo).toBe("/rentals/listing-1");
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(rentalListingUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "listing-1" },
          data: expect.objectContaining({ title: "佳能相机出租" }),
        }),
      );
      expect(rentalListingImageDeleteMany).toHaveBeenCalledWith({
        where: { rentalListingId: "listing-1" },
      });
      expect(rentalListingImageCreateMany).toHaveBeenCalledWith({
        data: [
          { rentalListingId: "listing-1", url: "https://example.com/a.jpg", sortOrder: 0 },
        ],
      });
    });

    it("rejects when listing id is missing", async () => {
      const result = await updateRentalListing(null, buildListingFormData());

      expect(result.success).toBe(false);
      expect(result.message).toBe("物品不存在");
    });

    it("rejects when the listing does not belong to the user", async () => {
      rentalListingFindFirst.mockResolvedValue(null);
      const formData = buildListingFormData();
      formData.set("listingId", "listing-2");

      const result = await updateRentalListing(null, formData);

      expect(result.success).toBe(false);
      expect(result.message).toBe("无权修改该物品");
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("returns friendly message when transaction fails", async () => {
      transactionMock.mockRejectedValue(new Error("tx failed"));
      const formData = buildListingFormData();
      formData.set("listingId", "listing-1");

      const result = await updateRentalListing(null, formData);

      expect(result.success).toBe(false);
    });
  });

  describe("updateRentalListingStatus", () => {
    it("updates an owned listing to a valid status", async () => {
      const formData = new FormData();
      formData.set("listingId", "listing-1");
      formData.set("status", "PAUSED");

      await updateRentalListingStatus(formData);

      expect(rentalListingUpdate).toHaveBeenCalledWith({
        where: { id: "listing-1" },
        data: { status: "PAUSED" },
      });
    });

    it("ignores invalid statuses", async () => {
      const formData = new FormData();
      formData.set("listingId", "listing-1");
      formData.set("status", "BANNED");

      await updateRentalListingStatus(formData);

      expect(rentalListingUpdate).not.toHaveBeenCalled();
    });

    it("skips listings owned by others or in locked states", async () => {
      rentalListingFindFirst.mockResolvedValue(null);
      const formData = new FormData();
      formData.set("listingId", "listing-1");
      formData.set("status", "PAUSED");

      await updateRentalListingStatus(formData);
      expect(rentalListingUpdate).not.toHaveBeenCalled();

      rentalListingFindFirst.mockResolvedValue({ id: "listing-1", status: "BANNED" });
      await updateRentalListingStatus(formData);
      expect(rentalListingUpdate).not.toHaveBeenCalled();
    });
  });

  describe("deleteRentalListing", () => {
    it("soft-deletes a listing without active orders and redirects", async () => {
      const formData = new FormData();
      formData.set("listingId", "listing-1");

      await deleteRentalListing(formData);

      expect(rentalListingUpdate).toHaveBeenCalledWith({
        where: { id: "listing-1" },
        data: { deletedAt: expect.any(Date), status: "OFFLINE" },
      });
      expect(redirect).toHaveBeenCalledWith("/my/rental-listings");
    });

    it("keeps the listing when active orders exist", async () => {
      rentalOrderCount.mockResolvedValue(2);
      const formData = new FormData();
      formData.set("listingId", "listing-1");

      await deleteRentalListing(formData);

      expect(rentalListingUpdate).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    });

    it("redirects when the listing is not found or not owned", async () => {
      rentalListingFindFirst.mockResolvedValue(null);
      const formData = new FormData();
      formData.set("listingId", "listing-x");

      await deleteRentalListing(formData);

      expect(redirect).toHaveBeenCalledWith("/my/rental-listings");
    });
  });
});

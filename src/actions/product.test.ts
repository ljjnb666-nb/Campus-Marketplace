import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirect,
  revalidatePath,
  requireUser,
  containsBannedKeyword,
  uploadImageAsset,
  resolveImageTokens,
  markAssetsForValuesPendingDelete,
  userFindUnique,
  productCategoryFindUnique,
  productFindFirst,
  productCreate,
  productUpdate,
  productImageFindMany,
  productImageDeleteMany,
  productImageCreateMany,
  favoriteDeleteMany,
  favoriteCreate,
  transactionMock,
} = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => {
    throw new Error(`REDIRECT:${location}`);
  }),
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  containsBannedKeyword: vi.fn(),
  uploadImageAsset: vi.fn(),
  resolveImageTokens: vi.fn(),
  markAssetsForValuesPendingDelete: vi.fn(),
  userFindUnique: vi.fn(),
  productCategoryFindUnique: vi.fn(),
  productFindFirst: vi.fn(),
  productCreate: vi.fn(),
  productUpdate: vi.fn(),
  productImageFindMany: vi.fn(),
  productImageDeleteMany: vi.fn(),
  productImageCreateMany: vi.fn(),
  favoriteDeleteMany: vi.fn(),
  favoriteCreate: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("next/navigation", () => ({
  redirect,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/moderation", () => ({
  containsBannedKeyword,
}));

vi.mock("@/lib/upload", () => ({
  buildAssetReference: (assetId: string) => `asset:${assetId}`,
  uploadImageAsset,
  resolveImageTokens,
  markAssetsForValuesPendingDelete,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    productCategory: {
      findUnique: productCategoryFindUnique,
    },
    product: {
      create: productCreate,
      update: productUpdate,
      findFirst: productFindFirst,
    },
    productImage: {
      findMany: productImageFindMany,
      deleteMany: productImageDeleteMany,
      createMany: productImageCreateMany,
    },
    favorite: {
      deleteMany: favoriteDeleteMany,
      create: favoriteCreate,
    },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import {
  createProduct,
  deleteProduct,
  toggleFavorite,
  updateProduct,
  updateProductStatus,
} from "@/actions/product";

function buildValidProductFormData() {
  const formData = new FormData();
  formData.set("title", "九成新概率论教材");
  formData.set("description", "书页干净无笔记，支持校内当面交易。");
  formData.set("price", "25");
  formData.set("originalPrice", "48");
  formData.set("categoryId", "category-1");
  formData.set("condition", "LIKE_NEW");
  formData.set("locationText", "图书馆门口");
  formData.append("imageUrls", "https://example.com/textbook.jpg");

  return formData;
}

describe("product actions", () => {
  beforeEach(() => {
    redirect.mockClear();
    revalidatePath.mockReset();
    requireUser.mockReset();
    containsBannedKeyword.mockReset();
    uploadImageAsset.mockReset();
    resolveImageTokens.mockReset();
    markAssetsForValuesPendingDelete.mockReset().mockResolvedValue(0);
    userFindUnique.mockReset();
    productCategoryFindUnique.mockReset();
    productFindFirst.mockReset();
    productCreate.mockReset();
    productUpdate.mockReset();
    productImageFindMany.mockReset().mockResolvedValue([]);
    productImageDeleteMany.mockReset();
    productImageCreateMany.mockReset();
    favoriteDeleteMany.mockReset();
    favoriteCreate.mockReset();
    transactionMock.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    containsBannedKeyword.mockResolvedValue(null);
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-1",
      access: "PUBLIC",
      url: "http://localhost:9100/campus-public/public/products/user-1/photo.webp",
      mimeType: "image/webp",
      sizeBytes: 2048,
    });
    // token 解析 mock：asset 引用 → 公开 URL；其余（外链/历史路径）透传
    resolveImageTokens.mockImplementation(async ({ tokens }: { tokens: string[] }) =>
      tokens.map((token) =>
        token === "asset:asset-1"
          ? "http://localhost:9100/campus-public/public/products/user-1/photo.webp"
          : token,
      ),
    );
    userFindUnique.mockResolvedValue({ campusId: "campus-1" });
    productCreate.mockResolvedValue({ id: "product-1" });
    favoriteDeleteMany.mockResolvedValue({ count: 0 });
    favoriteCreate.mockResolvedValue({ id: "favorite-1" });
    productUpdate.mockResolvedValue({});
    // 数组形式照旧返回空数组；事务回调形式传入共享的 mock 委托
    transactionMock.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return arg({
          favorite: { deleteMany: favoriteDeleteMany, create: favoriteCreate },
          product: { update: productUpdate, create: productCreate },
          productImage: {
            deleteMany: productImageDeleteMany,
            createMany: productImageCreateMany,
          },
        });
      }
      return [];
    });
  });

  it("rejects product creation when the selected category is inactive", async () => {
    productCategoryFindUnique.mockResolvedValue({
      id: "category-1",
      isActive: false,
    });

    const result = await createProduct(
      { success: false, message: "" },
      buildValidProductFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "商品分类不存在或已停用",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("uses uploaded files in place of image urls when creating products", async () => {
    productCategoryFindUnique.mockResolvedValue({
      id: "category-1",
      isActive: true,
    });

    const formData = buildValidProductFormData();
    formData.delete("imageUrls");
    formData.append("imageUrls", "");
    formData.append("imageFiles", new File(["binary"], "product.png", { type: "image/png" }));

    await createProduct({ success: false, message: "" }, formData);

    expect(uploadImageAsset).toHaveBeenCalledWith({
      userId: "user-1",
      category: "product",
      file: expect.any(File),
    });
    // 上传 token 在事务内解析为公开 URL 后才写入 ProductImage
    expect(resolveImageTokens).toHaveBeenCalledWith({
      ownerId: "user-1",
      tokens: ["asset:asset-1"],
      target: { type: "product", id: "product-1" },
      tx: expect.anything(),
    });
    expect(productImageCreateMany).toHaveBeenCalledWith({
      data: [
        {
          productId: "product-1",
          url: "http://localhost:9100/campus-public/public/products/user-1/photo.webp",
          sortOrder: 0,
        },
      ],
    });
  });

  it("rejects product update when the selected category is inactive", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1" });
    productCategoryFindUnique.mockResolvedValue({
      id: "category-1",
      isActive: false,
    });

    const formData = buildValidProductFormData();
    formData.set("productId", "product-1");

    const result = await updateProduct({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "商品分类不存在或已停用",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("soft deletes the owner's product and marks its images for deletion", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1" });
    productImageFindMany.mockResolvedValue([
      { url: "http://localhost:9100/campus-public/public/products/user-1/photo.webp" },
    ]);

    const formData = new FormData();
    formData.set("productId", "product-1");

    await expect(deleteProduct(formData)).rejects.toThrow("REDIRECT:/my/products");

    expect(productUpdate).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: {
        status: "OFFLINE",
        deletedAt: expect.any(Date),
      },
    });
    // 软删除时图片资源标记待删除，由 cleanup 异步物理清理
    expect(markAssetsForValuesPendingDelete).toHaveBeenCalledWith("user-1", [
      "http://localhost:9100/campus-public/public/products/user-1/photo.webp",
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
    expect(revalidatePath).toHaveBeenCalledWith("/my/products");
  });

  it("does not delete products owned by other users", async () => {
    productFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("productId", "product-1");

    await expect(deleteProduct(formData)).rejects.toThrow("REDIRECT:/my/products");

    expect(productUpdate).not.toHaveBeenCalled();
  });

  describe("toggleFavorite", () => {
    function buildFavoriteFormData(productId = "product-1") {
      const formData = new FormData();
      formData.set("productId", productId);
      return formData;
    }

    it("adds a favorite for the session user inside one transaction", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1" });
      favoriteDeleteMany.mockResolvedValue({ count: 0 });

      await toggleFavorite(buildFavoriteFormData());

      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(favoriteDeleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1", productId: "product-1" },
      });
      expect(favoriteCreate).toHaveBeenCalledWith({
        data: { userId: "user-1", productId: "product-1" },
      });
      expect(productUpdate).toHaveBeenCalledWith({
        where: { id: "product-1" },
        data: { favoriteCount: { increment: 1 } },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
    });

    it("removes an existing favorite and only decrements once", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1" });
      favoriteDeleteMany.mockResolvedValue({ count: 1 });

      await toggleFavorite(buildFavoriteFormData());

      expect(productUpdate).toHaveBeenCalledWith({
        where: { id: "product-1" },
        data: { favoriteCount: { decrement: 1 } },
      });
      expect(productUpdate).toHaveBeenCalledTimes(1);
      expect(favoriteCreate).not.toHaveBeenCalled();
    });

    it("treats a concurrent create that loses the unique constraint race as idempotent", async () => {
      // 竞态模拟：另一个并发请求刚刚创建了收藏行
      productFindFirst.mockResolvedValue({ id: "product-1" });
      favoriteDeleteMany.mockResolvedValue({ count: 0 });
      favoriteCreate.mockRejectedValue(
        Object.assign(
          new Error("Unique constraint failed on the fields: (`userId`,`productId`)"),
          { code: "P2002" },
        ),
      );

      await expect(
        toggleFavorite(buildFavoriteFormData()),
      ).resolves.toBeUndefined();

      // create 失败时绝不能增减计数器，否则 favoriteCount 漂移
      expect(productUpdate).not.toHaveBeenCalled();
    });

    it("does nothing when the product does not exist", async () => {
      productFindFirst.mockResolvedValue(null);

      await toggleFavorite(buildFavoriteFormData());

      expect(favoriteDeleteMany).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("does nothing when the product id is missing", async () => {
      await toggleFavorite(new FormData());

      expect(productFindFirst).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });

  describe("createProduct 补充分支", () => {
    it("creates a product with campus scope and image ordering", async () => {
      productCategoryFindUnique.mockResolvedValue({ id: "category-1", isActive: true });

      const result = await createProduct(null, buildValidProductFormData());

      expect(result).toEqual({
        success: true,
        message: "商品发布成功",
        redirectTo: "/products/product-1",
      });
      expect(productCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: "九成新概率论教材",
          campusId: "campus-1",
          sellerId: "user-1",
          originalPrice: expect.anything(),
        }),
      });
      // 图片行在 token 解析后单独写入，保持顺序
      expect(productImageCreateMany).toHaveBeenCalledWith({
        data: [
          { productId: "product-1", url: "https://example.com/textbook.jpg", sortOrder: 0 },
        ],
      });
      expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
    });

    it("rejects creation that hits a banned keyword", async () => {
      containsBannedKeyword.mockResolvedValue("代考");

      const result = await createProduct(null, buildValidProductFormData());

      expect(result.success).toBe(false);
      expect(result.message).toContain("代考");
      expect(productCreate).not.toHaveBeenCalled();
    });

    it("rejects creation with invalid form data", async () => {
      const formData = buildValidProductFormData();
      formData.set("price", "abc");

      const result = await createProduct(null, formData);

      expect(result.success).toBe(false);
      expect(containsBannedKeyword).not.toHaveBeenCalled();
    });

    it("rejects creation when the seller record is missing", async () => {
      userFindUnique.mockResolvedValue(null);

      const result = await createProduct(null, buildValidProductFormData());

      expect(result).toEqual({ success: false, message: "用户不存在" });
    });

    it("returns a friendly message when creation throws", async () => {
      productCategoryFindUnique.mockResolvedValue({ id: "category-1", isActive: true });
      productCreate.mockRejectedValue(new Error("db down"));

      const result = await createProduct(null, buildValidProductFormData());

      expect(result.success).toBe(false);
      expect(result.message).toBeTruthy();
    });
  });

  describe("updateProduct 补充分支", () => {
    it("updates an owned product and replaces images in one transaction", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1" });
      productCategoryFindUnique.mockResolvedValue({ id: "category-1", isActive: true });
      productImageFindMany.mockResolvedValue([
        { url: "https://example.com/textbook.jpg" },
        { url: "https://example.com/removed.jpg" },
      ]);

      const formData = buildValidProductFormData();
      formData.set("productId", "product-1");

      const result = await updateProduct(null, formData);

      expect(result.success).toBe(true);
      expect(result.redirectTo).toBe("/products/product-1");
      expect(productUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "product-1" },
          data: expect.objectContaining({ title: "九成新概率论教材" }),
        }),
      );
      expect(productImageDeleteMany).toHaveBeenCalledWith({
        where: { productId: "product-1" },
      });
      expect(productImageCreateMany).toHaveBeenCalledWith({
        data: [
          { productId: "product-1", url: "https://example.com/textbook.jpg", sortOrder: 0 },
        ],
      });
      // 被移除的旧图标记待删除
      expect(markAssetsForValuesPendingDelete).toHaveBeenCalledWith("user-1", [
        "https://example.com/removed.jpg",
      ]);
    });

    it("rejects updates without a product id", async () => {
      const result = await updateProduct(null, buildValidProductFormData());

      expect(result.success).toBe(false);
    });

    it("rejects updates for products owned by others", async () => {
      productFindFirst.mockResolvedValue(null);
      productCategoryFindUnique.mockResolvedValue({ id: "category-1", isActive: true });

      const formData = buildValidProductFormData();
      formData.set("productId", "product-2");

      const result = await updateProduct(null, formData);

      expect(result.success).toBe(false);
      expect(productUpdate).not.toHaveBeenCalled();
    });

    it("rejects updates with invalid form data", async () => {
      const formData = buildValidProductFormData();
      formData.set("title", "短");
      formData.set("productId", "product-1");

      const result = await updateProduct(null, formData);

      expect(result.success).toBe(false);
      expect(productFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("updateProductStatus", () => {
    function statusFormData(status: string) {
      const formData = new FormData();
      formData.set("productId", "product-1");
      formData.set("status", status);
      return formData;
    }

    it("updates the status of an owned product", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1" });

      await updateProductStatus(statusFormData("OFFLINE"));

      expect(productUpdate).toHaveBeenCalledWith({
        where: { id: "product-1" },
        data: { status: "OFFLINE" },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
    });

    it("ignores invalid statuses", async () => {
      await updateProductStatus(statusFormData("BANNED"));

      expect(productFindFirst).not.toHaveBeenCalled();
    });

    it("ignores products owned by others", async () => {
      productFindFirst.mockResolvedValue(null);

      await updateProductStatus(statusFormData("OFFLINE"));

      expect(productUpdate).not.toHaveBeenCalled();
    });
  });

  describe("deleteProduct 补充分支", () => {
    it("redirects when deleting without a product id", async () => {
      await expect(deleteProduct(new FormData())).rejects.toThrow("REDIRECT:/my/products");

      expect(productFindFirst).not.toHaveBeenCalled();
    });
  });
});
